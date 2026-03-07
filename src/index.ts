/**
 * WOPR Telegram Plugin - Grammy-based Telegram Bot integration
 */

import crypto from "node:crypto";
import http from "node:http";
import { autoRetry } from "@grammyjs/auto-retry";
import type {
  AgentIdentity,
  ConfigSchema,
  PluginManifest,
  WOPRPlugin,
  WOPRPluginContext,
} from "@wopr-network/plugin-types";
import { Bot, webhookCallback } from "grammy";
import { resolveToken, sendMessage } from "./attachments.js";
import { clearRegistrations, createChannelProvider } from "./channel-provider.js";
import { botCommands, registerCallbackHandlers, registerCommandHandlers } from "./command-handlers.js";
import { initLogger } from "./logger.js";
import { handleMessage } from "./message-handler.js";
import { cancelAllStreams } from "./message-streaming.js";
import { createTelegramExtension } from "./telegram-extension.js";
import type { TelegramConfig } from "./types.js";

// Module-level state (single owner of mutable state)
let ctx: WOPRPluginContext | null = null;
let config: TelegramConfig = {};
let agentIdentity: AgentIdentity = { name: "WOPR", emoji: "👀" };
let bot: Bot | null = null;
let webhookServer: http.Server | null = null;
let logger = initLogger();
const cleanups: Array<() => void> = [];

// Getter functions for injection into modules
const getBot = () => bot;
const getLogger = () => logger;

// Config schema
const configSchema: ConfigSchema = {
  title: "Telegram Integration",
  description: "Configure Telegram Bot integration using Grammy",
  fields: [
    {
      name: "botToken",
      type: "password",
      label: "Bot Token",
      placeholder: "123456:ABC...",
      required: true,
      description: "Get from @BotFather on Telegram",
      secret: true,
      setupFlow: "paste",
    },
    {
      name: "tokenFile",
      type: "text",
      label: "Token File Path",
      placeholder: "/path/to/token.txt",
      description: "Alternative to inline token",
      setupFlow: "none",
    },
    {
      name: "dmPolicy",
      type: "select",
      label: "DM Policy",
      placeholder: "pairing",
      default: "pairing",
      description: "How to handle direct messages",
      setupFlow: "none",
    },
    {
      name: "allowFrom",
      type: "array",
      label: "Allowed User IDs",
      placeholder: "123456789, @username",
      description: "Telegram user IDs or usernames allowed to DM",
      setupFlow: "none",
    },
    {
      name: "groupPolicy",
      type: "select",
      label: "Group Policy",
      placeholder: "allowlist",
      default: "allowlist",
      description: "How to handle group messages",
      setupFlow: "none",
    },
    {
      name: "groupAllowFrom",
      type: "array",
      label: "Allowed Group Senders",
      placeholder: "123456789",
      description: "User IDs allowed to trigger in groups",
      setupFlow: "none",
    },
    {
      name: "mediaMaxMb",
      type: "number",
      label: "Media Max Size (MB)",
      placeholder: "5",
      default: 5,
      description: "Maximum attachment size",
      setupFlow: "none",
    },
    {
      name: "timeoutSeconds",
      type: "number",
      label: "API Timeout (seconds)",
      placeholder: "30",
      default: 30,
      description: "Timeout for Telegram API calls",
      setupFlow: "none",
    },
    {
      name: "webhookUrl",
      type: "text",
      label: "Webhook URL",
      placeholder: "https://example.com/webhook",
      description: "Optional: use webhook instead of polling",
      setupFlow: "none",
    },
    {
      name: "webhookPort",
      type: "number",
      label: "Webhook Port",
      placeholder: "3000",
      description: "Port for webhook server",
      setupFlow: "none",
    },
    {
      name: "maxRetries",
      type: "number",
      label: "Max Retries",
      placeholder: "3",
      default: 3,
      description: "Maximum number of retry attempts for failed API calls",
      setupFlow: "none",
    },
    {
      name: "retryMaxDelay",
      type: "number",
      label: "Retry Max Delay (seconds)",
      placeholder: "30",
      default: 30,
      description: "Maximum delay to wait for rate-limited retries",
      setupFlow: "none",
    },
    {
      name: "webhookPath",
      type: "text",
      label: "Webhook Path",
      placeholder: "/telegram",
      description: "URL path for webhook endpoint (default: /telegram)",
      setupFlow: "none",
    },
    {
      name: "webhookSecret",
      type: "password",
      label: "Webhook Secret",
      placeholder: "random-secret-string",
      description: "Secret token for validating webhook requests from Telegram",
      secret: true,
      setupFlow: "paste",
    },
    {
      name: "ackReaction",
      type: "text",
      label: "Acknowledgment Reaction",
      placeholder: "\u{1F440}",
      description:
        "Emoji reaction sent on incoming messages to acknowledge receipt (must be a standard Telegram reaction emoji)",
      setupFlow: "none",
    },
    {
      name: "ownerChatId",
      type: "text",
      label: "Owner Chat ID",
      placeholder: "123456789",
      description: "Telegram chat ID of the bot owner. Required for p2p friend request notifications.",
      setupFlow: "none",
    },
  ],
};

// Refresh identity
async function refreshIdentity(): Promise<void> {
  if (!ctx) return;
  try {
    const identity = await ctx.getAgentIdentity();
    if (identity) {
      agentIdentity = { ...agentIdentity, ...identity };
      logger.info("Identity refreshed:", agentIdentity.name);
    }
  } catch (error: unknown) {
    logger.warn("Failed to refresh identity:", String(error));
  }
}

// Start the bot in webhook mode
async function startWebhook(botInstance: Bot): Promise<void> {
  const webhookUrl = config.webhookUrl || "";
  const port = config.webhookPort || 3000;
  const webhookPath = config.webhookPath || "/telegram";
  let secret = config.webhookSecret;
  if (!secret) {
    secret = crypto.randomBytes(32).toString("hex");
    logger.warn(
      "webhookSecret not configured — auto-generated a random secret. " +
        "This secret will not persist across restarts. " +
        "Set webhookSecret in your plugin config for stable authentication.",
    );
  }

  // Initialize bot (fetch bot info) without starting polling
  await botInstance.init();

  // Create webhook handler using grammY's built-in adapter
  const handleUpdate = webhookCallback(botInstance, "http", {
    secretToken: secret,
  });

  // Create HTTP server
  const server = http.createServer((req, res) => {
    if (req.method === "POST" && req.url === webhookPath) {
      handleUpdate(req, res);
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  webhookServer = server;

  // Start listening
  await new Promise<void>((resolve, reject) => {
    server.listen(port, () => {
      logger.info(`Webhook server listening on port ${port} at path ${webhookPath}`);
      resolve();
    });
    server.once("error", reject);
  });

  // Register webhook with Telegram
  await botInstance.api.setWebhook(webhookUrl, {
    secret_token: secret,
  });

  logger.info(`Webhook registered with Telegram: ${webhookUrl}`);
}

// Start the bot
async function startBot(): Promise<void> {
  const token = resolveToken(config);

  bot = new Bot(token, {
    client: {
      timeoutSeconds: config.timeoutSeconds || 30,
    },
  });

  // Install auto-retry transformer for exponential backoff on failed API calls
  const maxRetryAttempts = config.maxRetries ?? 3;
  if (maxRetryAttempts > 0) {
    const maxDelaySeconds = config.retryMaxDelay ?? 30;
    bot.api.config.use(
      autoRetry({
        maxRetryAttempts,
        maxDelaySeconds,
        rethrowInternalServerErrors: false,
        rethrowHttpErrors: false,
      }),
    );
    logger.info(`Auto-retry enabled: maxRetryAttempts=${maxRetryAttempts}, maxDelaySeconds=${maxDelaySeconds}`);
  } else {
    logger.info("Auto-retry disabled (maxRetries=0)");
  }

  // Error handler
  bot.catch((err) => {
    logger.error("Telegram bot error:", err);
  });

  if (!ctx) {
    logger.error("Plugin context not initialized");
    return;
  }
  const currentCtx = ctx;

  // Register command handlers before the generic message handler
  registerCommandHandlers(bot, currentCtx, config, agentIdentity, logger);

  // Register inline keyboard callback query handlers
  registerCallbackHandlers(bot, currentCtx, config, agentIdentity, logger);

  // Register commands with BotFather for the "/" menu
  try {
    await bot.api.setMyCommands(botCommands);
    logger.info("Registered bot commands with BotFather");
  } catch (error: unknown) {
    logger.warn("Failed to register bot commands:", error);
  }

  // Message handler (catches non-command messages)
  const currentBot = bot;
  bot.on("message", async (grammyCtx) => {
    const currentCtxInner = ctx;
    if (!currentCtxInner) return;
    try {
      await handleMessage(grammyCtx, currentBot, currentCtxInner, config, agentIdentity, logger);
    } catch (error: unknown) {
      logger.error("Error handling Telegram message:", error);
    }
  });

  // Start bot
  if (config.webhookUrl) {
    // Webhook mode — fall back to polling on failure
    logger.info(`Starting Telegram bot with webhook: ${config.webhookUrl}`);
    try {
      await startWebhook(bot);
    } catch (error: unknown) {
      logger.error("Webhook setup failed, falling back to polling:", error);
      // Clean up partial webhook state
      if (webhookServer) {
        webhookServer.close();
        webhookServer = null;
      }
      try {
        await bot.api.deleteWebhook();
      } catch {
        // Ignore — may not have been set
      }
      await bot.start();
      logger.info("Telegram bot started in polling mode (fallback)");
      return;
    }
  } else {
    // Polling mode
    logger.info("Starting Telegram bot with polling...");
    await bot.start();
  }

  logger.info("Telegram bot started");
}

// Plugin manifest (WaaS metadata)
const manifest: PluginManifest = {
  name: "@wopr-network/wopr-plugin-telegram",
  version: "1.0.0",
  description: "Telegram Bot integration using Grammy",
  author: "TSavo",
  license: "MIT",
  repository: "https://github.com/wopr-network/wopr-plugin-telegram",
  capabilities: ["channel"],
  category: "channel",
  icon: "✈️",
  tags: ["telegram", "grammy", "bot", "channel"],
  provides: { capabilities: [] },
  lifecycle: { shutdownBehavior: "graceful" },
  requires: {
    env: ["TELEGRAM_BOT_TOKEN"],
    network: { outbound: true },
  },
  configSchema,
  setup: [
    {
      id: "bot-token",
      title: "Telegram Bot Token",
      description: "Get a bot token from @BotFather on Telegram and paste it here.",
      fields: {
        title: "Bot Token",
        fields: configSchema.fields.filter((f) => f.name === "botToken").slice(0, 1),
      },
    },
  ],
};

// Create the channel provider (singleton)
const telegramChannelProvider = createChannelProvider(getBot, getLogger, (b, l, chatId, text, opts) =>
  sendMessage(b, l, chatId, text, opts),
);

// Plugin definition
const plugin: WOPRPlugin = {
  name: "telegram",
  version: "1.0.0",
  description: "Telegram Bot integration using Grammy",
  manifest,

  async init(context: WOPRPluginContext): Promise<void> {
    ctx = context;
    config = (context.getConfig() || {}) as TelegramConfig;

    // Initialize logger
    logger = initLogger();

    // Register config schema
    if (ctx.registerConfigSchema) {
      ctx.registerConfigSchema("telegram", configSchema);
      cleanups.push(() => {
        if (ctx?.unregisterConfigSchema) {
          ctx.unregisterConfigSchema("telegram");
        }
      });
    }

    // Register as a channel provider so other plugins can add commands/parsers
    if (ctx.registerChannelProvider) {
      ctx.registerChannelProvider(telegramChannelProvider);
      logger.info("Registered Telegram channel provider");
      cleanups.push(() => {
        if (ctx?.unregisterChannelProvider) {
          ctx.unregisterChannelProvider("telegram");
        }
      });
    }

    // Register the Telegram extension so other plugins and daemon routes can access status
    if (ctx.registerExtension) {
      const extension = createTelegramExtension(
        () => bot,
        () => ctx,
        () => logger,
      );
      ctx.registerExtension("telegram", extension);
      logger.info("Registered Telegram extension");
      cleanups.push(() => {
        if (ctx?.unregisterExtension) {
          ctx.unregisterExtension("telegram");
        }
      });
    }

    // Refresh identity
    await refreshIdentity();

    // Validate config
    try {
      resolveToken(config);
    } catch (_error: unknown) {
      logger.warn("No Telegram bot token configured. Run 'wopr configure --plugin telegram' to set up.");
      return;
    }

    // Start bot
    try {
      await startBot();
    } catch (error: unknown) {
      logger.error("Failed to start Telegram bot:", error);
    }
  },

  async shutdown(): Promise<void> {
    if (!ctx) return;

    // Run all registered cleanups
    for (const cleanup of cleanups) {
      try {
        cleanup();
      } catch (error: unknown) {
        logger?.error("Cleanup error:", error);
      }
    }
    cleanups.length = 0;

    // Clear cross-plugin registrations to avoid stale entries on re-init
    clearRegistrations();

    // Cancel all active streams
    cancelAllStreams();

    // Close webhook server if running
    if (webhookServer) {
      logger.info("Stopping webhook server...");
      const server = webhookServer;
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
      webhookServer = null;
    }

    if (bot) {
      logger.info("Stopping Telegram bot...");
      // Delete webhook registration if we were in webhook mode
      if (config.webhookUrl) {
        try {
          await bot.api.deleteWebhook();
        } catch {
          // Ignore errors during shutdown
        }
      }
      await bot.stop();
      bot = null;
    }

    ctx = null;
  },
};

export {
  downloadTelegramFile,
  sendDocument,
  sendPhoto,
  validateTokenFilePath,
} from "./attachments.js";
export type { PendingFriendRequest } from "./friend-buttons.js";
export {
  buildFriendRequestKeyboard,
  cleanupExpiredFriendRequests,
  formatFriendRequestMessage,
  getPendingFriendRequest,
  isFriendRequestCallback,
  isValidEd25519Pubkey,
  parseFriendRequestCallback,
  removePendingFriendRequest,
  setMessageIdOnPendingFriendRequest,
  storePendingFriendRequest,
} from "./friend-buttons.js";
export { isStandardReaction, STANDARD_REACTIONS } from "./reactions.js";
export { telegramChannelProvider };
export {
  buildMainKeyboard,
  buildModelKeyboard,
  buildSessionKeyboard,
  CB_PREFIX,
  parseCallbackData,
} from "./keyboards.js";
export type {
  TelegramChatInfo,
  TelegramExtension,
  TelegramMessageStatsInfo,
  TelegramStatusInfo,
} from "./telegram-extension.js";
export { createTelegramExtension } from "./telegram-extension.js";
export type {
  AuthContext,
  WebMCPRegistry,
  WebMCPTool,
} from "./webmcp-telegram.js";
export { registerTelegramTools } from "./webmcp-telegram.js";
export default plugin;
