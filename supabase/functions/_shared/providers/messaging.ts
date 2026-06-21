export type MessagingChannel = "sms" | "mms" | "rcs";

export interface SendMessageInput {
  projectId: string;
  contactId?: string;
  to: string;
  body: string;
  requestedChannel: MessagingChannel;
  richPayload?: Record<string, unknown>;
}

export interface SendMessageResult {
  provider: string;
  providerMessageId: string;
  requestedChannel: MessagingChannel;
  actualChannel: MessagingChannel;
  status: string;
}

export interface MessagingProvider {
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
}
