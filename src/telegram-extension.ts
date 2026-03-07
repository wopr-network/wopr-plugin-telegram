/**
 * Telegram Extension (cross-plugin API)
 *
 * Provides the extension object registered with core for other plugins
 * and daemon API routes to expose Telegram bot status via WebMCP tools.
 */

import type { WOPRPluginContext } from "@wopr-network/plugin-types";
import type { Bot } from "grammy";
import {
  buildFriendRequestKeyboard,
  formatFriendRequestMessage,
  setMessageIdOnPendingFriendRequest,
  storePendingFriendRequest,
} from "./friend-buttons.js";

// ============================================================================
// Structured return types for WebMCP-facing extension methods
// ============================================================================

export interface TelegramStatusInfo {
  online: boolean;
  username: string;
  latencyMs: number;
}

export interface TelegramChatInfo {
  id: string;
  type: string;
  name: string;
}

export interface TelegramMessageStatsInfo {
  sessionsActive: number;
  activeConversations: number;
}

export interface TelegramExtension {
  getBotUsername: () => string;

  /**
   * Send a friend request notification to the bot owner via Telegram DM.
   * Returns true if the notification was sent, false otherwise.
   */
  sendNotification: (
    requestFrom: string,
    pubkey: string,
    encryptPub: string,
    channelId: string,
    channelName: string,
    signature: string,
  ) => Promise<boolean>;

  // Read-only WebMCP data methods
  getStatus: () => TelegramStatusInfo;
  listChats: () => TelegramChatInfo[];
  getMessageStats: () => TelegramMessageStatsInfo;
}

/**
 * Create the Telegram extension object.
 *
 * Uses getter functions so the extension always reflects the current
 * runtime state of the bot and plugin context.
 */
export function createTelegramExtension(
  getBot: () => Bot | null,
  getCtx: () => WOPRPluginContext | null,
  getLogger?: () => import("winston").Logger,
): TelegramExtension {
  return {
    getBotUsername: () => getBot()?.botInfo?.username || "unknown",

    sendNotification: async (
      requestFrom: string,
      pubkey: string,
      encryptPub: string,
      channelId: string,
      channelName: string,
      signature: string,
    ): Promise<boolean> => {
      const currentBot = getBot();
      const currentCtx = getCtx();
      if (!currentBot || !currentCtx) return false;

      const config = currentCtx.getConfig<{ ownerChatId?: string | number }>();
      if (!config.ownerChatId) {
        getLogger?.()?.warn("No ownerChatId configured — friend request notification not sent");
        return false;
      }

      const storeResult = storePendingFriendRequest(requestFrom, pubkey, encryptPub, channelId, signature);
      if (typeof storeResult === "string") {
        getLogger?.()?.warn(`Friend request rejected: invalid keys from ${requestFrom}: ${storeResult}`);
        return false;
      }

      try {
        const text = formatFriendRequestMessage(requestFrom, pubkey, channelName);
        const keyboard = buildFriendRequestKeyboard(storeResult.id);
        const sent = await currentBot.api.sendMessage(String(config.ownerChatId), text, {
          parse_mode: "HTML",
          reply_markup: keyboard,
        });

        setMessageIdOnPendingFriendRequest(storeResult.id, sent.message_id);

        getLogger?.()?.info(`Friend request notification sent to owner for request from ${requestFrom}`);
        return true;
      } catch (err) {
        getLogger?.()?.error(`Failed to send friend request notification: ${String(err)}`);
        return false;
      }
    },

    getStatus: (): TelegramStatusInfo => {
      const currentBot = getBot();
      if (!currentBot) {
        return { online: false, username: "unknown", latencyMs: -1 };
      }
      return {
        online: currentBot.botInfo !== undefined,
        username: currentBot.botInfo?.username || "unknown",
        latencyMs: -1, // Grammy does not expose ws ping; -1 = unavailable
      };
    },

    listChats: (): TelegramChatInfo[] => {
      const currentCtx = getCtx();
      if (!currentCtx) return [];

      // Derive active chats from session keys.
      // Session keys follow the pattern "telegram-dm:<userId>" or "telegram-group:<chatId>".
      const sessions = currentCtx.getSessions();
      return sessions
        .filter((s) => s.startsWith("telegram-"))
        .map((s) => {
          if (s.startsWith("telegram-dm:")) {
            const id = s.slice("telegram-dm:".length);
            return { id, type: "dm", name: `DM ${id}` };
          }
          if (s.startsWith("telegram-group:")) {
            const id = s.slice("telegram-group:".length);
            return { id, type: "group", name: `Group ${id}` };
          }
          return { id: s, type: "unknown", name: s };
        });
    },

    getMessageStats: (): TelegramMessageStatsInfo => {
      const currentCtx = getCtx();
      const telegramSessions = currentCtx ? currentCtx.getSessions().filter((s) => s.startsWith("telegram-")) : [];
      return {
        sessionsActive: telegramSessions.length,
        activeConversations: telegramSessions.length,
      };
    },
  };
}
