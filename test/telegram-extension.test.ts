/**
 * Tests for TelegramExtension WebMCP methods.
 *
 * Validates structured data output, null bot/ctx handling,
 * and correct session filtering for Telegram-specific sessions.
 */

import { describe, expect, it } from "vitest";
import { createTelegramExtension } from "../src/telegram-extension.js";
import type { WOPRPluginContext } from "@wopr-network/plugin-types";

function createMockBot(options: { username?: string; hasBotInfo?: boolean } = {}): any {
  if (options.hasBotInfo === false) {
    return { botInfo: undefined };
  }
  return {
    botInfo: {
      id: 123456,
      is_bot: true,
      first_name: "TestBot",
      username: options.username ?? "wopr_test_bot",
      can_join_groups: true,
      can_read_all_group_messages: false,
      supports_inline_queries: false,
    },
  };
}

function createMockCtx(sessions: string[] = []): WOPRPluginContext {
  return {
    getSessions: () => sessions,
    getConfig: () => ({}),
  } as unknown as WOPRPluginContext;
}

describe("TelegramExtension", () => {
  describe("getBotUsername", () => {
    it("should return username when bot is available", () => {
      const ext = createTelegramExtension(
        () => createMockBot({ username: "my_bot" }),
        () => createMockCtx(),
      );
      expect(ext.getBotUsername()).toBe("my_bot");
    });

    it("should return 'unknown' when bot is null", () => {
      const ext = createTelegramExtension(
        () => null,
        () => null,
      );
      expect(ext.getBotUsername()).toBe("unknown");
    });
  });

  describe("getStatus", () => {
    it("should return offline status when bot is null", () => {
      const ext = createTelegramExtension(
        () => null,
        () => null,
      );
      const status = ext.getStatus();
      expect(status).toEqual({
        online: false,
        username: "unknown",
        latencyMs: -1,
      });
    });

    it("should return online status with bot data", () => {
      const ext = createTelegramExtension(
        () => createMockBot({ username: "wopr_bot" }),
        () => createMockCtx(),
      );
      const status = ext.getStatus();
      expect(status).toEqual({
        online: true,
        username: "wopr_bot",
        latencyMs: -1,
      });
    });

    it("should return offline when botInfo is undefined", () => {
      const ext = createTelegramExtension(
        () => createMockBot({ hasBotInfo: false }),
        () => createMockCtx(),
      );
      const status = ext.getStatus();
      expect(status.online).toBe(false);
      expect(status.username).toBe("unknown");
    });
  });

  describe("listChats", () => {
    it("should return empty array when ctx is null", () => {
      const ext = createTelegramExtension(
        () => null,
        () => null,
      );
      expect(ext.listChats()).toEqual([]);
    });

    it("should return empty array when no telegram sessions exist", () => {
      const ext = createTelegramExtension(
        () => createMockBot(),
        () => createMockCtx(["discord:guild:#general", "cli:default"]),
      );
      expect(ext.listChats()).toEqual([]);
    });

    it("should parse DM sessions into chat info", () => {
      const ext = createTelegramExtension(
        () => createMockBot(),
        () => createMockCtx(["telegram-dm:12345"]),
      );
      const chats = ext.listChats();
      expect(chats).toEqual([
        { id: "12345", type: "dm", name: "DM 12345" },
      ]);
    });

    it("should parse group sessions into chat info", () => {
      const ext = createTelegramExtension(
        () => createMockBot(),
        () => createMockCtx(["telegram-group:-100123"]),
      );
      const chats = ext.listChats();
      expect(chats).toEqual([
        { id: "-100123", type: "group", name: "Group -100123" },
      ]);
    });

    it("should only include telegram sessions, not other channels", () => {
      const ext = createTelegramExtension(
        () => createMockBot(),
        () =>
          createMockCtx([
            "telegram-dm:111",
            "telegram-group:-200",
            "discord:guild:#general",
            "cli:default",
            "web:session1",
          ]),
      );
      const chats = ext.listChats();
      expect(chats).toHaveLength(2);
      expect(chats[0]).toEqual({ id: "111", type: "dm", name: "DM 111" });
      expect(chats[1]).toEqual({ id: "-200", type: "group", name: "Group -200" });
    });
  });

  describe("getMessageStats", () => {
    it("should return zeros when ctx is null", () => {
      const ext = createTelegramExtension(
        () => null,
        () => null,
      );
      const stats = ext.getMessageStats();
      expect(stats).toEqual({ sessionsActive: 0, activeConversations: 0 });
    });

    it("should count only telegram sessions", () => {
      const ext = createTelegramExtension(
        () => createMockBot(),
        () =>
          createMockCtx([
            "telegram-dm:111",
            "telegram-group:-200",
            "telegram-dm:222",
            "discord:guild:#general",
            "cli:default",
          ]),
      );
      const stats = ext.getMessageStats();
      expect(stats).toEqual({ sessionsActive: 3, activeConversations: 3 });
    });

    it("should return zero when no telegram sessions exist", () => {
      const ext = createTelegramExtension(
        () => createMockBot(),
        () => createMockCtx(["discord:guild:#general", "cli:default"]),
      );
      const stats = ext.getMessageStats();
      expect(stats).toEqual({ sessionsActive: 0, activeConversations: 0 });
    });
  });
});
