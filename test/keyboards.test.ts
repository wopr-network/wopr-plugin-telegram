/**
 * Unit tests for inline keyboard builders and callback query handling.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// ---------------------------------------------------------------------------
// Mock grammY before importing the plugin
// ---------------------------------------------------------------------------

const mockBotStart = vi.fn().mockResolvedValue(undefined);
const mockBotStop = vi.fn().mockResolvedValue(undefined);
const mockBotOn = vi.fn();
const mockBotCatch = vi.fn();
const mockBotCommand = vi.fn();
const mockSendMessage = vi.fn().mockResolvedValue({ message_id: 1 });
const mockSetMyCommands = vi.fn().mockResolvedValue(undefined);
const mockDeleteWebhook = vi.fn().mockResolvedValue(undefined);
const mockSendChatAction = vi.fn().mockResolvedValue(undefined);
const mockEditMessageText = vi.fn().mockResolvedValue(undefined);
const mockConfigUse = vi.fn();

// Track InlineKeyboard instances created
const inlineKeyboardInstances: any[] = [];

vi.mock("grammy", () => {
  class Bot {
    token: string;
    options: any;
    api = {
      sendMessage: mockSendMessage,
      setMyCommands: mockSetMyCommands,
      deleteWebhook: mockDeleteWebhook,
      sendChatAction: mockSendChatAction,
      editMessageText: mockEditMessageText,
      config: { use: mockConfigUse },
    };
    constructor(token: string, options?: any) {
      this.token = token;
      this.options = options;
    }
    start = mockBotStart;
    stop = mockBotStop;
    on = mockBotOn;
    catch = mockBotCatch;
    command = mockBotCommand;
  }
  class InlineKeyboard {
    private buttons: { text: string; callback_data: string }[][] = [[]];
    text(label: string, data: string) {
      this.buttons[this.buttons.length - 1].push({ text: label, callback_data: data });
      return this;
    }
    row() {
      this.buttons.push([]);
      return this;
    }
    // Expose for testing
    get inline_keyboard() {
      return this.buttons.filter((r) => r.length > 0);
    }
  }
  class InputFile {}
  class Context {}
  function webhookCallback() { return vi.fn(); }
  return { Bot, InlineKeyboard, InputFile, Context, webhookCallback };
});

vi.mock("@grammyjs/auto-retry", () => ({
  autoRetry: vi.fn(() => vi.fn()),
}));

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
    getSessions: vi.fn(() => ["telegram-dm:12345", "telegram-group:-100123"]),
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
// Tests: keyboards module (pure functions)
// ---------------------------------------------------------------------------

describe("keyboards module", () => {
  let buildMainKeyboard: any;
  let buildModelKeyboard: any;
  let buildSessionKeyboard: any;
  let parseCallbackData: any;
  let CB_PREFIX: any;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();
    const mod = await import("../src/keyboards.js");
    buildMainKeyboard = mod.buildMainKeyboard;
    buildModelKeyboard = mod.buildModelKeyboard;
    buildSessionKeyboard = mod.buildSessionKeyboard;
    parseCallbackData = mod.parseCallbackData;
    CB_PREFIX = mod.CB_PREFIX;
  });

  describe("CB_PREFIX constants", () => {
    it("should define expected callback prefixes", () => {
      expect(CB_PREFIX.HELP).toBe("help");
      expect(CB_PREFIX.MODEL_SWITCH).toBe("model:");
      expect(CB_PREFIX.MODEL_LIST).toBe("model_list");
      expect(CB_PREFIX.SESSION_NEW).toBe("session_new");
      expect(CB_PREFIX.SESSION_SWITCH).toBe("session:");
      expect(CB_PREFIX.STATUS).toBe("status");
    });
  });

  describe("buildMainKeyboard", () => {
    it("should return an InlineKeyboard with 4 buttons", () => {
      const kb = buildMainKeyboard();
      const rows = kb.inline_keyboard;
      // 2 rows: [Switch Model, New Session], [Status, Help]
      expect(rows.length).toBe(2);
      expect(rows[0].length).toBe(2);
      expect(rows[1].length).toBe(2);
    });

    it("should have correct callback data on buttons", () => {
      const kb = buildMainKeyboard();
      const rows = kb.inline_keyboard;
      expect(rows[0][0].callback_data).toBe("model_list");
      expect(rows[0][1].callback_data).toBe("session_new");
      expect(rows[1][0].callback_data).toBe("status");
      expect(rows[1][1].callback_data).toBe("help");
    });

    it("should have human-readable labels", () => {
      const kb = buildMainKeyboard();
      const rows = kb.inline_keyboard;
      expect(rows[0][0].text).toBe("Switch Model");
      expect(rows[0][1].text).toBe("New Session");
      expect(rows[1][0].text).toBe("Status");
      expect(rows[1][1].text).toBe("Help");
    });
  });

  describe("buildModelKeyboard", () => {
    it("should create a button for each model", () => {
      const kb = buildModelKeyboard(["opus", "sonnet", "haiku"]);
      const rows = kb.inline_keyboard;
      const allButtons = rows.flat();
      expect(allButtons.length).toBe(3);
      expect(allButtons[0].text).toBe("opus");
      expect(allButtons[0].callback_data).toBe("model:opus");
      expect(allButtons[1].text).toBe("sonnet");
      expect(allButtons[2].text).toBe("haiku");
    });

    it("should handle empty model list", () => {
      const kb = buildModelKeyboard([]);
      const rows = kb.inline_keyboard;
      // No buttons at all
      const allButtons = rows.flat();
      expect(allButtons.length).toBe(0);
    });

    it("should lay out models in rows of 2", () => {
      const kb = buildModelKeyboard(["a", "b", "c", "d", "e"]);
      const rows = kb.inline_keyboard;
      // a,b in row 1; c,d in row 2; e in row 3
      expect(rows[0].length).toBe(2);
      expect(rows[1].length).toBe(2);
      expect(rows[2].length).toBe(1);
    });
  });

  describe("buildSessionKeyboard", () => {
    it("should create a button for each session", () => {
      const sessions = ["telegram-dm:12345", "telegram-group:-100123"];
      const kb = buildSessionKeyboard(sessions);
      const rows = kb.inline_keyboard;
      const allButtons = rows.flat();
      expect(allButtons.length).toBe(2);
      expect(allButtons[0].callback_data).toBe("session:telegram-dm:12345");
      expect(allButtons[1].callback_data).toBe("session:telegram-group:-100123");
    });

    it("should strip telegram prefix from label", () => {
      const kb = buildSessionKeyboard(["telegram-dm:12345"]);
      const rows = kb.inline_keyboard;
      expect(rows[0][0].text).toBe("12345");
    });

    it("should handle empty session list", () => {
      const kb = buildSessionKeyboard([]);
      const rows = kb.inline_keyboard;
      const allButtons = rows.flat();
      expect(allButtons.length).toBe(0);
    });
  });

  describe("parseCallbackData", () => {
    it("should parse help action", () => {
      expect(parseCallbackData("help")).toEqual({ type: "help" });
    });

    it("should parse model_list action", () => {
      expect(parseCallbackData("model_list")).toEqual({ type: "model_list" });
    });

    it("should parse model switch with model name", () => {
      expect(parseCallbackData("model:opus")).toEqual({
        type: "model_switch",
        model: "opus",
      });
    });

    it("should parse session_new action", () => {
      expect(parseCallbackData("session_new")).toEqual({ type: "session_new" });
    });

    it("should parse session_list action", () => {
      expect(parseCallbackData("session_list")).toEqual({ type: "session_list" });
    });

    it("should parse session switch with session key", () => {
      expect(parseCallbackData("session:telegram-dm:12345")).toEqual({
        type: "session_switch",
        session: "telegram-dm:12345",
      });
    });

    it("should parse status action", () => {
      expect(parseCallbackData("status")).toEqual({ type: "status" });
    });

    it("should return unknown for unrecognized data", () => {
      expect(parseCallbackData("foobar")).toEqual({
        type: "unknown",
        raw: "foobar",
      });
    });

    it("should return unknown for empty string", () => {
      expect(parseCallbackData("")).toEqual({
        type: "unknown",
        raw: "",
      });
    });
  });
});

// ---------------------------------------------------------------------------
// Tests: callback query integration (via bot.on("callback_query:data"))
// ---------------------------------------------------------------------------

describe("callback query handling", () => {
  let plugin: any;
  let callbackHandler: (ctx: any) => Promise<void>;
  let woprCtx: any;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    const mod = await import("../src/index.js");
    plugin = mod.default;

    woprCtx = makeContext();
    await plugin.init(woprCtx);

    // Extract the callback handler registered via bot.on("callback_query:data", handler)
    const onCall = mockBotOn.mock.calls.find(
      (call: any[]) => call[0] === "callback_query:data"
    );
    expect(onCall).toBeDefined();
    callbackHandler = onCall![1];
  });

  afterEach(async () => {
    try {
      await plugin.shutdown();
    } catch {
      // Ignore
    }
  });

  function makeCallbackCtx(data: string, overrides: Record<string, any> = {}): any {
    return {
      callbackQuery: {
        data,
        message: {
          chat: { id: 12345, type: "private" },
          message_id: 100,
        },
      },
      from: { id: 12345, first_name: "Alice", username: "alice" },
      answerCallbackQuery: vi.fn().mockResolvedValue(undefined),
      ...overrides,
    };
  }

  it("should register a callback_query:data handler", () => {
    const onCall = mockBotOn.mock.calls.find(
      (call: any[]) => call[0] === "callback_query:data"
    );
    expect(onCall).toBeDefined();
  });

  it("should answer callback query for help action", async () => {
    const cbCtx = makeCallbackCtx("help");
    await callbackHandler(cbCtx);
    expect(cbCtx.answerCallbackQuery).toHaveBeenCalled();
    // Should send help message
    expect(mockSendMessage).toHaveBeenCalledWith(
      12345,
      expect.stringContaining("WOPR Telegram Commands"),
      expect.objectContaining({ reply_markup: expect.anything() })
    );
  });

  it("should answer callback query for model_list action", async () => {
    const cbCtx = makeCallbackCtx("model_list");
    await callbackHandler(cbCtx);
    expect(cbCtx.answerCallbackQuery).toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      12345,
      expect.stringContaining("Select a model"),
      expect.objectContaining({ reply_markup: expect.anything() })
    );
  });

  it("should answer callback query for model switch", async () => {
    const cbCtx = makeCallbackCtx("model:opus");
    await callbackHandler(cbCtx);
    expect(cbCtx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "Switching to opus...",
    });
    expect(woprCtx.inject).toHaveBeenCalledWith(
      "telegram-dm:12345",
      "[Alice]: /model opus",
      expect.any(Object)
    );
  });

  it("should answer callback query for session_new", async () => {
    const cbCtx = makeCallbackCtx("session_new");
    await callbackHandler(cbCtx);
    expect(cbCtx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "Starting new session...",
    });
    // Should inject to a new session name
    expect(woprCtx.inject).toHaveBeenCalledWith(
      expect.stringContaining("telegram-"),
      expect.stringContaining("/session"),
      expect.any(Object)
    );
  });

  it("should answer callback query for status action", async () => {
    const cbCtx = makeCallbackCtx("status");
    await callbackHandler(cbCtx);
    expect(cbCtx.answerCallbackQuery).toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      12345,
      expect.stringContaining("Session Status"),
      expect.objectContaining({ reply_markup: expect.anything() })
    );
  });

  it("should answer callback query for session switch", async () => {
    const cbCtx = makeCallbackCtx("session:telegram-dm:12345");
    await callbackHandler(cbCtx);
    expect(cbCtx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "Switching session...",
    });
    expect(woprCtx.inject).toHaveBeenCalledWith(
      "telegram-dm:12345",
      expect.stringContaining("/session telegram-dm:12345"),
      expect.any(Object)
    );
  });

  it("should answer callback query for unknown action", async () => {
    const cbCtx = makeCallbackCtx("garbage_data");
    await callbackHandler(cbCtx);
    expect(cbCtx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "Unknown action.",
    });
  });

  it("should handle missing chat in callback query", async () => {
    const cbCtx = makeCallbackCtx("help", {
      callbackQuery: {
        data: "help",
        message: undefined,
      },
    });
    await callbackHandler(cbCtx);
    expect(cbCtx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "Bot is not ready.",
    });
  });

  it("should block unauthorized users in callback queries", async () => {
    // Re-init with allowlist policy
    vi.resetModules();
    vi.clearAllMocks();
    const mod = await import("../src/index.js");
    const freshPlugin = mod.default;
    const ctx = makeContext({
      getConfig: vi.fn(() => ({
        botToken: "test-token",
        dmPolicy: "allowlist",
        allowFrom: ["99999"], // Not user 12345
      })),
    });
    await freshPlugin.init(ctx);

    const onCall = mockBotOn.mock.calls.find(
      (call: any[]) => call[0] === "callback_query:data"
    );
    const handler = onCall![1];

    const cbCtx = makeCallbackCtx("help");
    await handler(cbCtx);
    expect(cbCtx.answerCallbackQuery).toHaveBeenCalledWith({
      text: "Not authorized.",
    });
    expect(mockSendMessage).not.toHaveBeenCalled();
    await freshPlugin.shutdown();
  });

  it("should handle inject error during model switch gracefully", async () => {
    woprCtx.inject.mockRejectedValueOnce(new Error("inject failed"));
    const cbCtx = makeCallbackCtx("model:opus");
    await callbackHandler(cbCtx);
    expect(cbCtx.answerCallbackQuery).toHaveBeenCalled();
    expect(mockSendMessage).toHaveBeenCalledWith(
      12345,
      expect.stringContaining("Failed to switch model"),
      expect.any(Object)
    );
  });

  it("should handle inject error during new session gracefully", async () => {
    woprCtx.inject.mockRejectedValueOnce(new Error("inject failed"));
    const cbCtx = makeCallbackCtx("session_new");
    await callbackHandler(cbCtx);
    expect(mockSendMessage).toHaveBeenCalledWith(
      12345,
      "Failed to create new session.",
      expect.any(Object)
    );
  });

  it("should include main keyboard in status response", async () => {
    const cbCtx = makeCallbackCtx("status");
    await callbackHandler(cbCtx);
    const call = mockSendMessage.mock.calls[0];
    expect(call[2]).toHaveProperty("reply_markup");
  });
});

// ---------------------------------------------------------------------------
// Tests: /help and /status commands include inline keyboard
// ---------------------------------------------------------------------------

describe("commands with inline keyboards", () => {
  let plugin: any;
  let woprCtx: any;

  beforeEach(async () => {
    vi.resetModules();
    vi.clearAllMocks();

    const mod = await import("../src/index.js");
    plugin = mod.default;
    woprCtx = makeContext();
    await plugin.init(woprCtx);
  });

  afterEach(async () => {
    try {
      await plugin.shutdown();
    } catch {
      // Ignore
    }
  });

  it("/help command should include inline keyboard", async () => {
    const helpCall = mockBotCommand.mock.calls.find(
      (call: any[]) => call[0] === "help"
    );
    expect(helpCall).toBeDefined();

    const handler = helpCall![1];
    const grammyCtx = {
      chat: { id: 12345, type: "private" },
      from: { id: 12345, first_name: "Alice", username: "alice" },
      message: { message_id: 42 },
      me: { id: 99999, username: "testbot" },
    };
    await handler(grammyCtx);

    expect(mockSendMessage).toHaveBeenCalledWith(
      12345,
      expect.stringContaining("WOPR Telegram Commands"),
      expect.objectContaining({ reply_markup: expect.anything() })
    );
  });

  it("/status command should include inline keyboard", async () => {
    const statusCall = mockBotCommand.mock.calls.find(
      (call: any[]) => call[0] === "status"
    );
    expect(statusCall).toBeDefined();

    const handler = statusCall![1];
    const grammyCtx = {
      chat: { id: 12345, type: "private" },
      from: { id: 12345, first_name: "Alice", username: "alice" },
      message: { message_id: 42 },
      me: { id: 99999, username: "testbot" },
    };
    await handler(grammyCtx);

    expect(mockSendMessage).toHaveBeenCalledWith(
      12345,
      expect.stringContaining("Session Status"),
      expect.objectContaining({ reply_markup: expect.anything() })
    );
  });
});
