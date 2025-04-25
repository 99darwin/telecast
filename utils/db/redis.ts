import { Redis } from 'ioredis';
import { redisUrl } from '../../config/redis';
class RedisClient {
    private static instance: Redis | null = null;

    static getInstance(): Redis {
        if (!RedisClient.instance) {
            RedisClient.instance = new Redis(redisUrl);

            RedisClient.instance.on('error', (err) => {
                console.error('Redis Error:', err);
            });

            RedisClient.instance.on('connect', () => {
                console.log('Connected to Redis');
            });
        }

        return RedisClient.instance;
    }
}

export const redis = RedisClient.getInstance();

interface UserData {
    fid: number;
    signerUuid: string;
    signerStatus: 'generated' | 'pending_approval' | 'approved' | 'revoked';
    chatId: number;
}

export const db = {
    async saveUser(chatId: number, data: UserData) {
        await redis.set(`user:${chatId}`, JSON.stringify(data));
    },

    async getUser(chatId: number): Promise<UserData | null> {
        const data = await redis.get(`user:${chatId}`);
        return data ? JSON.parse(data) : null;
    },

    async getAllUsers(): Promise<UserData[]> {
        const keys = await redis.keys('user:*');
        const users: UserData[] = [];
        
        for (const key of keys) {
            const data = await redis.get(key);
            if (data) {
                users.push(JSON.parse(data));
            }
        }
        
        return users;
    },

    async removeUser(chatId: number) {
        await redis.del(`user:${chatId}`);
    },

    async updateSignerStatus(chatId: number, status: UserData['signerStatus']) {
        const user = await this.getUser(chatId);
        if (user) {
            user.signerStatus = status;
            await this.saveUser(chatId, user);
        }
    }
};