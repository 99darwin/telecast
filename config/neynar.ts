import { getEnvVar } from "../utils/getEnvVar";

export const neynarApiKey = getEnvVar("NEYNAR_API_KEY");
export const hubGprcUrl = getEnvVar("HUB_GRPC_URL");
export const neynarClientId = getEnvVar("NEYNAR_CLIENT_ID");
export const neynarApiUrl = 'https://api.neynar.com/v2';
export const neynarHeaders = (method: string) => {
    const headers = {
        method: method,
        headers: {
            "x-api-key": neynarApiKey,
            "x-neynar-client-id": neynarClientId,
            "Content-Type": "application/json",
            "Accept": "application/json",
        }
    }
    return headers;
}