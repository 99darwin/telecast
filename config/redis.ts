import { getEnvVar } from "../utils/getEnvVar";

export const redisUrl = getEnvVar("REDIS_URL");
