/**
 * Telegram Extension (cross-plugin API)
 *
 * Provides the extension object registered with core for other plugins
 * and daemon API routes to expose Telegram bot status via WebMCP tools.
 */

import type { Bot } from "grammy";
import type { WOPRPluginContext } from "@wopr-network/plugin-types";

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
): TelegramExtension {
  return {
    getBotUsername: () => getBot()?.botInfo?.username || "unknown",

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
      const telegramSessions = currentCtx
        ? currentCtx.getSessions().filter((s) => s.startsWith("telegram-"))
        : [];
      return {
        sessionsActive: telegramSessions.length,
        activeConversations: telegramSessions.length,
      };
    },
  };
}
