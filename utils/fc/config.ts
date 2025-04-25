import { createClient } from './hub';
import { hubGprcUrl, neynarHeaders, neynarApiUrl, neynarApiKey } from '../../config';

const getFollowing = async (fid: number, cursor: string = ''): Promise<any[]> => {
    const following = await fetch(
        `${neynarApiUrl}/farcaster/following?limit=100&fid=${fid}&viewer_fid=${fid}&sort_type=algorithmic&cursor=${cursor}`,
        neynarHeaders('GET')
    );

    if (!following.ok) {
        console.error(`API Error: ${following.status} ${following.statusText}`);
        return [];
    }

    const followingData = await following.json();
    if (!followingData?.users) {
        console.error('Invalid response:', followingData);
        return [];
    }

    // Map current page of followers
    const currentFollowing = followingData.users.map((following: any) => ({
        fid: following.user.fid,
        pfp_url: following.user.pfp_url,
    }));

    // If there's a next page, recursively fetch and combine
    if (followingData.next?.cursor) {
        const nextFollowing = await getFollowing(fid, followingData.next.cursor);
        return [...currentFollowing, ...nextFollowing];
    }

    return currentFollowing;
}

export const getFyFeed = async (fid: number, cursor: string = ''): Promise<{casts: any[], nextCursor?: string}> => {
    try {
        console.log(`Fetching feed for FID ${fid} with cursor ${cursor}`);
        const feed = await fetch(
            `${neynarApiUrl}/farcaster/feed/for_you?provider=neynar&limit=10&fid=${fid}&viewer_fid=${fid}&cursor=${cursor}`,
            neynarHeaders('GET')
        );
        
        if (!feed.ok) {
            console.error(`Feed API Error: ${feed.status} ${feed.statusText}`);
            const errorText = await feed.text();
            console.error('Error response:', errorText);
            return { casts: [] };
        }

        const feedData = await feed.json();
        console.log('Feed response:', feedData);
        
        if (!feedData?.casts) {
            console.error('Invalid response:', feedData);
            return { casts: [] };
        }
        
        return { 
            casts: feedData.casts,
            nextCursor: feedData.next?.cursor
        };
    } catch (error) {
        console.error('Error fetching feed:', error);
        return { casts: [] };
    }
}

// Add new endpoints for signer management
export const createSigner = async () => {
    // Step 1: Create initial signer
    const response = await fetch(`${neynarApiUrl}/farcaster/signer`, {
        method: 'POST',
        headers: {
            'api_key': neynarApiKey,
            'Content-Type': 'application/json'
        }
    });
    const signer = await response.json();
    
    // Step 2: Register signed key
    const deadline = Math.floor(Date.now() / 1000) + 86400; // 24 hours from now
    const signedKeyResponse = await fetch(`${neynarApiUrl}/farcaster/signer/signed_key`, {
        method: 'POST',
        headers: {
            'api_key': neynarApiKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            signer_uuid: signer.signer_uuid,
            app_fid: 269091,
            deadline: deadline,
            signature: process.env.APP_SIGNATURE! // We'll need to generate this
        })
    });
    
    return signedKeyResponse.json();
};

export const registerSignedKey = async (signerUuid: string, deadline: number, signature: string, publicKey: string) => {
    const response = await fetch(`${neynarApiUrl}/farcaster/signer/signed_key`, {
        method: 'POST',
        headers: {
            'api_key': neynarApiKey,
            'Content-Type': 'application/json'
        },
        body: JSON.stringify({
            signer_uuid: signerUuid,
            app_fid: 269091, // We'll need to set this
            deadline,
            signature,
            public_key: publicKey
        })
    });
    return response.json();
};

export const getSigner = async (signerUuid: string) => {
    const response = await fetch(`${neynarApiUrl}/farcaster/signer/${signerUuid}`, {
        headers: {
            'api_key': neynarApiKey
        }
    });
    return response.json();
};

export const postCast = async (signerUuid: string, text: string, replyTo?: string) => {
    const endpoint = `${neynarApiUrl}/farcaster/cast`;
    const body = replyTo ? 
        { signer_uuid: signerUuid, text, parent: replyTo } : 
        { signer_uuid: signerUuid, text };

    const response = await fetch(endpoint, {
        ...neynarHeaders('POST'),
        body: JSON.stringify(body)
    });
    return response.json();
};

export const reactToCast = async (signerUuid: string, castHash: string, reaction: 'like' | 'recast') => {
    const endpoint = `${neynarApiUrl}/farcaster/reaction`;
    const body = {
        signer_uuid: signerUuid,
        reaction_type: reaction === 'like' ? 'LIKE' : 'RECAST',
        hash: castHash
    };

    const response = await fetch(endpoint, {
        ...neynarHeaders('POST'),
        body: JSON.stringify(body)
    });
    return response.json();
};

// Update the function to fetch cast replies with an additional call if needed
export const getCastWithReplies = async (castHash: string): Promise<any> => {
    try {
        // First fetch the cast itself
        const castResponse = await fetch(
            `${neynarApiUrl}/farcaster/cast?identifier=${castHash}&type=hash`,
            neynarHeaders('GET')
        );
        
        if (!castResponse.ok) {
            console.error(`Cast API Error: ${castResponse.status} ${castResponse.statusText}`);
            const errorText = await castResponse.text();
            console.error('Error response:', errorText);
            return null;
        }
        
        const castData = await castResponse.json();
        const cast = castData.cast;
        
        // If there are replies, fetch them separately
        if (cast?.replies?.count > 0) {
            console.log(`Cast ${castHash} has ${cast.replies.count} replies, fetching them...`);
            
            // Use the correct parameters for the casts endpoint
            // According to Neynar API documentation, the parameter is "parent" not "parent_hash"
            const repliesResponse = await fetch(
                `${neynarApiUrl}/farcaster/casts?parent=${castHash}&limit=25`,
                neynarHeaders('GET')
            );
            
            if (!repliesResponse.ok) {
                console.error(`Replies API Error: ${repliesResponse.status} ${repliesResponse.statusText}`);
                // Log the error response text to debug the issue
                const errorText = await repliesResponse.text();
                console.error('Error response:', errorText);
                return cast;
            }
            
            const repliesData = await repliesResponse.json();
            console.log(`Fetched ${repliesData.casts?.length || 0} actual replies for cast ${castHash}`);
            
            // Add the replies to the cast object
            if (repliesData.casts && repliesData.casts.length > 0) {
                cast.replies.casts = repliesData.casts;
            }
        }
        
        return cast;
    } catch (error) {
        console.error('Error fetching cast with replies:', error);
        return null;
    }
};

// Update function to fetch replies based on thread hash
export const getCastReplies = async (castHash: string): Promise<any[]> => {
    try {
        // First get the cast to get the thread hash
        const castResponse = await fetch(
            `${neynarApiUrl}/farcaster/cast?identifier=${castHash}&type=hash`,
            neynarHeaders('GET')
        );
        
        if (!castResponse.ok) {
            console.error(`Cast API Error: ${castResponse.status} ${castResponse.statusText}`);
            return [];
        }
        
        const castData = await castResponse.json();
        const cast = castData.cast;
        
        // If there are no replies, return empty array
        if (!cast.replies?.count || cast.replies.count === 0) {
            return [];
        }
        
        console.log(`Cast ${castHash} has ${cast.replies.count} replies, fetching them...`);
        
        // Get the thread hash - this is what we need to get replies
        const threadHash = cast.thread_hash || castHash;
        
        // Now fetch the thread to get the replies
        const threadResponse = await fetch(
            `${neynarApiUrl}/farcaster/all-casts-in-thread?threadHash=${threadHash}&limit=25`,
            neynarHeaders('GET')
        );
        
        if (!threadResponse.ok) {
            console.error(`Thread API Error: ${threadResponse.status} ${threadResponse.statusText}`);
            return [];
        }
        
        const threadData = await threadResponse.json();
        console.log(`Thread data retrieved with ${threadData.casts?.length || 0} casts`);
        
        // Filter the casts in the thread to only include direct replies to this cast
        const directReplies = threadData.casts?.filter((c: any) => c.parent_hash === castHash) || [];
        
        console.log(`Found ${directReplies.length} direct replies to cast ${castHash}`);
        
        return directReplies;
    } catch (error) {
        console.error('Error fetching cast replies:', error);
        return [];
    }
};

// Helper function to normalize cast data format from different Neynar endpoints
export const normalizeCastFormat = (cast: any): any => {
    if (!cast) return null;
    
    // Make sure we have at least the basic fields required by sendCast
    const normalized = {
        hash: cast.hash,
        text: cast.text || '',
        timestamp: cast.timestamp || new Date().toISOString(),
        author: {
            fid: cast.author?.fid,
            username: cast.author?.username || 'unknown',
            display_name: cast.author?.display_name || cast.author?.username || 'Unknown',
            pfp_url: cast.author?.pfp_url || ''
        },
        reactions: {
            likes: cast.reactions?.likes || 0,
            recasts: cast.reactions?.recasts || 0
        },
        replies: {
            count: cast.replies?.count || 0
        },
        embeds: cast.embeds || []
    };
    
    return normalized;
};

// Function to fetch cast conversation and extract all replies from the correct location
export const getCastConversation = async (castHash: string): Promise<any[]> => {
    try {
        // Use the cast/conversation endpoint
        const response = await fetch(
            `${neynarApiUrl}/farcaster/cast/conversation?identifier=${castHash}&type=hash`,
            neynarHeaders('GET')
        );
        
        if (!response.ok) {
            console.error(`Conversation API Error: ${response.status} ${response.statusText}`);
            const errorText = await response.text();
            console.error('Error response:', errorText);
            return [];
        }
        
        const data = await response.json();
        
        // Based on the exact structure we've seen, extract the direct_replies
        const directReplies = data.conversation?.cast?.direct_replies || [];
        
        console.log(`Found ${directReplies.length} direct replies for cast ${castHash}`);
        
        // Also collect any nested replies (replies to replies)
        const nestedReplies = [];
        
        // Check each direct reply for its own direct replies
        for (const reply of directReplies) {
            if (reply.direct_replies && reply.direct_replies.length > 0) {
                console.log(`Found ${reply.direct_replies.length} nested replies for reply ${reply.hash}`);
                nestedReplies.push(...reply.direct_replies);
            }
        }
        
        // Combine direct replies and nested replies if needed
        const allReplies = [...directReplies, ...nestedReplies];
        console.log(`Total replies found (direct + nested): ${allReplies.length}`);
        
        return allReplies;
    } catch (error) {
        console.error('Error fetching cast conversation:', error);
        return [];
    }
};

// Function to fetch a single cast by hash with the correct type parameter
export const getCastByHash = async (castHash: string): Promise<any> => {
    try {
        const response = await fetch(
            `${neynarApiUrl}/farcaster/cast?identifier=${castHash}&type=hash`,
            neynarHeaders('GET')
        );
        
        if (!response.ok) {
            console.error(`Cast API Error: ${response.status} ${response.statusText}`);
            const errorText = await response.text();
            console.error('Error response:', errorText);
            return null;
        }
        
        const data = await response.json();
        return data.cast;
    } catch (error) {
        console.error('Error fetching cast by hash:', error);
        return null;
    }
};

// Updated function to support filtering notifications by type
export const getUserNotifications = async (
    fid: number, 
    cursor: string = '', 
    types: string[] = ['follows', 'recasts', 'likes', 'mentions', 'replies', 'quotes']
) => {
    try {
        // Join the types with commas for the query parameter
        const typeParam = types.join(',');
        
        // Construct the URL with the specified types
        const url = `${neynarApiUrl}/farcaster/notifications?fid=${fid}&type=${typeParam}&limit=15&cursor=${cursor}`;
        
        console.log(`Fetching notifications: ${url}`);
        const response = await fetch(url, neynarHeaders('GET'));
        
        if (!response.ok) {
            console.error(`Notifications API Error: ${response.status} ${response.statusText}`);
            const errorText = await response.text();
            console.error('Error response:', errorText);
            return { notifications: [] };
        }
        
        const data = await response.json();
        return data;
    } catch (error) {
        console.error('Error fetching user notifications:', error);
        return { notifications: [] };
    }
}


