import { ViemLocalEip712Signer } from "@farcaster/hub-nodejs";
import { bytesToHex, hexToBytes } from "viem";
import { mnemonicToAccount } from "viem/accounts";
import { neynarApiUrl, neynarHeaders } from '../../config';
import neynarClient from "./neynarClient";
import { db } from '../db/redis';

export const getFid = async () => {
    if (!process.env.FARCASTER_DEVELOPER_MNEMONIC) {
        throw new Error("FARCASTER_DEVELOPER_MNEMONIC is not set.");
    }

    const account = mnemonicToAccount(process.env.FARCASTER_DEVELOPER_MNEMONIC);
    console.log("Looking up FID for address:", account.address);

    // Use the SDK method instead of raw HTTP request
    const { user } = await neynarClient.lookupUserByCustodyAddress({
        custodyAddress: account.address,
    });

    if (!user?.fid) {
        throw new Error(`No FID found for custody address ${account.address}`);
    }

    return Number(user.fid);
};

const generateSignature = async (publicKey: string) => {
    if (!process.env.FARCASTER_DEVELOPER_MNEMONIC) {
        throw new Error("FARCASTER_DEVELOPER_MNEMONIC is not defined");
    }

    const FID = await getFid();
    const account = mnemonicToAccount(process.env.FARCASTER_DEVELOPER_MNEMONIC);
    const appAccountKey = new ViemLocalEip712Signer(account as any);

    const deadline = Math.floor(Date.now() / 1000) + 86400; // 24 hours
    const uintAddress = hexToBytes(publicKey as `0x${string}`);

    const signature = await appAccountKey.signKeyRequest({
        requestFid: BigInt(FID),
        key: uintAddress,
        deadline: BigInt(deadline),
    });

    if (signature.isErr()) {
        throw new Error("Failed to generate signature");
    }

    return { 
        deadline, 
        signature: bytesToHex(signature.value)
    };
};

export const createSignedKey = async () => {
    // Step 1: Create initial signer
    const signer = await neynarClient.createSigner();
    
    // Step 2: Generate signature
    const { deadline, signature } = await generateSignature(signer.public_key);
    const fid = await getFid();

    // Step 3: Register signed key
    const signedKey = await neynarClient.registerSignedKey({
        signerUuid: signer.signer_uuid,
        appFid: fid,
        deadline,
        signature,
    });
    
    return {
        signer_uuid: signedKey.signer_uuid,
        public_key: signedKey.public_key,
        status: signedKey.status,
        approval_url: signedKey.signer_approval_url
    };
};

export const storeSignerUUID = async (chatId: number, signerUuid: string) => {
    const userData = await db.getUser(chatId) || {
        chatId,
        fid: 0, // We'll need to set this when we get it
        signerUuid,
        signerStatus: 'generated' as const
    };
    
    userData.signerUuid = signerUuid;
    await db.saveUser(chatId, userData);
};

export const getSignerUUID = async (chatId: number): Promise<string | null> => {
    const userData = await db.getUser(chatId);
    return userData?.signerUuid || null;
};

export const verifySignerStatus = async (signerUuid: string) => {
    try {
        const signer = await neynarClient.lookupSigner({ 
            signerUuid 
        });
        return signer.status;
    } catch (error) {
        console.error("Error verifying signer status:", error);
        return null;
    }
};

export const checkSigner = async (signerUuid: string) => {
    try {
        const signer = await neynarClient.lookupSigner({ 
            signerUuid 
        });
        console.log("Signer details:", signer);
        return signer;
    } catch (error) {
        console.error("Error looking up signer:", error);
        throw error;
    }
};

export const checkAllSigners = async () => {
    const users = await db.getAllUsers();
    const results = [];
    
    for (const user of users) {
        if (user.signerUuid) {
            try {
                const signer = await neynarClient.lookupSigner({ 
                    signerUuid: user.signerUuid 
                });
                results.push({
                    chatId: user.chatId,
                    fid: user.fid,
                    signerUuid: user.signerUuid,
                    status: signer.status
                });
            } catch (error) {
                console.error(`Error checking signer ${user.signerUuid}:`, error);
            }
        }
    }
    
    return results;
};

export const resetSigner = async (chatId: number) => {
    // Step 1: Create a new signed key
    const newSignedKey = await createSignedKey();
    
    // Step 2: Store the new signer UUID
    await storeSignerUUID(chatId, newSignedKey.signer_uuid);
    
    // Step 3: Update signer status
    await db.updateSignerStatus(chatId, 'generated');
    
    return {
        signer_uuid: newSignedKey.signer_uuid,
        approval_url: newSignedKey.approval_url,
        status: newSignedKey.status
    };
};