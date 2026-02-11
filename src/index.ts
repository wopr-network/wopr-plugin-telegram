/**
 * WOPR Telegram Plugin - Grammy-based Telegram Bot integration
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import winston from "winston";
import { Bot, Context, InputFile } from "grammy";
import type {
  WOPRPlugin,
  WOPRPluginContext,
  ConfigSchema,
  StreamMessage,
  AgentIdentity,
  ChannelInfo,
  LogMessageOptions,
} from "./types.js";

// Telegram config interface
interface TelegramConfig {
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
}

// Module-level state
let ctx: WOPRPluginContext | null = null;
let config: TelegramConfig = {};
let agentIdentity: AgentIdentity = { name: "WOPR", emoji: "👀" };
let bot: Bot | null = null;
let isShuttingDown = false;
let logger: winston.Logger;

// Initialize winston logger
function initLogger(): winston.Logger {
  const WOPR_HOME = process.env.WOPR_HOME || path.join(process.env.HOME || "~", ".wopr");
  return winston.createLogger({
    level: "debug",
    format: winston.format.combine(
      winston.format.timestamp(),
      winston.format.errors({ stack: true }),
      winston.format.json()
    ),
    defaultMeta: { service: "wopr-plugin-telegram" },
    transports: [
      new winston.transports.File({
        filename: path.join(WOPR_HOME, "logs", "telegram-plugin-error.log"),
        level: "error",
      }),
      new winston.transports.File({
        filename: path.join(WOPR_HOME, "logs", "telegram-plugin.log"),
        level: "debug",
      }),
      new winston.transports.Console({
        format: winston.format.combine(
          winston.format.colorize(),
          winston.format.simple()
        ),
        level: "warn",
      }),
    ],
  });
}

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
    },
    {
      name: "tokenFile",
      type: "text",
      label: "Token File Path",
      placeholder: "/path/to/token.txt",
      description: "Alternative to inline token",
    },
    {
      name: "dmPolicy",
      type: "select",
      label: "DM Policy",
      placeholder: "pairing",
      default: "pairing",
      description: "How to handle direct messages",
    },
    {
      name: "allowFrom",
      type: "array",
      label: "Allowed User IDs",
      placeholder: "123456789, @username",
      description: "Telegram user IDs or usernames allowed to DM",
    },
    {
      name: "groupPolicy",
      type: "select",
      label: "Group Policy",
      placeholder: "allowlist",
      default: "allowlist",
      description: "How to handle group messages",
    },
    {
      name: "groupAllowFrom",
      type: "array",
      label: "Allowed Group Senders",
      placeholder: "123456789",
      description: "User IDs allowed to trigger in groups",
    },
    {
      name: "mediaMaxMb",
      type: "number",
      label: "Media Max Size (MB)",
      placeholder: "5",
      default: 5,
      description: "Maximum attachment size",
    },
    {
      name: "timeoutSeconds",
      type: "number",
      label: "API Timeout (seconds)",
      placeholder: "30",
      default: 30,
      description: "Timeout for Telegram API calls",
    },
    {
      name: "webhookUrl",
      type: "text",
      label: "Webhook URL",
      placeholder: "https://example.com/webhook",
      description: "Optional: use webhook instead of polling",
    },
    {
      name: "webhookPort",
      type: "number",
      label: "Webhook Port",
      placeholder: "3000",
      description: "Port for webhook server",
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
  } catch (e) {
    logger.warn("Failed to refresh identity:", String(e));
  }
}

function getAckReaction(): string {
  return agentIdentity.emoji?.trim() || "👀";
}

// Validate that a file path is within allowed directories to prevent arbitrary file read
function validateTokenFilePath(filePath: string): string {
  const WOPR_HOME = process.env.WOPR_HOME || path.join(os.homedir(), ".wopr");
  const allowedDirs = [
    path.resolve(WOPR_HOME),
    path.resolve(process.cwd()),
  ];

  // Resolve the path and follow symlinks to prevent symlink bypass
  let resolved: string;
  try {
    resolved = fs.realpathSync(path.resolve(filePath));
  } catch {
    // File doesn't exist yet — use resolve without realpath
    resolved = path.resolve(filePath);
  }

  const isAllowedPath = allowedDirs.some((dir) => resolved.startsWith(dir + path.sep));
  if (!isAllowedPath) {
    throw new Error(
      `tokenFile path "${filePath}" is outside allowed directories. ` +
      `Path must be within WOPR_HOME (${WOPR_HOME}) or the current working directory.`
    );
  }

  return resolved;
}

// Resolve bot token
function resolveToken(): string {
  if (config.botToken) {
    return config.botToken;
  }
  if (config.tokenFile) {
    const safePath = validateTokenFilePath(config.tokenFile);
    try {
      return fs.readFileSync(safePath, "utf-8").trim();
    } catch (err) {
      throw new Error(`Failed to read token file "${config.tokenFile}": ${err}`);
    }
  }
  // Check env
  if (process.env.TELEGRAM_BOT_TOKEN) {
    return process.env.TELEGRAM_BOT_TOKEN;
  }
  throw new Error(
    "Telegram bot token required. Set channels.telegram.botToken, tokenFile, or TELEGRAM_BOT_TOKEN env var."
  );
}

// Check if sender is allowed
function isAllowed(userId: string, username: string | undefined, isGroup: boolean): boolean {
  const userIdStr = String(userId);
  
  if (isGroup) {
    const policy = config.groupPolicy || "allowlist";
    if (policy === "open") return true;
    if (policy === "disabled") return false;

    const allowed = config.groupAllowFrom || config.allowFrom || [];
    if (allowed.includes("*")) return true;

    return allowed.some(
      (id) =>
        id === userIdStr ||
        id === `tg:${userIdStr}` ||
        (username && (id === `@${username}` || id === username))
    );
  } else {
    const policy = config.dmPolicy || "pairing";
    if (policy === "open") return true;
    if (policy === "disabled") return false;
    if (policy === "pairing") return true; // All DMs allowed, pairing handled separately

    // allowlist mode
    const allowed = config.allowFrom || [];
    if (allowed.includes("*")) return true;

    return allowed.some(
      (id) =>
        id === userIdStr ||
        id === `tg:${userIdStr}` ||
        (username && (id === `@${username}` || id === username))
    );
  }
}

// Handle incoming message
async function handleMessage(grammyCtx: Context): Promise<void> {
  if (!grammyCtx.message || !grammyCtx.from || !grammyCtx.chat) return;

  const msg = grammyCtx.message;
  const user = grammyCtx.from;
  const chat = grammyCtx.chat;

  // Skip messages from ourselves
  if (grammyCtx.me && user.id === grammyCtx.me.id) return;

  // Check if allowed
  const isGroup = chat.type === "group" || chat.type === "supergroup";
  if (!isAllowed(String(user.id), user.username, isGroup)) {
    logger.info(`Message from ${user.id} blocked by policy`);
    return;
  }

  // Extract text
  let text = msg.text || msg.caption || "";
  
  // Handle mentions - check if bot is mentioned in groups
  if (isGroup && grammyCtx.me) {
    const botUsername = grammyCtx.me.username;
    const isMentioned = text.includes(`@${botUsername}`);
    
    if (!isMentioned && !msg.reply_to_message) {
      // In groups, only respond to mentions or replies
      return;
    }
    
    // Remove mention from text
    if (isMentioned) {
      text = text.replace(new RegExp(`@${botUsername}\\s*`, "gi"), "").trim();
    }
  }

  if (!text && (!msg.photo || msg.photo.length === 0)) {
    return; // Skip empty messages without media
  }

  // Build channel info
  const channelId = isGroup ? `group:${chat.id}` : `dm:${user.id}`;
  const channelInfo: ChannelInfo = {
    type: "telegram",
    id: channelId,
    name: chat.title || user.first_name || "Telegram DM",
  };

  // Log for context
  const logOptions: LogMessageOptions = {
    from: user.first_name || user.username || String(user.id),
    channel: channelInfo,
  };

  const sessionKey = `telegram-${chat.id}`;
  
  // Log the incoming message
  if (ctx) {
    ctx.logMessage(sessionKey, text || "[media]", logOptions);
  }

  // Send reaction (if message supports it)
  try {
    if (msg.message_id) {
      const reaction = getAckReaction();
      // Use standard emoji reactions only
      const standardReactions = ["👀", "👍", "👎", "❤", "🔥", "🥰", "👏", "😁", "🤔", "🤯", "😱", "🤬", "😢", "🎉", "🤩", "🤮", "💩", "🙏", "👌", "🕊", "🤡", "🥱", "🥴", "😍", "🐳", "❤‍🔥", "🌚", "🌭", "💯", "🤣", "⚡", "🍌", "🏆", "💔", "🤨", "😐", "🍓", "🍾", "💋", "🖕", "😈", "😴", "😭", "🤓", "👻", "👨‍💻", "👀", "🎃", "🙈", "😇", "😨", "🤝", "✍", "🤗", "🫡", "🎅", "🎄", "☃", "💅", "🤪", "🗿", "🆒", "💘", "🙉", "🦄", "😘", "💊", "🙊", "😎", "👾", "🤷‍♂", "🤷", "🤷‍♀", "😡"];
      if (standardReactions.includes(reaction)) {
        await grammyCtx.react(reaction as any).catch(() => {});
      }
    }
  } catch {
    // Reactions may not be supported
  }

  // Inject to WOPR
  await injectMessage(text, user, chat, sessionKey, channelInfo, msg.message_id);
}

// Inject message to WOPR
async function injectMessage(
  text: string,
  user: any,
  chat: any,
  sessionKey: string,
  channelInfo: ChannelInfo,
  replyToMessageId?: number
): Promise<void> {
  if (!ctx) return;

  const prefix = `[${user.first_name || user.username || "User"}]: `;
  const messageWithPrefix = prefix + (text || "[media]");

  const response = await ctx.inject(sessionKey, messageWithPrefix, {
    from: user.first_name || user.username || String(user.id),
    channel: channelInfo,
  });

  // Send response
  await sendMessage(chat.id, response, { replyToMessageId });
}

// Send message to Telegram
interface SendOptions {
  replyToMessageId?: number;
  mediaUrl?: string;
  mediaBuffer?: Buffer;
  mediaType?: string;
}

async function sendMessage(
  chatId: number | string,
  text: string,
  opts: SendOptions = {}
): Promise<void> {
  if (!bot) {
    throw new Error("Telegram bot not initialized");
  }

  const maxLength = 4096; // Telegram message limit
  const chunks: string[] = [];

  // Split long messages
  if (text.length <= maxLength) {
    chunks.push(text);
  } else {
    // Split by sentences
    let current = "";
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      if (current.length + sentence.length + 1 <= maxLength) {
        current += (current ? " " : "") + sentence;
      } else {
        if (current) chunks.push(current);
        current = sentence;
      }
    }
    if (current) chunks.push(current);
  }

  // Send chunks
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const isLast = i === chunks.length - 1;

    const params: any = {
      chat_id: chatId,
      text: chunk,
      parse_mode: "HTML",
    };

    // Only reply to original message on first chunk
    if (i === 0 && opts.replyToMessageId) {
      params.reply_to_message_id = opts.replyToMessageId;
    }

    try {
      await bot.api.sendMessage(params.chat_id, params.text, {
        parse_mode: params.parse_mode,
        reply_to_message_id: params.reply_to_message_id,
      });
    } catch (err) {
      logger.error("Failed to send Telegram message:", err);
      throw err;
    }
  }
}

// Start the bot
async function startBot(): Promise<void> {
  const token = resolveToken();

  bot = new Bot(token, {
    client: {
      timeoutSeconds: config.timeoutSeconds || 30,
    },
  });

  // Error handler
  bot.catch((err) => {
    logger.error("Telegram bot error:", err);
  });

  // Message handler
  bot.on("message", async (ctx) => {
    try {
      await handleMessage(ctx);
    } catch (err) {
      logger.error("Error handling Telegram message:", err);
    }
  });

  // Start bot
  if (config.webhookUrl) {
    // Webhook mode
    logger.info(`Starting Telegram bot with webhook: ${config.webhookUrl}`);
    // Note: Webhook server setup would be more complex
    // For now, just use polling
    await bot.start();
  } else {
    // Polling mode
    logger.info("Starting Telegram bot with polling...");
    await bot.start();
  }

  logger.info("Telegram bot started");
}

// Plugin definition
const plugin: WOPRPlugin = {
  name: "telegram",
  version: "1.0.0",
  description: "Telegram Bot integration using Grammy",

  async init(context: WOPRPluginContext): Promise<void> {
    ctx = context;
    config = (context.getConfig() || {}) as TelegramConfig;

    // Initialize logger
    logger = initLogger();

    // Register config schema
    ctx.registerConfigSchema("telegram", configSchema);

    // Refresh identity
    await refreshIdentity();

    // Validate config
    try {
      resolveToken();
    } catch (err) {
      logger.warn(
        "No Telegram bot token configured. Run 'wopr configure --plugin telegram' to set up."
      );
      return;
    }

    // Start bot
    try {
      await startBot();
    } catch (err) {
      logger.error("Failed to start Telegram bot:", err);
    }
  },

  async shutdown(): Promise<void> {
    isShuttingDown = true;

    if (bot) {
      logger.info("Stopping Telegram bot...");
      await bot.stop();
      bot = null;
    }

    ctx = null;
  },
};

export { validateTokenFilePath };
export default plugin;
