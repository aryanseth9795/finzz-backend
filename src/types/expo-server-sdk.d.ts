// Type declarations for expo-server-sdk to fix "isExpoPushToken does not exist" error
declare module "expo-server-sdk" {
  export interface ExpoPushMessage {
    to: string | string[];
    data?: object;
    title?: string;
    subtitle?: string;
    body?: string;
    sound?: "default" | null;
    ttl?: number;
    expiration?: number;
    priority?: string;
    badge?: number;
    channelId?: string;
  }

  export class Expo {
    constructor(options?: any);
    static isExpoPushToken(token: any): boolean;
    chunkPushNotifications(messages: ExpoPushMessage[]): ExpoPushMessage[][];
    sendPushNotificationsAsync(messages: ExpoPushMessage[]): Promise<any>;
  }

  export default Expo;
}
