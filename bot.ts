import { Bot } from "grammy";
import { botToken } from "./config";
import { getFyFeed, getCastWithReplies, getCastReplies, getCastConversation, getCastByHash, getUserNotifications } from "./utils/fc/config";
import { db, redis } from "./utils/db/redis";
import { createSignedKey, getSignerUUID, verifySignerStatus, checkSigner, resetSigner } from './utils/fc/signer';
import neynarClient from "./utils/fc/neynarClient";

const bot = new Bot(botToken);

// Update our user tracking to include signer info
interface UserInfo {
    fid: number;
    signerUuid?: string;
    signerStatus?: 'generated' | 'pending_approval' | 'approved' | 'revoked';
}

type CastAction = 'like' | 'recast' | 'reply';

// Filter out messages from the future or too old
bot.use((ctx, next) => {
    if (!ctx.message) return next();
    
    const now = Math.floor(Date.now() / 1000);
    if (ctx.message.date > now) {
        console.log("Ignoring future message");
    }
    return next();
});

/**@dev Log every single update before any processing */
bot.use(async (ctx, next) => {
    console.log("Raw update received:", JSON.stringify(ctx.update, null, 2));
    await next();
});

// Modify sendCast to include inline keyboard and media embeds
async function sendCast(ctx: any, cast: any) {
    const text = cast.text;
    const author = cast.author;
    const castMedia = cast.embeds?.[0]; // Get the first embed if available
    const displayName = author.display_name || author.username;
    const pfp_url = author.pfp_url;
    
    let message = `<b>${displayName}</b>`;
    message += `\n━━━━━━━━━━\n\n`;
    message += `${text}\n\n`;
    
    const timestamp = new Date(cast.timestamp).toLocaleTimeString();
    const likes = Array.isArray(cast.reactions?.likes) ? cast.reactions.likes.length : cast.reactions.likes || 0;
    const recasts = Array.isArray(cast.reactions?.recasts) ? cast.reactions.recasts.length : cast.reactions.recasts || 0;
    
    message += `${timestamp} • ❤️ ${likes} • 🔄 ${recasts}`;
    if (cast.replies?.count) {
        message += ` • 💬 ${cast.replies.count}`;
    }

    // Add inline keyboard with action buttons
    const keyboard = {
        inline_keyboard: [[
            { text: "❤️ Like", callback_data: `like:${cast.hash}` },
            { text: "🔄 Recast", callback_data: `recast:${cast.hash}` },
            { text: "💬 Reply", callback_data: `reply:${cast.hash}` }
        ]]
    };

    try {
        // Check if there's a media embed
        if (castMedia) {
            console.log("Cast has media:", castMedia);
            
            // Handle image embeds
            if (castMedia.url && (castMedia.url.endsWith('.jpg') || castMedia.url.endsWith('.jpeg') || 
                                  castMedia.url.endsWith('.png') || castMedia.url.endsWith('.gif'))) {
                await ctx.replyWithPhoto(castMedia.url, {
                    caption: message,
                    parse_mode: "HTML",
                    reply_markup: keyboard
                });
                return;
            }
            
            // Handle video embeds - Telegram supports MP4 files
            if (castMedia.url && (castMedia.url.endsWith('.mp4') || castMedia.url.endsWith('.mov'))) {
                await ctx.replyWithVideo(castMedia.url, {
                    caption: message,
                    parse_mode: "HTML",
                    reply_markup: keyboard
                });
                return;
            }
            
            // For other types of embeds (URLs, etc.), add the URL to the message
            if (castMedia.url) {
                message += `\n\n<a href="${castMedia.url}">View attached content</a>`;
            }
        }
        
        // Default case: use profile picture
        if (pfp_url) {
            try {
                await ctx.replyWithPhoto(pfp_url, {
                    caption: message,
                    parse_mode: "HTML",
                    width: 100,
                    height: 100,
                    reply_markup: keyboard
                });
            } catch (e) {
                console.error("Failed to send with profile photo:", e);
                await ctx.reply(message, { 
                    parse_mode: "HTML",
                    reply_markup: keyboard
                });
            }
        } else {
            await ctx.reply(message, { 
                parse_mode: "HTML",
                reply_markup: keyboard
            });
        }
    } catch (error) {
        console.error("Error sending cast with media:", error);
        // Fallback to simple text message
        await ctx.reply(message, { 
            parse_mode: "HTML",
            reply_markup: keyboard
        });
    }
}

// Find the existing callback query handler and update it to handle both "load_more" and "notifications" actions
bot.on("callback_query", async (ctx) => {
    try {
        const callbackData = ctx.callbackQuery?.data;
        if (!callbackData) return;
        
        // Handle notifications pagination
        if (callbackData.startsWith('notif:')) {
            const shortId = callbackData.split(':')[1];
            // Get the actual cursor from Redis
            const cursor = await redis.get(`cursor:${shortId}`);
            if (!cursor) {
                await ctx.reply("This notification link has expired. Please run /notifications again.");
                return;
            }
            
            // After using the cursor, we can clean up
            await redis.del(`cursor:${shortId}`);
            
            await ctx.answerCallbackQuery("Loading more notifications...");
            
            const user = await db.getUser(ctx.from?.id || 0);
            if (!user?.fid) {
                await ctx.reply("No FID found. Please set up your account first with /start");
                return;
            }
            
            // Get the notification types filter from Redis
            let notificationTypes: string[] = ['follows', 'recasts', 'likes', 'mentions', 'replies', 'quotes'];
            const typesJson = await redis.get(`user:${ctx.from?.id}:notifications_types`);
            if (typesJson) {
                try {
                    notificationTypes = JSON.parse(typesJson);
                } catch (e) {
                    console.error("Error parsing notification types:", e);
                }
            }
            
            // Fetch the next page of notifications with the same types
            const notifications = await getUserNotifications(user.fid, cursor, notificationTypes);
            
            if (!notifications.notifications || notifications.notifications.length === 0) {
                await ctx.reply("No more notifications found.");
                return;
            }
            
            await ctx.reply("📱 More notifications:");
            
            // Process and display the notifications by type
            for (const notification of notifications.notifications) {
                // Display header based on notification type
                let headerText = "";
                switch (notification.type) {
                    case "follows":
                        headerText = "👥 New follower" + (notification.follows?.length > 1 ? "s" : "");
                        break;
                    case "cast-mention":
                    case "mentions":
                        headerText = "🔄 You were mentioned in a cast";
                        break;
                    case "likes":
                        headerText = "❤️ Your cast received like" + (notification.count > 1 ? "s" : "");
                        break;
                    case "recasts":
                        headerText = "🔄 Your cast was recasted";
                        break;
                    case "replies":
                        headerText = "💬 New repl" + (notification.count > 1 ? "ies" : "y") + " to your cast";
                        break;
                    case "quotes":
                        headerText = "💬 Your cast was quoted";
                        break;
                    default:
                        headerText = "📢 New notification";
                }
                
                await ctx.reply(`${headerText} • ${new Date(notification.most_recent_timestamp).toLocaleString()}`);
                
                // Handle different notification types
                if (notification.type === "follows" && notification.follows) {
                    // Display followers
                    for (const follower of notification.follows) {
                        if (follower.user) {
                            const displayName = follower.user.display_name || follower.user.username;
                            const username = follower.user.username;
                            const pfpUrl = follower.user.pfp_url;
                            
                            let message = `<b>${displayName}</b> (@${username}) started following you`;
                            
                            // If we have a profile pic, display it
                            if (pfpUrl) {
                                try {
                                    await ctx.replyWithPhoto(pfpUrl, {
                                        caption: message,
                                        parse_mode: "HTML"
                                    });
                                } catch (e) {
                                    console.error("Failed to send with profile photo:", e);
                                    await ctx.reply(message, { parse_mode: "HTML" });
                                }
                            } else {
                                await ctx.reply(message, { parse_mode: "HTML" });
                            }
                        }
                    }
                } else if (notification.cast) {
                    // For cast-related notifications (mentions, quotes, etc.), display the cast
                    await sendCast(ctx, notification.cast);
                } else if (notification.reactions && notification.reactions.length > 0) {
                    // For reaction notifications, show who reacted and the cast
                    for (const reaction of notification.reactions) {
                        if (reaction.user) {
                            const displayName = reaction.user.display_name || reaction.user.username;
                            await ctx.reply(`${displayName} reacted to your cast`);
                        }
                        
                        // If we have the cast that was reacted to, show it
                        if (reaction.cast) {
                            // Fetch the full cast details
                            const fullCast = await getCastByHash(reaction.cast.hash);
                            if (fullCast) {
                                await sendCast(ctx, fullCast);
                            }
                        }
                    }
                }
            }
            
            // If there's a next page of notifications
            if (notifications.next?.cursor) {
                // Store the notification types along with the cursor
                await redis.set(`user:${ctx.from?.id}:notifications_types`, JSON.stringify(notificationTypes));
                
                // Generate a short random ID to use as a reference
                const shortId = Math.random().toString(36).substring(2, 10); // 8 char random string
                await redis.set(`cursor:${shortId}`, notifications.next.cursor);
                
                await ctx.reply("Want to see more notifications?", {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: "Load More Notifications", callback_data: `notif:${shortId}` }
                        ]]
                    }
                });
                
                // Store the cursor in Redis (keeping this for backward compatibility)
                await redis.set(`user:${ctx.from?.id}:notifications_cursor`, notifications.next.cursor);
            }
        }
        
        // Handle the load_more action
        if (callbackData.startsWith('load_more:')) {
            const cursor = callbackData.split(':')[1];
            await ctx.answerCallbackQuery("Loading more casts...");
            
            const user = await db.getUser(ctx.from?.id || 0);
            if (!user?.fid) {
                await ctx.reply("No FID found. Please set up your account first with /start");
                return;
            }
            
            // Fetch the next page of feed
            const feedResult = await getFyFeed(user.fid, cursor);
            const casts = feedResult.casts;
            
            if (!casts || casts.length === 0) {
                await ctx.reply("No more casts found.");
                return;
            }
            
            await ctx.reply("📱 More casts from your feed:");
            
            // Send each cast
            for (const cast of casts) {
                await sendCast(ctx, cast);
            }
            
            // If there's still more, add another "Load More" button
            if (feedResult.nextCursor) {
                await ctx.reply("Want to see more casts?", {
                    reply_markup: {
                        inline_keyboard: [[
                            { text: "Load More ⬇️", callback_data: `load_more:${feedResult.nextCursor}` }
                        ]]
                    }
                });
                
                // Update the cursor in Redis
                await redis.set(`user:${ctx.from.id}:feed_cursor`, feedResult.nextCursor);
            } else {
                await ctx.reply("You've reached the end of your feed!");
            }
            return;
        }
        
        // Handle existing cast actions (like, recast, reply)
        const [action, castHash] = callbackData.split(':') as [CastAction, string];
        const user = await db.getUser(ctx.from?.id || 0);
        
        if (!user?.signerUuid || user.signerStatus !== 'approved') {
            await ctx.answerCallbackQuery("You need an approved signer first. Use /start to set one up.");
            return;
        }

        switch (action) {
            case 'like':
                await neynarClient.publishReaction({
                    signerUuid: user.signerUuid,
                    reactionType: 'like',
                    target: castHash
                });
                await ctx.answerCallbackQuery("Cast liked! ❤️");
                break;

            case 'recast':
                await neynarClient.publishReaction({
                    signerUuid: user.signerUuid,
                    reactionType: 'recast',
                    target: castHash
                });
                await ctx.answerCallbackQuery("Cast recasted! 🔄");
                break;

            case 'reply':
                // Store the cast hash in Redis for the reply
                await redis.set(`user:${ctx.from.id}:replying_to`, castHash);
                await ctx.answerCallbackQuery("Send your reply as a message!");
                await ctx.reply("Reply to this cast with your message:", {
                    reply_markup: {
                        force_reply: true
                    }
                });
                break;
        }
    } catch (error) {
        console.error("Error handling callback query:", error);
        await ctx.answerCallbackQuery("Sorry, something went wrong!");
    }
});


bot.command("start", async (ctx) => {
    console.log("/start received");
    await ctx.reply("Welcome! Please send your Farcaster FID (numbers only) to get started.");
});

bot.command("feed", async (ctx) => {
    console.log("/feed command received");
    try {
        const user = await db.getUser(ctx.from?.id || 0);
        console.log("User from DB:", user);

        if (!user?.fid) {
            console.log("No FID found for user");
            await ctx.reply("No FID found. Please set up your account first with /start");
            return;
        }

        await ctx.reply("Fetching your For You feed...");
        console.log("Fetching feed for FID:", user.fid);
        
        // Get the feed with pagination info
        const feedResult = await getFyFeed(user.fid);
        const casts = feedResult.casts;
        console.log("Got casts:", casts?.length);
        
        if (!casts || casts.length === 0) {
            console.log("No casts found");
            await ctx.reply("No casts found in your feed.");
            return;
        }

        await ctx.reply("🔄 Latest casts from your feed:");
        
        // Send each cast
        for (const cast of casts) {
            await sendCast(ctx, cast);
        }
        
        // If there's a next page, add a "Load More" button
        if (feedResult.nextCursor) {
            await ctx.reply("Want to see more casts?", {
                reply_markup: {
                    inline_keyboard: [[
                        { text: "Load More ⬇️", callback_data: `load_more:${feedResult.nextCursor}` }
                    ]]
                }
            });
            
            // Store the cursor in Redis for this user (in case they want to use /more command)
            await redis.set(`user:${ctx.from?.id}:feed_cursor`, feedResult.nextCursor);
        } else {
            await ctx.reply("You've reached the end of your feed!");
        }
    } catch (error) {
        console.error("Error in feed command:", error);
        await ctx.reply("Sorry, something went wrong while fetching your feed.");
    }
});

bot.command("cast", async (ctx) => {
    console.log("/cast command received");
    try {
        const user = await db.getUser(ctx.from?.id || 0);
        if (!user?.signerUuid || user.signerStatus !== 'approved') {
            await ctx.reply("You need an approved signer first. Use /start to set one up.");
            return;
        }

        const text = ctx.message?.text?.slice(6).trim();
        if (!text) {
            await ctx.reply("Please include your cast text after /cast\nExample: /cast Hello Farcaster!");
            return;
        }

        // Check if this is a reply to a message with a photo
        let imageUrl;
        if (ctx.message?.reply_to_message?.photo) {
            const photos = ctx.message.reply_to_message.photo;
            // Get the largest photo (last in array)
            const fileId = photos[photos.length - 1].file_id;
            
            await ctx.reply("Uploading image...");
            try {
                // Import the image upload function
                const { uploadImageFromTelegram } = await import('./utils/ut/ut');
                imageUrl = await uploadImageFromTelegram(fileId);
            } catch (error) {
                console.error("Error uploading image:", error);
                await ctx.reply("Failed to upload the image, publishing text only.");
            }
        }

        await ctx.reply("Publishing your cast...");
        
        // Prepare the cast parameters
        const castParams: any = {
            signerUuid: user.signerUuid,
            text: text
        };
        
        // Add image embed if available
        if (imageUrl) {
            castParams.embeds = [{
                url: imageUrl
            }];
        }

        // Publish the cast
        const cast = await neynarClient.publishCast(castParams);

        // Store the cast hash in Redis with timestamp and image URL if available
        const castData: any = {
            text: text,
            timestamp: Date.now()
        };
        
        if (imageUrl) {
            castData.imageUrl = imageUrl;
        }
        
        await redis.set(`user:${ctx.from?.id}:cast:${cast.cast.hash}`, JSON.stringify(castData));
        
        if (imageUrl) {
            await ctx.reply("✅ Cast with image published successfully!");
        } else {
            await ctx.reply("✅ Cast published successfully!");
        }
    } catch (error) {
        console.error("Error publishing cast:", error);
        await ctx.reply("Sorry, something went wrong while publishing your cast.");
    }
});

bot.command("check_approval", async (ctx) => {
    try {
        const signerUUID = await getSignerUUID(ctx.from?.id || 0);
        if (!signerUUID) {
            await ctx.reply("You haven't started the connection process yet. Please use /start first.");
            return;
        }

        const status = await verifySignerStatus(signerUUID);
        if (status === 'approved') {
            await ctx.reply("Your connection is approved! You can use the bot now.");
        } else {
            await ctx.reply("Your connection isn't approved yet. Please approve in Warpcast and try again.");
        }
    } catch (error) {
        console.error("Error checking approval:", error);
        await ctx.reply("Sorry, something went wrong while checking your approval status.");
    }
});

bot.command("update_signer", async (ctx) => {
    console.log("update_signer command received");
    try {
        const user = await db.getUser(ctx.from?.id || 0);
        if (!user?.signerUuid) {
            await ctx.reply("No signer found. Please use /start to set up a new signer.");
            return;
        }

        await ctx.reply("Updating signer information in database...");
        
        // Get current status from Neynar
        const signer = await neynarClient.lookupSigner({ 
            signerUuid: user.signerUuid 
        });
        
        // Update the status in the database
        await db.updateSignerStatus(ctx.from?.id || 0, signer.status);
        
        await ctx.reply("✅ Updated database with current signer status!");
        
        const saved = await db.getUser(ctx.from?.id || 0);
        await ctx.reply(
            `Current database record:\n` +
            `FID: ${saved?.fid}\n` +
            `Signer UUID: ${saved?.signerUuid}\n` +
            `Status: ${saved?.signerStatus}`
        );
    } catch (error) {
        console.error("Error updating signer:", error);
        await ctx.reply("Sorry, something went wrong while updating the database.");
    }
});

bot.command("check_signer", async (ctx) => {
    try {
        const user = await db.getUser(ctx.from?.id || 0);
        if (!user?.signerUuid) {
            await ctx.reply("No signer found. Please use /start to set up a new signer.");
            return;
        }

        await ctx.reply("Checking existing signer...");
        
        const signer = await checkSigner(user.signerUuid);
        
        // Update database if status has changed
        if (user.signerStatus !== signer.status) {
            await db.updateSignerStatus(ctx.from?.id || 0, signer.status);
        }
        
        await ctx.reply(`Signer status: ${signer.status}`);
    } catch (error) {
        console.error("Error checking signer:", error);
        await ctx.reply("Sorry, something went wrong while checking the signer.");
    }
});

bot.command("list_signers", async (ctx) => {
    console.log("/list_signers received");
    await ctx.reply("Checking database for signers...");
    
    try {
        const users = await db.getAllUsers();
        console.log("Found users:", users);
        
        if (users.length === 0) {
            await ctx.reply("No users or signers found in the database.");
            return;
        }
        
        for (const user of users) {
            let statusMessage = `📝 Database Record:\n` +
                              `Chat ID: ${user.chatId}\n` +
                              `FID: ${user.fid || 'Not set'}\n` +
                              `Signer UUID: ${user.signerUuid}\n` +
                              `Stored Status: ${user.signerStatus}`;
            
            try {
                if (user.signerUuid) {
                    const signer = await neynarClient.lookupSigner({ 
                        signerUuid: user.signerUuid 
                    });
                    statusMessage += `\n\n🔄 Current Neynar Status:\n` +
                                   `Status: ${signer.status}\n` +
                                   `Public Key: ${signer.public_key}`;
                }
            } catch (error) {
                statusMessage += '\n\n❌ Failed to fetch current status from Neynar';
                console.error("Error fetching signer status:", error);
            }
            
            await ctx.reply(statusMessage);
        }
    } catch (error) {
        console.error("Error listing signers:", error);
        await ctx.reply("Sorry, something went wrong while checking the database.");
    }
});

bot.command("check_approved_signer", async (ctx) => {
    console.log("check_approved_signer command received");
    try {
        const user = await db.getUser(ctx.from?.id || 0);
        if (!user?.signerUuid) {
            await ctx.reply("No signer found. Please use /start to set up a new signer.");
            return;
        }

        await ctx.reply("Checking your signer...");
        console.log("Sending lookup request for signer");
        const signer = await neynarClient.lookupSigner({ 
            signerUuid: user.signerUuid
        });
        console.log("Got signer response:", signer);
        
        // Update the status in the database if it has changed
        if (user.signerStatus !== signer.status) {
            await db.updateSignerStatus(ctx.from?.id || 0, signer.status);
        }
        
        await ctx.reply(
            `Signer status:\n` +
            `Status: ${signer.status}\n` +
            `Public Key: ${signer.public_key}`
        );
    } catch (error) {
        console.error("Error checking signer:", error);
        await ctx.reply("Sorry, something went wrong while checking the signer.");
    }
});

bot.command("get_approval_link", async (ctx) => {
    try {
        const user = await db.getUser(ctx.from?.id || 0);
        if (!user?.signerUuid) {
            await ctx.reply("No signer found. Please use /start to set up a new signer.");
            return;
        }

        const signer = await neynarClient.lookupSigner({ 
            signerUuid: user.signerUuid /**@dev Replace with your signer UUID */
        });

        if (signer.status === 'approved') {
            await ctx.reply("Your signer is already approved! No need for approval link.");
            return;
        }

        await db.updateSignerStatus(ctx.from?.id || 0, signer.status);

        if (signer.signer_approval_url) {
            await ctx.reply("Please approve this signer in Warpcast:");
            await ctx.reply(signer.signer_approval_url);
        } else {
            await ctx.reply("Sorry, couldn't get the approval URL. You might need to create a new signer with /start");
        }
    } catch (error) {
        console.error("Error getting approval link:", error);
        await ctx.reply("Sorry, something went wrong while getting the approval link.");
    }
});

bot.command("notifications", async (ctx) => {
    console.log("/notifications command received from", ctx.from?.id);
    try {
        const user = await db.getUser(ctx.from?.id || 0);
        if (!user?.fid) {
            await ctx.reply("No FID found. Please set up your account first with /start");
            return;
        }

        if (!user?.signerUuid || user.signerStatus !== 'approved') {
            await ctx.reply("You need an approved signer first. Use /start to set one up.");
            return;
        }

        // Extract filter types from command if provided
        // Example: /notifications mentions,replies
        let notificationTypes: string[] = ['follows', 'recasts', 'likes', 'mentions', 'replies', 'quotes'];
        const commandArgs = ctx.message?.text?.slice(14).trim();
        
        if (commandArgs) {
            const requestedTypes = commandArgs.split(',').map(t => t.trim().toLowerCase());
            const validTypes = ['follows', 'recasts', 'likes', 'mentions', 'replies', 'quotes'];
            
            // Filter to only valid notification types
            const filteredTypes = requestedTypes.filter(t => validTypes.includes(t));
            
            if (filteredTypes.length > 0) {
                notificationTypes = filteredTypes;
                await ctx.reply(`Fetching your ${filteredTypes.join(', ')} notifications...`);
            } else {
                await ctx.reply("Invalid notification types. Fetching all notifications...");
            }
        } else {
            await ctx.reply("Fetching your notifications...");
        }
        
        const notifications = await getUserNotifications(user.fid, '', notificationTypes);
        console.log("Notifications:", notifications);

        if (!notifications.notifications || notifications.notifications.length === 0) {
            await ctx.reply("No notifications found.");
            return;
        }
        
        // Display unread count if available
        if (notifications.unseen_notifications_count) {
            await ctx.reply(`📬 You have ${notifications.unseen_notifications_count} unread notifications.`);
        }
        
        // Display the type filter that was applied
        if (notificationTypes.length < 6) {
            await ctx.reply(`Showing ${notificationTypes.join(', ')} notifications.`);
        }
        
        // Process and display the notifications by type
        for (const notification of notifications.notifications) {
            // Display header based on notification type
            let headerText = "";
            switch (notification.type) {
                case "follows":
                    headerText = "👥 New follower" + (notification.follows?.length > 1 ? "s" : "");
                    break;
                case "cast-mention":
                case "mentions":
                    headerText = "🔄 You were mentioned in a cast";
                    break;
                case "likes":
                    headerText = "❤️ Your cast received like" + (notification.count > 1 ? "s" : "");
                    break;
                case "recasts":
                    headerText = "🔄 Your cast was recasted";
                    break;
                case "replies":
                    headerText = "💬 New repl" + (notification.count > 1 ? "ies" : "y") + " to your cast";
                    break;
                case "quotes":
                    headerText = "💬 Your cast was quoted";
                    break;
                default:
                    headerText = "📢 New notification";
            }
            
            await ctx.reply(`${headerText} • ${new Date(notification.most_recent_timestamp).toLocaleString()}`);
            
            // Handle different notification types
            if (notification.type === "follows" && notification.follows) {
                // Display followers
                for (const follower of notification.follows) {
                    if (follower.user) {
                        const displayName = follower.user.display_name || follower.user.username;
                        const username = follower.user.username;
                        const pfpUrl = follower.user.pfp_url;
                        
                        let message = `<b>${displayName}</b> (@${username}) started following you`;
                        
                        // If we have a profile pic, display it
                        if (pfpUrl) {
                            try {
                                await ctx.replyWithPhoto(pfpUrl, {
                                    caption: message,
                                    parse_mode: "HTML"
                                });
                            } catch (e) {
                                console.error("Failed to send with profile photo:", e);
                                await ctx.reply(message, { parse_mode: "HTML" });
                            }
                        } else {
                            await ctx.reply(message, { parse_mode: "HTML" });
                        }
                    }
                }
            } else if (notification.cast) {
                // For cast-related notifications, display the cast
                await sendCast(ctx, notification.cast);
            } else if (notification.reactions && notification.reactions.length > 0) {
                // For reaction notifications, show who reacted and the cast
                for (const reaction of notification.reactions) {
                    if (reaction.user) {
                        const displayName = reaction.user.display_name || reaction.user.username;
                        await ctx.reply(`${displayName} reacted to your cast`);
                    }
                    
                    // If we have the cast that was reacted to, show it
                    if (reaction.cast) {
                        // Fetch the full cast details
                        const fullCast = await getCastByHash(reaction.cast.hash);
                        if (fullCast) {
                            await sendCast(ctx, fullCast);
                        }
                    }
                }
            }
        }
        
        // If there's a next page of notifications
        if (notifications.next?.cursor) {
            // Store the notification types along with the cursor
            await redis.set(`user:${ctx.from?.id}:notifications_types`, JSON.stringify(notificationTypes));
            
            // Generate a short random ID to use as a reference
            const shortId = Math.random().toString(36).substring(2, 10); // 8 char random string
            await redis.set(`cursor:${shortId}`, notifications.next.cursor);
            
            await ctx.reply("Want to see more notifications?", {
                reply_markup: {
                    inline_keyboard: [[
                        { text: "Load More Notifications", callback_data: `notif:${shortId}` }
                    ]]
                }
            });
            
            // Store the cursor in Redis (keeping this for backward compatibility)
            await redis.set(`user:${ctx.from?.id}:notifications_cursor`, notifications.next.cursor);
        }

    } catch (error) {
        console.error("Error fetching notifications:", error);
        await ctx.reply("Sorry, something went wrong while fetching notifications.");
    }
});


bot.command("replies", async (ctx) => {
  console.log("/replies command received from", ctx.from?.id);
  
  try {
      // Send immediate response to confirm command received
      await ctx.reply("Looking for replies to your casts...");
      
      const user = await db.getUser(ctx.from?.id || 0);
      console.log("Found user:", user);
      
      if (!user?.fid) {
          console.log("No FID found for user");
          await ctx.reply("No FID found. Please set up your account first with /start");
          return;
      }
      
      if (!user?.signerUuid || user.signerStatus !== 'approved') {
          await ctx.reply("You need an approved signer first. Use /start to set one up.");
          return;
      }
      
      // Fetch your cast keys
      const castKeys = await redis.keys(`user:${ctx.from?.id}:cast:*`);
      console.log("Found cast keys:", castKeys);
      
      if (!castKeys || castKeys.length === 0) {
          await ctx.reply("You haven't made any casts yet! Use /cast to create some content first.");
          return;
      }
      
      // Get cast hashes from Redis keys
      const castHashes = castKeys.map(key => key.split(':').pop());
      console.log("Cast hashes to check:", castHashes);
      
      await ctx.reply("Checking replies to your recent casts...");
      
      let repliesFound = false;
      let totalReplies = 0;
      
      // Check each cast for replies
      for (const castHash of castHashes) {
          try {
              if (!castHash) {
                  console.log("Invalid cast hash found:", castHash);
                  continue;
              }
              
              // Get original cast data from Redis
              const castData = await redis.get(`user:${ctx.from?.id}:cast:${castHash}`);
              const castInfo = castData ? JSON.parse(castData) : null;
              
              // First get the cast to check if it has replies
              const cast = await getCastByHash(castHash);
              
              if (!cast) {
                  console.log(`No data found for cast ${castHash}`);
                  continue;
              }
              
              // Now get the conversation if there are replies
              if (cast.replies?.count > 0) {
                  console.log(`Cast ${castHash} has ${cast.replies.count} replies, fetching conversation...`);
                  
                  const replies = await getCastConversation(castHash);
                  
                  if (replies.length > 0) {
                      repliesFound = true;
                      totalReplies += replies.length;
                      
                      // Show the original cast first
                      await ctx.reply(`🔍 Found ${replies.length} ${replies.length === 1 ? 'reply' : 'replies'} to your cast:`);
                      
                      // Display the original cast text
                      if (castInfo) {
                          let originalMsg = `Your original cast (${new Date(castInfo.timestamp).toLocaleString()}):\n`;
                          originalMsg += `"${castInfo.text}"`;
                          
                          if (castInfo.imageUrl) {
                              originalMsg += " (with image)";
                          }
                          
                          await ctx.reply(originalMsg);
                      }
                      
                      // Display each reply
                      for (const reply of replies) {
                          await sendCast(ctx, reply);
                      }
                  } else {
                      console.log(`API reported ${cast.replies.count} replies for cast ${castHash}, but none were found in the response.`);
                  }
              }
          } catch (error) {
              console.error(`Error checking replies for cast ${castHash}:`, error);
          }
      }
      
      if (!repliesFound) {
          await ctx.reply("No replies found to any of your casts.");
      } else {
          await ctx.reply(`✅ Found a total of ${totalReplies} ${totalReplies === 1 ? 'reply' : 'replies'} to your casts.`);
      }
  } catch (error) {
      console.error("Error checking replies:", error);
      await ctx.reply("Sorry, something went wrong while checking replies.");
  }
});

// Add channel casting capability
bot.command("channel_cast", async (ctx) => {
  console.log("/channel_cast command received");
  try {
      const user = await db.getUser(ctx.from?.id || 0);
      if (!user?.signerUuid || user.signerStatus !== 'approved') {
          await ctx.reply("You need an approved signer first. Use /start to set one up.");
          return;
      }

      const fullText = ctx.message?.text?.slice(13).trim(); 
      if (!fullText || !fullText.includes(' ')) {
          await ctx.reply("Please format your command as: /channel_cast channelId your cast text\nExample: /channel_cast art This is my artwork");
          return;
      }

      const spaceIndex = fullText.indexOf(' ');
      const channelId = fullText.substring(0, spaceIndex);
      const text = fullText.substring(spaceIndex + 1);

      await ctx.reply(`Publishing cast to channel "${channelId}"...`);
      const cast = await neynarClient.publishCast({
          signerUuid: user.signerUuid,
          text: text,
          channelId: channelId
      });

      await redis.set(`channel:${ctx.chat.id}:cast:${cast.cast.hash}`, JSON.stringify({
          text: text,
          timestamp: Date.now(),
          channelId: channelId
      }));

      await ctx.reply("✅ Channel cast published successfully!");
  } catch (error) {
      console.error("Error publishing channel cast:", error);
      await ctx.reply("Sorry, something went wrong while publishing your channel cast.");
  }
});

bot.command("reset_signer", async (ctx) => {
    console.log("reset_signer command received");
    await resetSigner(ctx.from?.id || 0);
    await ctx.reply("Signer reset successfully!");
});

bot.command("more", async (ctx) => {
    console.log("/more command received");
    try {
        const user = await db.getUser(ctx.from?.id || 0);
        if (!user?.fid) {
            await ctx.reply("No FID found. Please set up your account first with /start");
            return;
        }
        
        // Get the stored cursor for this user
        const cursor = await redis.get(`user:${ctx.from?.id}:feed_cursor`);
        if (!cursor) {
            await ctx.reply("No more posts available or you haven't fetched your feed yet. Use /feed first.");
            return;
        }
        
        await ctx.reply("Loading more casts...");
        
        // Fetch the next page of feed
        const feedResult = await getFyFeed(user.fid, cursor);
        const casts = feedResult.casts;
        
        if (!casts || casts.length === 0) {
            await ctx.reply("No more casts found in your feed.");
            return;
        }
        
        await ctx.reply("📱 More casts from your feed:");
        
        // Send each cast
        for (const cast of casts) {
            await sendCast(ctx, cast);
        }
        
        // If there's still more, update the cursor and add another "Load More" button
        if (feedResult.nextCursor) {
            await ctx.reply("Want to see more casts?", {
                reply_markup: {
                    inline_keyboard: [[
                        { text: "Load More ⬇️", callback_data: `load_more:${feedResult.nextCursor}` }
                    ]]
                }
            });
            
            // Update the cursor in Redis
            await redis.set(`user:${ctx.from?.id}:feed_cursor`, feedResult.nextCursor);
        } else {
            await ctx.reply("You've reached the end of your feed!");
            // Clear the cursor since there are no more pages
            await redis.del(`user:${ctx.from?.id}:feed_cursor`);
        }
    } catch (error) {
        console.error("Error in more command:", error);
        await ctx.reply("Sorry, something went wrong while fetching more casts.");
    }
});

// Message handler OUTSIDE startBot
bot.on("message", async (ctx) => {
    if (!ctx.message.text) return;
    
    // Skip if it's a command
    if (ctx.message.text.startsWith('/')) return;

    // Check if this is a reply to a cast
    const replyingTo = await redis.get(`user:${ctx.from.id}:replying_to`);
    if (replyingTo) {
        try {
            const user = await db.getUser(ctx.from.id);
            if (!user?.signerUuid || user.signerStatus !== 'approved') {
                await ctx.reply("You need an approved signer first. Use /start to set one up.");
                return;
            }

            await neynarClient.publishCast({
                signerUuid: user.signerUuid,
                text: ctx.message.text,
                parent: replyingTo
            });

            await redis.del(`user:${ctx.from.id}:replying_to`);
            await ctx.reply("✅ Reply published!");
        } catch (error) {
            console.error("Error publishing reply:", error);
            await ctx.reply("Sorry, something went wrong while publishing your reply.");
        }
        return;
    }

    console.log("Message received:", ctx.message.text);

    const fid = parseInt(ctx.message.text);
    if (isNaN(fid)) {
        await ctx.reply("Please send a valid FID (numbers only)");
        return;
    }

    try {
        // First check if user already has a signer
        const existingSignerUUID = await getSignerUUID(ctx.from.id);
        
        if (existingSignerUUID) {
            const status = await verifySignerStatus(existingSignerUUID);
            
            // Update the database with the current status
            await db.updateSignerStatus(ctx.from.id, status || 'pending_approval');
            
            if (status === 'approved') {
                // Update the FID for the existing user
                const userData = await db.getUser(ctx.from.id);
                if (userData) {
                    userData.fid = fid;
                    await db.saveUser(ctx.from.id, userData);
                    await ctx.reply("Updated your FID! You can now use /feed to see your Farcaster feed.");
                }
                return;
            } else if (status === 'pending_approval') {
                // Get the approval URL again
                const signer = await neynarClient.lookupSigner({ 
                    signerUuid: existingSignerUUID 
                });
                
                await ctx.reply("You still have a pending approval. Please approve in Warpcast:");
                await ctx.reply(signer.signer_approval_url || "No approval URL found");
                
                // Set up the same approval checking as for new users
                await ctx.reply("I'll check for your approval. This may take a moment...");
                
                // Start polling for approval (same code as for new signers)
                const pollInterval = 10000;
                const maxAttempts = 12;
                let attempts = 0;

                const checkApprovalStatus = async () => {
                    attempts++;
                    const currentStatus = await verifySignerStatus(existingSignerUUID);
                    
                    if (currentStatus) {
                        await db.updateSignerStatus(ctx.from.id, currentStatus);
                    }
                    
                    if (currentStatus === 'approved') {
                        await ctx.reply("✅ Great! Your connection is approved. You can now use /feed to see your Farcaster feed!");
                        return;
                    }
                    
                    if (attempts >= maxAttempts) {
                        await ctx.reply("I haven't detected your approval yet. You can approve anytime and then use /check_approval to verify.");
                        return;
                    }
                    
                    setTimeout(checkApprovalStatus, pollInterval);
                };

                setTimeout(checkApprovalStatus, pollInterval);
                return;
            }
            // If not approved or pending_approval, continue with new signer creation
        }

        // Create new signer with signed key
        const signer = await createSignedKey();
        console.log("Signed key created:", signer);

        if (signer.approval_url) {
            // Store both signer UUID and FID
            const userData = {
                chatId: ctx.from.id,
                fid: fid,
                signerUuid: signer.signer_uuid,
                signerStatus: 'generated' as const
            };
            await db.saveUser(ctx.from.id, userData);

            await ctx.reply("To get started, I need your approval to interact with Farcaster.");
            await ctx.reply("Please click this link to approve in Warpcast:", {
                parse_mode: "HTML"
            });
            await ctx.reply(signer.approval_url);
            
            await ctx.reply("I'll check for your approval. This may take a moment...");

            // Set up polling to check approval status
            const pollInterval = 10000; // 10 seconds
            const maxAttempts = 12; // Try for 2 minutes total (12 * 10s)
            let attempts = 0;

            const checkApprovalStatus = async () => {
                attempts++;
                const currentStatus = await verifySignerStatus(signer.signer_uuid);
                
                // Update the status in the database
                if (currentStatus) {
                    await db.updateSignerStatus(ctx.from.id, currentStatus);
                }
                
                if (currentStatus === 'approved') {
                    await ctx.reply("✅ Great! Your connection is approved. You can now use /feed to see your Farcaster feed!");
                    return;
                }
                
                if (attempts >= maxAttempts) {
                    await ctx.reply("I haven't detected your approval yet. You can approve anytime and then use /check_approval to verify or /get_approval_link to get the link again.");
                    return;
                }
                
                // Continue polling
                setTimeout(checkApprovalStatus, pollInterval);
            };

            // Start the polling
            setTimeout(checkApprovalStatus, pollInterval);
        } else {
            await ctx.reply("Sorry, something went wrong while setting up your Farcaster connection.");
        }
    } catch (error) {
        console.error("Error setting up signer:", error);
        await ctx.reply("Sorry, something went wrong. Please try again.");
    }
});

// Modify the photo handler to check for commands in the caption
bot.on("message:photo", async (ctx) => {
    console.log("Photo message received");
    
    // Check if the caption contains a /cast command
    if (ctx.message.caption?.startsWith('/cast')) {
        // Extract the text after the command
        const text = ctx.message.caption.slice(6).trim();
        
        try {
            const user = await db.getUser(ctx.from?.id || 0);
            if (!user?.signerUuid || user.signerStatus !== 'approved') {
                await ctx.reply("You need an approved signer first. Use /start to set one up.");
                return;
            }
            
            // Get the largest photo (last in the array)
            const photos = ctx.message.photo;
            const fileId = photos[photos.length - 1].file_id;
            
            await ctx.reply("Uploading image and publishing cast...");
            
            // Import the image upload function
            const { uploadImageFromTelegram } = await import('./utils/ut/ut');
            const imageUrl = await uploadImageFromTelegram(fileId);
            
            // Publish the cast with image
            const cast = await neynarClient.publishCast({
                signerUuid: user.signerUuid,
                text: text,
                embeds: [{ url: imageUrl }]
            });

            // Store the cast hash in Redis
            await redis.set(`user:${ctx.from?.id}:cast:${cast.cast.hash}`, JSON.stringify({
                text: text,
                imageUrl: imageUrl,
                timestamp: Date.now()
            }));
            
            await ctx.reply("✅ Cast with image published successfully!");
        } catch (error) {
            console.error("Error publishing cast with image:", error);
            await ctx.reply("Sorry, something went wrong while publishing your cast with image.");
        }
        return;
    }
    
    // Handle regular photo messages with captions (no command)
    if (ctx.message.caption || ctx.chat.type === "private") {
        try {
            const user = await db.getUser(ctx.from?.id || 0);
            if (!user?.signerUuid || user.signerStatus !== 'approved') {
                await ctx.reply("You need an approved signer first. Use /start to set one up.");
                return;
            }

            // Get the caption or use an empty string
            const text = ctx.message.caption || "";
            
            // Get the largest photo (last in the array)
            const photos = ctx.message.photo;
            const fileId = photos[photos.length - 1].file_id;
            
            await ctx.reply("Uploading image and publishing cast...");
            
            // Import the image upload function
            const { uploadImageFromTelegram } = await import('./utils/ut/ut');
            const imageUrl = await uploadImageFromTelegram(fileId);
            
            // Publish the cast with image
            const cast = await neynarClient.publishCast({
                signerUuid: user.signerUuid,
                text: text,
                embeds: [{ url: imageUrl }]
            });

            // Store the cast hash in Redis
            await redis.set(`user:${ctx.from?.id}:cast:${cast.cast.hash}`, JSON.stringify({
                text: text,
                imageUrl: imageUrl,
                timestamp: Date.now()
            }));
            
            await ctx.reply("✅ Cast with image published successfully!");
        } catch (error) {
            console.error("Error publishing cast with image:", error);
            await ctx.reply("Sorry, something went wrong while publishing your cast with image.");
        }
    }
});

// Add a periodic check function to update signer statuses automatically
async function checkAndUpdateAllSignerStatuses() {
    try {
        console.log("Running automatic signer status check...");
        const users = await db.getAllUsers();
        
        for (const user of users) {
            if (user.signerUuid && user.signerStatus !== 'approved') {
                try {
                    const signer = await neynarClient.lookupSigner({ 
                        signerUuid: user.signerUuid 
                    });
                    
                    if (user.signerStatus !== signer.status) {
                        console.log(`Updating status for user ${user.chatId}: ${user.signerStatus} -> ${signer.status}`);
                        await db.updateSignerStatus(user.chatId, signer.status);
                    }
                } catch (error) {
                    console.error(`Error checking signer for user ${user.chatId}:`, error);
                }
            }
        }
    } catch (error) {
        console.error("Error in automatic status check:", error);
    }
}

// Update the startBot function to include periodic checking
async function startBot() {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    console.log("Cleared pending updates");
    console.log("Starting bot...");
    
    // Run the status check every 5 minutes
    setInterval(checkAndUpdateAllSignerStatuses, 5 * 60 * 1000);
    
    bot.start();
}

export default bot;

startBot();
