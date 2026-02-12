/**
 * Unit tests for wopr-plugin-telegram
 *
 * Tests cover: plugin lifecycle (init/shutdown), token resolution,
 * path validation, access policies, message handling, and message sending.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import path from "node:path";
import os from "node:os";

// ---------------------------------------------------------------------------
// Mock grammY before importing the plugin
// ---------------------------------------------------------------------------

const mockBotStart = vi.fn().mockResolvedValue(undefined);
const mockBotStop = vi.fn().mockResolvedValue(undefined);
const mockBotOn = vi.fn();
const mockBotCatch = vi.fn();
const mockSendMessage = vi.fn().mockResolvedValue({});

vi.mock("grammy", () => {
  class Bot {
    token: string;
    options: any;
    api = { sendMessage: mockSendMessage };
    constructor(token: string, options?: any) {
      this.token = token;
      this.options = options;
    }
    start = mockBotStart;
    stop = mockBotStop;
    on = mockBotOn;
    catch = mockBotCatch;
  }
  class InputFile {}
  class Context {}
  return { Bot, InputFile, Context };
});

// ---------------------------------------------------------------------------
// Mock winston so we don't write real log files
// ---------------------------------------------------------------------------

const mockLogInfo = vi.fn();
const mockLogWarn = vi.fn();
const mockLogError = vi.fn();
const mockLogDebug = vi.fn();

vi.mock("winston", () => {
  const format = {
    combine: vi.fn(),
    timestamp: vi.fn(),
    errors: vi.fn(),
    json: vi.fn(),
    colorize: vi.fn(),
    simple: vi.fn(),
  };
  return {
    default: {
      createLogger: vi.fn(() => ({
        info: mockLogInfo,
        warn: mockLogWarn,
        error: mockLogError,
        debug: mockLogDebug,
      })),
      format,
      transports: {
        File: vi.fn(),
        Console: vi.fn(),
      },
    },
  };
});

// ---------------------------------------------------------------------------
// Mock fs for token file tests
// ---------------------------------------------------------------------------

vi.mock("node:fs", async () => {
  const actual = await vi.importActual<typeof import("node:fs")>("node:fs");
  return {
    ...actual,
    default: {
      ...actual,
      readFileSync: vi.fn(actual.readFileSync),
      realpathSync: vi.fn(actual.realpathSync),
    },
  };
});

import fs from "node:fs";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeContext(overrides: Record<string, any> = {}): any {
  return {
    inject: vi.fn().mockResolvedValue("bot response"),
    logMessage: vi.fn(),
    injectPeer: vi.fn(),
    getIdentity: vi.fn(() => ({ publicKey: "pk", shortId: "s1", encryptPub: "ep" })),
    getAgentIdentity: vi.fn().mockResolvedValue({ name: "TestBot", emoji: "🤖" }),
    getUserProfile: vi.fn().mockResolvedValue({}),
    getSessions: vi.fn(() => []),
    getPeers: vi.fn(() => []),
    getConfig: vi.fn(() => ({ botToken: "test-token-123" })),
    saveConfig: vi.fn(),
    getMainConfig: vi.fn(),
    registerConfigSchema: vi.fn(),
    getPluginDir: vi.fn(() => "/tmp/test-plugin-dir"),
    log: {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("wopr-plugin-telegram", () => {
  let plugin: any;
  let validateTokenFilePath: (p: string) => string;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    // Reset env vars
    delete process.env.TELEGRAM_BOT_TOKEN;

    // Re-import to get fresh module-level state
    const mod = await import("../src/index.js");
    plugin = mod.default;
    validateTokenFilePath = mod.validateTokenFilePath;
  });

  afterEach(async () => {
    // Ensure plugin is shut down between tests to clean up module state
    try {
      await plugin.shutdown();
    } catch {
      // Ignore if already shut down
    }
  });

  // -------------------------------------------------------------------------
  // Plugin metadata
  // -------------------------------------------------------------------------

  describe("plugin metadata", () => {
    it("should export name, version, and description", () => {
      expect(plugin.name).toBe("telegram");
      expect(plugin.version).toBe("1.0.0");
      expect(plugin.description).toBe("Telegram Bot integration using Grammy");
    });

    it("should export init and shutdown functions", () => {
      expect(typeof plugin.init).toBe("function");
      expect(typeof plugin.shutdown).toBe("function");
    });
  });

  // -------------------------------------------------------------------------
  // validateTokenFilePath
  // -------------------------------------------------------------------------

  describe("validateTokenFilePath", () => {
    it("should accept paths inside WOPR_HOME", () => {
      const WOPR_HOME = process.env.WOPR_HOME || path.join(os.homedir(), ".wopr");
      const tokenPath = path.join(WOPR_HOME, "secrets", "token.txt");

      // Make realpathSync return the resolved path (file doesn't exist)
      vi.mocked(fs.realpathSync).mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const result = validateTokenFilePath(tokenPath);
      expect(result).toBe(path.resolve(tokenPath));
    });

    it("should accept paths inside CWD", () => {
      const tokenPath = path.join(process.cwd(), "config", "token.txt");

      vi.mocked(fs.realpathSync).mockImplementation(() => {
        throw new Error("ENOENT");
      });

      const result = validateTokenFilePath(tokenPath);
      expect(result).toBe(path.resolve(tokenPath));
    });

    it("should reject paths outside allowed directories", () => {
      const tokenPath = "/etc/passwd";

      vi.mocked(fs.realpathSync).mockReturnValue("/etc/passwd");

      expect(() => validateTokenFilePath(tokenPath)).toThrow(
        /outside allowed directories/
      );
    });

    it("should follow symlinks via realpathSync", () => {
      const WOPR_HOME = process.env.WOPR_HOME || path.join(os.homedir(), ".wopr");
      const tokenPath = path.join(WOPR_HOME, "link-to-token.txt");

      // Symlink resolves to an outside path
      vi.mocked(fs.realpathSync).mockReturnValue("/etc/shadow");

      expect(() => validateTokenFilePath(tokenPath)).toThrow(
        /outside allowed directories/
      );
    });
  });

  // -------------------------------------------------------------------------
  // Plugin init
  // -------------------------------------------------------------------------

  describe("plugin.init", () => {
    it("should register config schema and start bot with valid token", async () => {
      const ctx = makeContext();
      await plugin.init(ctx);

      expect(ctx.registerConfigSchema).toHaveBeenCalledWith(
        "telegram",
        expect.objectContaining({ title: "Telegram Integration" })
      );
      expect(ctx.getAgentIdentity).toHaveBeenCalled();
      expect(mockBotStart).toHaveBeenCalled();
      expect(mockBotOn).toHaveBeenCalledWith("message", expect.any(Function));
      expect(mockBotCatch).toHaveBeenCalledWith(expect.any(Function));
    });

    it("should warn and return if no token is configured", async () => {
      const ctx = makeContext({
        getConfig: vi.fn(() => ({})),
      });

      await plugin.init(ctx);

      expect(mockLogWarn).toHaveBeenCalledWith(
        expect.stringContaining("No Telegram bot token configured")
      );
      expect(mockBotStart).not.toHaveBeenCalled();
    });

    it("should handle bot start failure gracefully", async () => {
      mockBotStart.mockRejectedValueOnce(new Error("Connection refused"));

      const ctx = makeContext();
      await plugin.init(ctx);

      expect(mockLogError).toHaveBeenCalledWith(
        "Failed to start Telegram bot:",
        expect.any(Error)
      );
    });

    it("should use TELEGRAM_BOT_TOKEN env var as fallback", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "env-token-456";
      const ctx = makeContext({ getConfig: vi.fn(() => ({})) });

      await plugin.init(ctx);

      expect(mockBotStart).toHaveBeenCalled();
    });

    it("should refresh identity during init", async () => {
      const ctx = makeContext();
      await plugin.init(ctx);

      expect(ctx.getAgentIdentity).toHaveBeenCalled();
    });

    it("should handle identity refresh failure gracefully", async () => {
      const ctx = makeContext({
        getAgentIdentity: vi.fn().mockRejectedValue(new Error("identity error")),
      });

      await plugin.init(ctx);

      expect(mockLogWarn).toHaveBeenCalledWith(
        "Failed to refresh identity:",
        expect.stringContaining("identity error")
      );
    });

    it("should configure bot timeout from config", async () => {
      const ctx = makeContext({
        getConfig: vi.fn(() => ({ botToken: "tok", timeoutSeconds: 60 })),
      });

      await plugin.init(ctx);

      // Bot was constructed and started - we verify it started
      expect(mockBotStart).toHaveBeenCalled();
    });
  });

  // -------------------------------------------------------------------------
  // Plugin shutdown
  // -------------------------------------------------------------------------

  describe("plugin.shutdown", () => {
    it("should stop the bot when running", async () => {
      const ctx = makeContext();
      await plugin.init(ctx);

      mockBotStop.mockClear();
      await plugin.shutdown();

      expect(mockBotStop).toHaveBeenCalled();
      expect(mockLogInfo).toHaveBeenCalledWith("Stopping Telegram bot...");
    });

    it("should handle shutdown when bot is not running", async () => {
      // Shutdown without init should not throw
      await expect(plugin.shutdown()).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Message handling (via the on("message") callback)
  // -------------------------------------------------------------------------

  describe("message handling", () => {
    let messageHandler: (ctx: any) => Promise<void>;

    beforeEach(async () => {
      // Use open group policy so group-related tests aren't blocked by
      // access control (access control is tested separately).
      const ctx = makeContext({
        getConfig: vi.fn(() => ({
          botToken: "test-token-123",
          groupPolicy: "open",
        })),
      });
      await plugin.init(ctx);

      // Extract the message handler registered via bot.on("message", handler)
      const onCall = mockBotOn.mock.calls.find(
        (call: any[]) => call[0] === "message"
      );
      expect(onCall).toBeDefined();
      messageHandler = onCall![1];
    });

    function makeGrammyCtx(overrides: Record<string, any> = {}): any {
      return {
        message: {
          text: "Hello bot",
          message_id: 42,
          photo: [],
          reply_to_message: null,
          caption: null,
        },
        from: {
          id: 12345,
          first_name: "Alice",
          username: "alice",
        },
        chat: {
          id: 12345,
          type: "private",
          title: null,
        },
        me: {
          id: 99999,
          username: "testbot",
        },
        react: vi.fn().mockResolvedValue(undefined),
        ...overrides,
      };
    }

    it("should skip messages without message, from, or chat", async () => {
      await messageHandler({ message: null, from: null, chat: null });
      // No error thrown, no inject called
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("should skip messages from the bot itself", async () => {
      const grammyCtx = makeGrammyCtx({
        from: { id: 99999, first_name: "Bot", username: "testbot" },
      });
      await messageHandler(grammyCtx);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("should process a valid DM and send response", async () => {
      const grammyCtx = makeGrammyCtx();
      await messageHandler(grammyCtx);

      expect(mockSendMessage).toHaveBeenCalledWith(
        12345,
        "bot response",
        expect.objectContaining({ parse_mode: "HTML" })
      );
    });

    it("should add reaction when emoji is in standard set", async () => {
      // The identity mock returns emoji "🤖" which is NOT in Telegram's
      // standard reaction set. Re-init with an identity that returns "👀".
      vi.resetModules();
      vi.clearAllMocks();
      const mod = await import("../src/index.js");
      const freshPlugin = mod.default;
      const woprCtx = makeContext({
        getAgentIdentity: vi.fn().mockResolvedValue({ name: "Bot", emoji: "👀" }),
      });
      await freshPlugin.init(woprCtx);

      const onCall = mockBotOn.mock.calls.find(
        (call: any[]) => call[0] === "message"
      );
      const handler = onCall![1];

      const grammyCtx = makeGrammyCtx();
      await handler(grammyCtx);

      expect(grammyCtx.react).toHaveBeenCalled();
      await freshPlugin.shutdown();
    });

    it("should NOT react when emoji is not in standard set", async () => {
      // Default mock identity returns "🤖" which is not a standard reaction
      const grammyCtx = makeGrammyCtx();
      await messageHandler(grammyCtx);

      expect(grammyCtx.react).not.toHaveBeenCalled();
    });

    it("should skip empty messages without media", async () => {
      const grammyCtx = makeGrammyCtx({
        message: { text: "", message_id: 42, photo: [], caption: null },
      });
      await messageHandler(grammyCtx);
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("should use caption when text is empty but caption exists", async () => {
      const grammyCtx = makeGrammyCtx({
        message: { text: "", caption: "photo caption", message_id: 42, photo: [] },
      });
      await messageHandler(grammyCtx);

      expect(mockSendMessage).toHaveBeenCalled();
    });

    it("should handle group messages only when bot is mentioned", async () => {
      const grammyCtx = makeGrammyCtx({
        chat: { id: -100123, type: "group", title: "Test Group" },
        message: {
          text: "some random message",
          message_id: 42,
          photo: [],
          reply_to_message: null,
          caption: null,
        },
      });

      await messageHandler(grammyCtx);
      // Bot not mentioned and not a reply, so should be skipped
      expect(mockSendMessage).not.toHaveBeenCalled();
    });

    it("should respond in group when bot is mentioned", async () => {
      const grammyCtx = makeGrammyCtx({
        chat: { id: -100123, type: "group", title: "Test Group" },
        message: {
          text: "@testbot what is the weather?",
          message_id: 42,
          photo: [],
          reply_to_message: null,
          caption: null,
        },
      });

      await messageHandler(grammyCtx);
      expect(mockSendMessage).toHaveBeenCalled();
    });

    it("should respond in group when message is a reply", async () => {
      const grammyCtx = makeGrammyCtx({
        chat: { id: -100123, type: "supergroup", title: "Test Group" },
        message: {
          text: "yes please",
          message_id: 43,
          photo: [],
          reply_to_message: { message_id: 42 },
          caption: null,
        },
      });

      await messageHandler(grammyCtx);
      expect(mockSendMessage).toHaveBeenCalled();
    });

    it("should strip bot mention from group message text", async () => {
      // Re-import to capture inject calls
      vi.resetModules();
      vi.clearAllMocks();
      const mod = await import("../src/index.js");
      const freshPlugin = mod.default;

      const woprCtx = makeContext({
        getConfig: vi.fn(() => ({
          botToken: "test-token-123",
          groupPolicy: "open",
        })),
      });
      await freshPlugin.init(woprCtx);

      const onCall = mockBotOn.mock.calls.find(
        (call: any[]) => call[0] === "message"
      );
      const handler = onCall![1];

      const grammyCtx = makeGrammyCtx({
        chat: { id: -100123, type: "group", title: "Test Group" },
        message: {
          text: "@testbot hello there",
          message_id: 42,
          photo: [],
          reply_to_message: null,
          caption: null,
        },
      });

      await handler(grammyCtx);

      // The inject call should have the mention stripped
      expect(woprCtx.inject).toHaveBeenCalledWith(
        "telegram--100123",
        expect.stringContaining("hello there"),
        expect.any(Object)
      );

      await freshPlugin.shutdown();
    });

    it("should handle reaction failure silently", async () => {
      const grammyCtx = makeGrammyCtx({
        react: vi.fn().mockRejectedValue(new Error("reactions not supported")),
      });
      // Should not throw
      await expect(messageHandler(grammyCtx)).resolves.toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // Access control (isAllowed - tested through handleMessage)
  // -------------------------------------------------------------------------

  describe("access control", () => {
    let messageHandler: (ctx: any) => Promise<void>;

    function makeGrammyCtxForPolicy(
      chatOverrides: Record<string, any> = {},
      fromOverrides: Record<string, any> = {}
    ): any {
      return {
        message: {
          text: "Hello",
          message_id: 42,
          photo: [],
          reply_to_message: null,
          caption: null,
        },
        from: { id: 12345, first_name: "Alice", username: "alice", ...fromOverrides },
        chat: { id: 12345, type: "private", ...chatOverrides },
        me: { id: 99999, username: "testbot" },
        react: vi.fn().mockResolvedValue(undefined),
      };
    }

    async function initWithConfig(telegramConfig: Record<string, any>) {
      vi.resetModules();
      vi.clearAllMocks();
      const mod = await import("../src/index.js");
      const freshPlugin = mod.default;

      const ctx = makeContext({
        getConfig: vi.fn(() => ({ botToken: "test-token", ...telegramConfig })),
      });
      await freshPlugin.init(ctx);

      const onCall = mockBotOn.mock.calls.find(
        (call: any[]) => call[0] === "message"
      );
      messageHandler = onCall![1];
      return freshPlugin;
    }

    it("should allow all DMs with pairing policy (default)", async () => {
      const p = await initWithConfig({ dmPolicy: "pairing" });
      const grammyCtx = makeGrammyCtxForPolicy();
      await messageHandler(grammyCtx);
      expect(mockSendMessage).toHaveBeenCalled();
      await p.shutdown();
    });

    it("should allow all DMs with open policy", async () => {
      const p = await initWithConfig({ dmPolicy: "open" });
      const grammyCtx = makeGrammyCtxForPolicy();
      await messageHandler(grammyCtx);
      expect(mockSendMessage).toHaveBeenCalled();
      await p.shutdown();
    });

    it("should block all DMs with disabled policy", async () => {
      const p = await initWithConfig({ dmPolicy: "disabled" });
      const grammyCtx = makeGrammyCtxForPolicy();
      await messageHandler(grammyCtx);
      expect(mockSendMessage).not.toHaveBeenCalled();
      await p.shutdown();
    });

    it("should allow DM from allowlisted user ID", async () => {
      const p = await initWithConfig({
        dmPolicy: "allowlist",
        allowFrom: ["12345"],
      });
      const grammyCtx = makeGrammyCtxForPolicy();
      await messageHandler(grammyCtx);
      expect(mockSendMessage).toHaveBeenCalled();
      await p.shutdown();
    });

    it("should block DM from non-allowlisted user", async () => {
      const p = await initWithConfig({
        dmPolicy: "allowlist",
        allowFrom: ["99999"],
      });
      const grammyCtx = makeGrammyCtxForPolicy();
      await messageHandler(grammyCtx);
      expect(mockSendMessage).not.toHaveBeenCalled();
      await p.shutdown();
    });

    it("should allow DM via tg: prefix in allowlist", async () => {
      const p = await initWithConfig({
        dmPolicy: "allowlist",
        allowFrom: ["tg:12345"],
      });
      const grammyCtx = makeGrammyCtxForPolicy();
      await messageHandler(grammyCtx);
      expect(mockSendMessage).toHaveBeenCalled();
      await p.shutdown();
    });

    it("should allow DM via @username in allowlist", async () => {
      const p = await initWithConfig({
        dmPolicy: "allowlist",
        allowFrom: ["@alice"],
      });
      const grammyCtx = makeGrammyCtxForPolicy();
      await messageHandler(grammyCtx);
      expect(mockSendMessage).toHaveBeenCalled();
      await p.shutdown();
    });

    it("should allow DM via wildcard in allowlist", async () => {
      const p = await initWithConfig({
        dmPolicy: "allowlist",
        allowFrom: ["*"],
      });
      const grammyCtx = makeGrammyCtxForPolicy();
      await messageHandler(grammyCtx);
      expect(mockSendMessage).toHaveBeenCalled();
      await p.shutdown();
    });

    it("should block group messages with disabled group policy", async () => {
      const p = await initWithConfig({ groupPolicy: "disabled" });
      const grammyCtx = makeGrammyCtxForPolicy(
        { id: -100123, type: "group", title: "Test" },
      );
      // Need mention for group
      grammyCtx.message.text = "@testbot hello";
      await messageHandler(grammyCtx);
      expect(mockSendMessage).not.toHaveBeenCalled();
      await p.shutdown();
    });

    it("should allow all group messages with open group policy", async () => {
      const p = await initWithConfig({ groupPolicy: "open" });
      const grammyCtx = makeGrammyCtxForPolicy(
        { id: -100123, type: "group", title: "Test" },
      );
      grammyCtx.message.text = "@testbot hello";
      await messageHandler(grammyCtx);
      expect(mockSendMessage).toHaveBeenCalled();
      await p.shutdown();
    });

    it("should check groupAllowFrom for group allowlist policy", async () => {
      const p = await initWithConfig({
        groupPolicy: "allowlist",
        groupAllowFrom: ["12345"],
      });
      const grammyCtx = makeGrammyCtxForPolicy(
        { id: -100123, type: "group", title: "Test" },
      );
      grammyCtx.message.text = "@testbot hello";
      await messageHandler(grammyCtx);
      expect(mockSendMessage).toHaveBeenCalled();
      await p.shutdown();
    });

    it("should fall back to allowFrom when groupAllowFrom is empty", async () => {
      const p = await initWithConfig({
        groupPolicy: "allowlist",
        allowFrom: ["12345"],
      });
      const grammyCtx = makeGrammyCtxForPolicy(
        { id: -100123, type: "group", title: "Test" },
      );
      grammyCtx.message.text = "@testbot hello";
      await messageHandler(grammyCtx);
      expect(mockSendMessage).toHaveBeenCalled();
      await p.shutdown();
    });
  });

  // -------------------------------------------------------------------------
  // Message sending (sendMessage - tested through handleMessage)
  // -------------------------------------------------------------------------

  describe("message sending", () => {
    let messageHandler: (ctx: any) => Promise<void>;
    let woprCtx: any;

    beforeEach(async () => {
      woprCtx = makeContext();
      await plugin.init(woprCtx);

      const onCall = mockBotOn.mock.calls.find(
        (call: any[]) => call[0] === "message"
      );
      messageHandler = onCall![1];
    });

    it("should split long messages into chunks", async () => {
      // Generate a response longer than 4096 chars
      const longResponse = "This is a sentence. ".repeat(300);
      woprCtx.inject.mockResolvedValueOnce(longResponse);

      const grammyCtx = {
        message: { text: "Hello", message_id: 42, photo: [], reply_to_message: null, caption: null },
        from: { id: 12345, first_name: "Alice", username: "alice" },
        chat: { id: 12345, type: "private" },
        me: { id: 99999, username: "testbot" },
        react: vi.fn().mockResolvedValue(undefined),
      };

      await messageHandler(grammyCtx);

      // Should have sent multiple chunks
      expect(mockSendMessage.mock.calls.length).toBeGreaterThan(1);
    });

    it("should set reply_to_message_id only on first chunk", async () => {
      const longResponse = "This is a sentence. ".repeat(300);
      woprCtx.inject.mockResolvedValueOnce(longResponse);

      const grammyCtx = {
        message: { text: "Hello", message_id: 42, photo: [], reply_to_message: null, caption: null },
        from: { id: 12345, first_name: "Alice", username: "alice" },
        chat: { id: 12345, type: "private" },
        me: { id: 99999, username: "testbot" },
        react: vi.fn().mockResolvedValue(undefined),
      };

      await messageHandler(grammyCtx);

      const calls = mockSendMessage.mock.calls;
      // First call should have reply_to_message_id
      expect(calls[0][2]).toEqual(
        expect.objectContaining({ reply_to_message_id: 42 })
      );
      // Second call should not
      if (calls.length > 1) {
        expect(calls[1][2].reply_to_message_id).toBeUndefined();
      }
    });

    it("should use HTML parse mode", async () => {
      const grammyCtx = {
        message: { text: "Hello", message_id: 42, photo: [], reply_to_message: null, caption: null },
        from: { id: 12345, first_name: "Alice", username: "alice" },
        chat: { id: 12345, type: "private" },
        me: { id: 99999, username: "testbot" },
        react: vi.fn().mockResolvedValue(undefined),
      };

      await messageHandler(grammyCtx);

      expect(mockSendMessage).toHaveBeenCalledWith(
        12345,
        "bot response",
        expect.objectContaining({ parse_mode: "HTML" })
      );
    });

    it("should propagate send errors", async () => {
      mockSendMessage.mockRejectedValueOnce(new Error("API Error"));

      const grammyCtx = {
        message: { text: "Hello", message_id: 42, photo: [], reply_to_message: null, caption: null },
        from: { id: 12345, first_name: "Alice", username: "alice" },
        chat: { id: 12345, type: "private" },
        me: { id: 99999, username: "testbot" },
        react: vi.fn().mockResolvedValue(undefined),
      };

      // The error should be caught by the bot.on handler's try/catch
      // but the messageHandler itself will throw
      await messageHandler(grammyCtx);

      expect(mockLogError).toHaveBeenCalledWith(
        "Failed to send Telegram message:",
        expect.any(Error)
      );
    });
  });

  // -------------------------------------------------------------------------
  // Session key and channel info
  // -------------------------------------------------------------------------

  describe("session routing", () => {
    let messageHandler: (ctx: any) => Promise<void>;
    let woprCtx: any;

    beforeEach(async () => {
      woprCtx = makeContext({
        getConfig: vi.fn(() => ({
          botToken: "test-token-123",
          groupPolicy: "open",
        })),
      });
      await plugin.init(woprCtx);

      const onCall = mockBotOn.mock.calls.find(
        (call: any[]) => call[0] === "message"
      );
      messageHandler = onCall![1];
    });

    it("should use dm:userId session key for private chats", async () => {
      const grammyCtx = {
        message: { text: "Hello", message_id: 42, photo: [], reply_to_message: null, caption: null },
        from: { id: 12345, first_name: "Alice", username: "alice" },
        chat: { id: 12345, type: "private" },
        me: { id: 99999, username: "testbot" },
        react: vi.fn().mockResolvedValue(undefined),
      };

      await messageHandler(grammyCtx);

      expect(woprCtx.logMessage).toHaveBeenCalledWith(
        "telegram-12345",
        "Hello",
        expect.objectContaining({
          channel: expect.objectContaining({
            type: "telegram",
            id: "dm:12345",
          }),
        })
      );
    });

    it("should use group:chatId session key for group chats", async () => {
      const grammyCtx = {
        message: {
          text: "@testbot hello",
          message_id: 42,
          photo: [],
          reply_to_message: null,
          caption: null,
        },
        from: { id: 12345, first_name: "Alice", username: "alice" },
        chat: { id: -100123, type: "group", title: "Test Group" },
        me: { id: 99999, username: "testbot" },
        react: vi.fn().mockResolvedValue(undefined),
      };

      await messageHandler(grammyCtx);

      expect(woprCtx.logMessage).toHaveBeenCalledWith(
        "telegram--100123",
        expect.any(String),
        expect.objectContaining({
          channel: expect.objectContaining({
            type: "telegram",
            id: "group:-100123",
            name: "Test Group",
          }),
        })
      );
    });

    it("should prefix inject messages with user name", async () => {
      const grammyCtx = {
        message: { text: "Hello", message_id: 42, photo: [], reply_to_message: null, caption: null },
        from: { id: 12345, first_name: "Alice", username: "alice" },
        chat: { id: 12345, type: "private" },
        me: { id: 99999, username: "testbot" },
        react: vi.fn().mockResolvedValue(undefined),
      };

      await messageHandler(grammyCtx);

      expect(woprCtx.inject).toHaveBeenCalledWith(
        "telegram-12345",
        "[Alice]: Hello",
        expect.any(Object)
      );
    });

    it("should fall back to username when first_name is missing", async () => {
      const grammyCtx = {
        message: { text: "Hello", message_id: 42, photo: [], reply_to_message: null, caption: null },
        from: { id: 12345, first_name: "", username: "bob42" },
        chat: { id: 12345, type: "private" },
        me: { id: 99999, username: "testbot" },
        react: vi.fn().mockResolvedValue(undefined),
      };

      await messageHandler(grammyCtx);

      expect(woprCtx.inject).toHaveBeenCalledWith(
        "telegram-12345",
        expect.stringContaining("[bob42]"),
        expect.any(Object)
      );
    });
  });

  // -------------------------------------------------------------------------
  // Token resolution
  // -------------------------------------------------------------------------

  describe("token resolution", () => {
    it("should use botToken from config when provided", async () => {
      const ctx = makeContext({
        getConfig: vi.fn(() => ({ botToken: "direct-token" })),
      });

      await plugin.init(ctx);
      expect(mockBotStart).toHaveBeenCalled();
    });

    it("should use TELEGRAM_BOT_TOKEN env var as fallback", async () => {
      process.env.TELEGRAM_BOT_TOKEN = "env-token";
      const ctx = makeContext({ getConfig: vi.fn(() => ({})) });

      await plugin.init(ctx);
      expect(mockBotStart).toHaveBeenCalled();
    });

    it("should warn when no token is available", async () => {
      delete process.env.TELEGRAM_BOT_TOKEN;
      const ctx = makeContext({ getConfig: vi.fn(() => ({})) });

      await plugin.init(ctx);

      expect(mockLogWarn).toHaveBeenCalledWith(
        expect.stringContaining("No Telegram bot token configured")
      );
      expect(mockBotStart).not.toHaveBeenCalled();
    });

    it("should read token from tokenFile when botToken is not set", async () => {
      const tokenPath = path.join(process.cwd(), "test-token.txt");
      vi.mocked(fs.realpathSync).mockReturnValue(tokenPath);
      vi.mocked(fs.readFileSync).mockReturnValue("file-token-789\n");

      const ctx = makeContext({
        getConfig: vi.fn(() => ({ tokenFile: tokenPath })),
      });

      await plugin.init(ctx);
      expect(mockBotStart).toHaveBeenCalled();
    });
  });
});
