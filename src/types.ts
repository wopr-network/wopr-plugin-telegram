import type { InlineKeyboard } from "grammy";

export interface TelegramConfig {
  botToken?: string;
  tokenFile?: string;
  dmPolicy?: "allowlist" | "pairing" | "open" | "disabled";
  allowFrom?: string[];
  groupPolicy?: "allowlist" | "open" | "disabled";
  groupAllowFrom?: string[];
  mediaMaxMb?: number;
  timeoutSeconds?: number;
  webhookUrl?: string;
  webhookPort?: number;
  maxRetries?: number;
  retryMaxDelay?: number;
  webhookPath?: string;
  webhookSecret?: string;
  ackReaction?: string;
  ownerChatId?: string | number;
}

export interface SendOptions {
  replyToMessageId?: number;
  mediaUrl?: string;
  mediaBuffer?: Buffer;
  mediaType?: "photo" | "document";
  reply_markup?: InlineKeyboard;
}

export type {
  AgentIdentity,
  ChannelCommand,
  ChannelCommandContext,
  ChannelMessageContext,
  ChannelMessageParser,
  ChannelProvider,
  ChannelRef,
  ConfigSchema,
  PluginInjectOptions,
  PluginManifest,
  StreamMessage,
  WOPRPlugin,
  WOPRPluginContext,
} from "@wopr-network/plugin-types";
