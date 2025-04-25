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

export const getFyFeed = async (fid: number, cursor: string = ''): Promise<any[]> => {
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
            return [];
        }

        const feedData = await feed.json();
        console.log('Feed response:', feedData);
        
        if (!feedData?.casts) {
            console.error('Invalid response:', feedData);
            return [];
        }
        
        return feedData.casts;
    } catch (error) {
        console.error('Error fetching feed:', error);
        return [];
    }
}

export const configureClient = async (fid: number): Promise<any[]> => {
    try {
        const followingInfo = await getFollowing(fid);
        console.log(`Found ${followingInfo.length} following`);

        const client = createClient();

        return new Promise((resolve, reject) => {
            client.$.waitForReady(Date.now() + 5000, async (e) => {
                if (e) {
                    reject(e);
                } else {
                    console.log(`Connected to ${hubGprcUrl}`);
                    const allCasts: any[] = [];
                    try {
                        for (const following of followingInfo) {
                            const castsResult = await client.getCastsByFid({
                                fid: following.fid,
                            });
                            castsResult.map((casts) =>
                                casts.messages.map((cast) =>
                                    allCasts.push({
                                        text: cast.data?.castAddBody?.text,
                                        fid: following.fid,
                                        pfp_url: following.pfp_url,
                                        timestamp: cast.data?.timestamp,
                                    })
                                )
                            );
                        }
                    } finally {
                        client.close();
                    }
                    resolve(allCasts);
                }
            });
        });
    } catch (error) {
        console.error(error);
        return [];
    }
};

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
