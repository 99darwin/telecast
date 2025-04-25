import {
    createDefaultMetadataKeyInterceptor,
    getSSLHubRpcClient,
} from '@farcaster/hub-nodejs';
import { neynarApiKey, hubGprcUrl } from '../../config';

export const createClient = () => {
    return getSSLHubRpcClient(hubGprcUrl, {
        interceptors: [
            createDefaultMetadataKeyInterceptor("x-api-key", neynarApiKey),
        ],
        "grpc.max_receive_message_length": 20 * 1024 * 1024,
    });
};
