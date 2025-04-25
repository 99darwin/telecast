import { Bot } from "grammy";
import { botToken } from "./config";
import { getFyFeed, createSigner, getSigner } from "./utils/fc/config";
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

// Modify sendCast to include inline keyboard
async function sendCast(ctx: any, cast: any) {
    const text = cast.text;
    const author = cast.author;
    const castMedia = cast.embeds[0]
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
}

// Add callback query handler for the buttons
bot.on("callback_query", async (ctx) => {
    try {
        const [action, castHash] = ctx.callbackQuery?.data?.split(':') as [CastAction, string];
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
        
        const casts = await getFyFeed(user.fid);
        console.log("Got casts:", casts?.length);
        
        if (!casts || casts.length === 0) {
            console.log("No casts found");
            await ctx.reply("No casts found in your feed.");
            return;
        }

        await ctx.reply("🔄 Latest casts from your feed:");
        for (const cast of casts.slice(0, 10)) {
            await sendCast(ctx, cast);
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

        await ctx.reply("Publishing your cast...");
        const cast = await neynarClient.publishCast({
            signerUuid: user.signerUuid,
            text: text
        });

        // Store the cast hash in Redis with timestamp
        await redis.set(`user:${ctx.from?.id}:cast:${cast.cast.hash}`, JSON.stringify({
            text: text,
            timestamp: Date.now()
        }));
        
        await ctx.reply("✅ Cast published successfully!");
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
        await ctx.reply("Updating signer information in database...");
        
        const userData = {
            chatId: ctx.from?.id || 0,
            fid: 0, /**@dev Replace with your FID */
            signerUuid: 'your-signer-uuid', /**@dev Replace with your signer UUID */
            signerStatus: 'approved' as const
        };
        
        await db.saveUser(ctx.from?.id || 0, userData);
        await ctx.reply("✅ Updated database with approved signer!");
        
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
        await ctx.reply("Checking existing signer...");
        
        const signer = await checkSigner('your-signer-uuid'); /**@dev Replace with your signer UUID */
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
        await ctx.reply("Checking our approved signer...");
        console.log("Sending lookup request for signer");
        const signer = await neynarClient.lookupSigner({ 
            signerUuid: 'your-signer-uuid' /**@dev Replace with your signer UUID */
        });
        console.log("Got signer response:", signer);
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

bot.command("replies", async (ctx) => {
  console.log("/replies command received from", ctx.from?.id);
  
  try {
      // Send immediate response to confirm command received
      await ctx.reply("Looking for replies to your casts...");
      
      // Rest of your existing code to check replies
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
      
      // Rest of your reply checking logic...
      await ctx.reply("Checking replies to your recent casts...");
      
      // For now, I'm just confirming the command works
      // You can add back the API calls once confirmed
      await ctx.reply("Finished checking replies!");
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
            if (status === 'approved') {
                // Update the FID for the existing user
                const userData = await db.getUser(ctx.from.id);
                if (userData) {
                    userData.fid = fid;
                    await db.saveUser(ctx.from.id, userData);
                    await ctx.reply("Updated your FID! You can now use /feed to see your Farcaster feed.");
                }
                return;
            }
            // If not approved, continue with new signer creation
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
            
            // Set up a check for approval
            await ctx.reply("I'll check for your approval in a moment...");
            
            // Wait a bit and check status
            setTimeout(async () => {
                const status = await verifySignerStatus(signer.signer_uuid);
                if (status === 'approved') {
                    await ctx.reply("Great! Your connection is approved. You can now use /feed to see your Farcaster feed!");
                } else {
                    await ctx.reply("I haven't detected your approval yet. Please approve the connection in Warpcast and then try /start again.");
                }
            }, 30000); // Wait 30 seconds before checking
        } else {
            await ctx.reply("Sorry, something went wrong while setting up your Farcaster connection.");
        }
    } catch (error) {
        console.error("Error setting up signer:", error);
        await ctx.reply("Sorry, something went wrong. Please try again.");
    }
});

// Keep feed check interval outside startBot
setInterval(async () => {
    const users = await db.getAllUsers();
    for (const user of users) {
        if (user.signerStatus === 'approved') {
            try {
                const casts = await getFyFeed(user.fid);
                if (casts.length > 0) {
                    await bot.api.sendMessage(user.chatId, "🔄 New casts from your feed:");
                    for (const cast of casts.slice(0, 10)) {
                        await sendCast({ 
                            reply: (msg: string, opts: any) => bot.api.sendMessage(user.chatId, msg, opts),
                            replyWithPhoto: (photo: string, opts: any) => bot.api.sendPhoto(user.chatId, photo, opts)
                        }, cast);
                    }
                }
            } catch (error) {
                console.error(`Error fetching feed for chat ${user.chatId}:`, error);
            }
        }
    }
}, 5 * 60 * 1000);

async function startBot() {
    await bot.api.deleteWebhook({ drop_pending_updates: true });
    console.log("Cleared pending updates");
    console.log("Starting bot...");
    bot.start();
}

startBot();
