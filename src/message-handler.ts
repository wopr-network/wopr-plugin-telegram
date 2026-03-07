import type { Bot, Context } from "grammy";
import type winston from "winston";
import {
  downloadTelegramFile,
  sendMessage,
  TELEGRAM_DOWNLOAD_LIMIT_BYTES,
  TELEGRAM_MAX_LENGTH,
} from "./attachments.js";
import { getRegisteredCommand, getRegisteredParsers } from "./channel-provider.js";
import {
  getActiveStream,
  nextStreamId,
  removeActiveStream,
  setActiveStream,
  TelegramMessageStream,
} from "./message-streaming.js";
import { getAckReaction, isStandardReaction } from "./reactions.js";
import type {
  AgentIdentity,
  ChannelCommandContext,
  ChannelMessageContext,
  ChannelRef,
  PluginInjectOptions,
  StreamMessage,
  TelegramConfig,
  WOPRPluginContext,
} from "./types.js";

// Check if sender is allowed
export function isAllowed(
  config: TelegramConfig,
  userId: string,
  username: string | undefined,
  isGroup: boolean,
): boolean {
  const userIdStr = String(userId);

  if (isGroup) {
    const policy = config.groupPolicy || "allowlist";
    if (policy === "open") return true;
    if (policy === "disabled") return false;

    const allowed = config.groupAllowFrom || config.allowFrom || [];
    if (allowed.includes("*")) return true;

    return allowed.some(
      (id) => id === userIdStr || id === `tg:${userIdStr}` || (username && (id === `@${username}` || id === username)),
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
      (id) => id === userIdStr || id === `tg:${userIdStr}` || (username && (id === `@${username}` || id === username)),
    );
  }
}

// Helper to get session key from a grammY context
export function getSessionKey(grammyCtx: Context): string {
  const chat = grammyCtx.chat;
  const user = grammyCtx.from;
  if (!chat || !user) return "telegram-unknown";
  const isGroup = chat.type === "group" || chat.type === "supergroup";
  return isGroup ? `telegram-group:${chat.id}` : `telegram-dm:${user.id}`;
}

// Helper to get channel info from a grammY context
export function getChannelRef(grammyCtx: Context): ChannelRef {
  const chat = grammyCtx.chat;
  const user = grammyCtx.from;
  if (!chat || !user) return { type: "telegram", id: "unknown" };
  const isGroup = chat.type === "group" || chat.type === "supergroup";
  const channelId = isGroup ? `group:${chat.id}` : `dm:${user.id}`;
  return {
    type: "telegram",
    id: channelId,
    name: chat.title || user.first_name || "Telegram",
  };
}

// Helper to get display name from a grammY context
export function getDisplayName(grammyCtx: Context): string {
  const user = grammyCtx.from;
  if (!user) return "User";
  return user.first_name || user.username || String(user.id);
}

// Start a typing indicator that refreshes every 5 seconds.
// Returns a stop function to clear the interval.
export function startTypingIndicator(
  bot: Bot,
  logger: winston.Logger,
  chatId: number | string,
  action: "typing" | "upload_photo" | "upload_document" = "typing",
): () => void {
  const send = () => {
    bot.api.sendChatAction(chatId, action).catch((err) => {
      logger.debug("Failed to send chat action:", err);
    });
  };

  // Send immediately, then refresh every 5 seconds
  send();
  const interval = setInterval(send, 5000);

  return () => {
    clearInterval(interval);
  };
}

// Inject message to WOPR with streaming support
export async function injectMessage(
  bot: Bot,
  ctx: WOPRPluginContext,
  logger: winston.Logger,
  text: string,
  user: { id: number; first_name?: string; username?: string },
  chat: { id: number; type: string; title?: string },
  sessionKey: string,
  channelInfo: ChannelRef,
  replyToMessageId?: number,
  images?: string[],
): Promise<void> {
  const chatId = chat.id;
  const streamKey = `${chatId}`;

  // Cancel any active stream for this chat (user sent a new message mid-generation)
  const existing = getActiveStream(streamKey);
  if (existing) {
    logger.info(`Cancelling active stream for chat ${chatId} — new message received`);
    existing.stream.cancel();
    removeActiveStream(streamKey);
  }

  // Create a new stream with a unique ID to guard against race conditions
  const stream = new TelegramMessageStream(bot, logger, chatId, replyToMessageId);
  const currentStreamId = nextStreamId();
  setActiveStream(streamKey, currentStreamId, stream);

  const prefix = `[${user.first_name || user.username || "User"}]: `;
  const messageWithPrefix = prefix + (text || "[media]");

  const injectOpts: PluginInjectOptions = {
    from: user.first_name || user.username || String(user.id),
    channel: channelInfo,
    onStream: (msg: StreamMessage) => {
      if (msg.type === "text") {
        stream.append(msg.content);
      }
    },
  };

  // Pass image URLs for vision-capable models
  if (images && images.length > 0) {
    injectOpts.images = images;
  }

  // Start typing indicator while processing
  const stopTyping = startTypingIndicator(bot, logger, chat.id);

  try {
    const response = await ctx.inject(sessionKey, messageWithPrefix, injectOpts);

    // Stop typing indicator now that we have a response
    stopTyping();

    // Finalize the stream
    await stream.finalize();
    // Only delete if this stream is still the active one (guards against race condition)
    if (getActiveStream(streamKey)?.streamId === currentStreamId) {
      removeActiveStream(streamKey);
    }

    // If streaming edits failed or no message was sent, fall back to complete send
    if (stream.needsFallback || !stream.hasMessage) {
      logger.info(`Stream fallback: sending complete message for chat ${chatId}`);
      await sendMessage(bot, logger, chatId, response, { replyToMessageId });
    } else if (response.length > TELEGRAM_MAX_LENGTH) {
      // Response exceeded single message limit — send overflow as new messages
      const overflow = response.slice(TELEGRAM_MAX_LENGTH - 4);
      if (overflow.trim()) {
        await sendMessage(bot, logger, chatId, overflow);
      }
    }
  } catch (err) {
    // Stop typing on error
    stopTyping();

    // Finalize stream on error
    await stream.finalize();
    if (getActiveStream(streamKey)?.streamId === currentStreamId) {
      removeActiveStream(streamKey);
    }

    // If we got some content streamed, the user already sees partial output.
    // If not, re-throw so the caller can handle it.
    if (!stream.hasMessage) {
      throw err;
    }
    logger.error("Inject failed after partial stream:", err);
  }
}

// Handle incoming message
export async function handleMessage(
  grammyCtx: Context,
  bot: Bot,
  ctx: WOPRPluginContext,
  config: TelegramConfig,
  identity: AgentIdentity,
  logger: winston.Logger,
): Promise<void> {
  if (!grammyCtx.message || !grammyCtx.from || !grammyCtx.chat) return;

  const msg = grammyCtx.message;
  const user = grammyCtx.from;
  const chat = grammyCtx.chat;

  // Skip messages from ourselves
  if (grammyCtx.me && user.id === grammyCtx.me.id) return;

  // Check if allowed
  const isGroup = chat.type === "group" || chat.type === "supergroup";
  if (!isAllowed(config, String(user.id), user.username, isGroup)) {
    logger.info(`Message from ${user.id} blocked by policy`);
    return;
  }

  // Extract text (caption for media messages, text for plain messages)
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

  // Determine if message has media
  const hasPhoto = msg.photo && msg.photo.length > 0;
  const hasDocument = !!msg.document;
  const hasVoice = !!msg.voice;
  const hasMedia = hasPhoto || hasDocument || hasVoice;

  if (!text && !hasMedia) {
    return; // Skip empty messages without media
  }

  // Dispatch cross-plugin registered commands (e.g., from P2P plugin)
  if (text?.startsWith("/")) {
    const parts = text.slice(1).split(/\s+/);
    const cmdName = parts[0]?.toLowerCase();
    const cmd = cmdName ? getRegisteredCommand(cmdName) : undefined;
    if (cmd) {
      const channelId = isGroup ? `group:${chat.id}` : `dm:${user.id}`;
      const cmdCtx: ChannelCommandContext = {
        channel: channelId,
        channelType: "telegram",
        sender: user.username || String(user.id),
        args: parts.slice(1),
        reply: async (replyMsg: string) => {
          await sendMessage(bot, logger, chat.id, replyMsg, {
            replyToMessageId: grammyCtx.message?.message_id,
          });
        },
        getBotUsername: () => bot?.botInfo?.username || "unknown",
      };
      try {
        await cmd.handler(cmdCtx);
      } catch (err) {
        logger.error(`Cross-plugin command /${cmdName} failed:`, err);
        await sendMessage(bot, logger, chat.id, "An error occurred while processing that command.", {
          replyToMessageId: grammyCtx.message?.message_id,
        });
      }
      return;
    }
  }

  // Run cross-plugin message parsers
  if (text) {
    for (const parser of getRegisteredParsers()) {
      const matches = typeof parser.pattern === "function" ? parser.pattern(text) : parser.pattern.test(text);
      if (matches) {
        const channelId = isGroup ? `group:${chat.id}` : `dm:${user.id}`;
        const parserCtx: ChannelMessageContext = {
          channel: channelId,
          channelType: "telegram",
          sender: user.username || String(user.id),
          content: text,
          reply: async (replyMsg: string) => {
            await sendMessage(bot, logger, chat.id, replyMsg, {
              replyToMessageId: grammyCtx.message?.message_id,
            });
          },
          getBotUsername: () => bot?.botInfo?.username || "unknown",
        };
        try {
          await parser.handler(parserCtx);
        } catch (err) {
          logger.error(`Cross-plugin parser ${parser.id} failed:`, err);
          await sendMessage(bot, logger, chat.id, "An error occurred while processing your message.", {
            replyToMessageId: grammyCtx.message?.message_id,
          });
        }
        return;
      }
    }
  }

  // Build channel info
  const channelId = isGroup ? `group:${chat.id}` : `dm:${user.id}`;
  const channelInfo: ChannelRef = {
    type: "telegram",
    id: channelId,
    name: chat.title || user.first_name || "Telegram DM",
  };

  // Log for context
  const logOptions = {
    from: user.first_name || user.username || String(user.id),
    channel: channelInfo,
  };

  const sessionKey = isGroup ? `telegram-group:${chat.id}` : `telegram-dm:${user.id}`;

  // Log the incoming message
  ctx.logMessage(sessionKey, text || "[media]", logOptions);

  // Send acknowledgment reaction (Bot API 8.0+ — reactions on most message types)
  try {
    if (msg.message_id) {
      const reaction = getAckReaction(config, identity);
      if (isStandardReaction(reaction)) {
        await grammyCtx.react(reaction).catch(() => {});
      }
    }
  } catch {
    // Reactions may not be supported in this chat type
  }

  // Process media attachments
  const attachmentPaths: string[] = [];
  const imageUrls: string[] = [];

  if (hasPhoto && msg.photo) {
    // Telegram sends multiple sizes; pick the largest (last in array)
    const largest = msg.photo[msg.photo.length - 1];
    // Check file size before attempting download
    if (largest.file_size && largest.file_size > TELEGRAM_DOWNLOAD_LIMIT_BYTES) {
      const sizeMb = (largest.file_size / (1024 * 1024)).toFixed(1);
      await sendMessage(
        bot,
        logger,
        chat.id,
        `Sorry, that photo is too large to process (${sizeMb}MB, Telegram limit is 20MB).`,
        {
          replyToMessageId: msg.message_id,
        },
      );
      return;
    }
    const photoMaxBytes = (config.mediaMaxMb ?? 5) * 1024 * 1024;
    if (largest.file_size && largest.file_size > photoMaxBytes) {
      const sizeMb = (largest.file_size / (1024 * 1024)).toFixed(1);
      const limitMb = config.mediaMaxMb ?? 5;
      await sendMessage(
        bot,
        logger,
        chat.id,
        `Sorry, that photo exceeds the configured size limit (${sizeMb}MB, limit is ${limitMb}MB).`,
        {
          replyToMessageId: msg.message_id,
        },
      );
      return;
    }
    const result = await downloadTelegramFile(bot, config, logger, largest.file_id, "photo.jpg", user.id);
    if (result) {
      attachmentPaths.push(result.localPath);
      // Pass local file path for vision models (avoids leaking bot token in URLs)
      imageUrls.push(result.localPath);
    }
  }

  if (hasDocument && msg.document) {
    const doc = msg.document;
    // Check file size before attempting download
    if (doc.file_size && doc.file_size > TELEGRAM_DOWNLOAD_LIMIT_BYTES) {
      await sendMessage(bot, logger, chat.id, "Sorry, that file is too large. Telegram limits bot downloads to 20MB.", {
        replyToMessageId: msg.message_id,
      });
      return;
    }
    const maxBytes = (config.mediaMaxMb ?? 5) * 1024 * 1024;
    if (doc.file_size && doc.file_size > maxBytes) {
      await sendMessage(
        bot,
        logger,
        chat.id,
        `Sorry, that file exceeds the configured size limit of ${config.mediaMaxMb ?? 5}MB.`,
        {
          replyToMessageId: msg.message_id,
        },
      );
      return;
    }
    const fileName = doc.file_name || "document";
    const result = await downloadTelegramFile(bot, config, logger, doc.file_id, fileName, user.id);
    if (result) {
      attachmentPaths.push(result.localPath);
    }
  }

  if (hasVoice && msg.voice) {
    const voice = msg.voice;
    // Voice messages are typically small OGG files
    if (voice.file_size && voice.file_size > TELEGRAM_DOWNLOAD_LIMIT_BYTES) {
      await sendMessage(bot, logger, chat.id, "Sorry, that voice message is too large to process.", {
        replyToMessageId: msg.message_id,
      });
      return;
    }
    const voiceMaxBytes = (config.mediaMaxMb ?? 5) * 1024 * 1024;
    if (voice.file_size && voice.file_size > voiceMaxBytes) {
      await sendMessage(
        bot,
        logger,
        chat.id,
        `Sorry, that voice message exceeds the configured size limit of ${config.mediaMaxMb ?? 5}MB.`,
        {
          replyToMessageId: msg.message_id,
        },
      );
      return;
    }
    const result = await downloadTelegramFile(bot, config, logger, voice.file_id, "voice.ogg", user.id);
    if (result) {
      attachmentPaths.push(result.localPath);
    }
  }

  // Append attachment info to message content (matching Discord plugin pattern)
  if (attachmentPaths.length > 0) {
    const attachmentInfo = attachmentPaths.map((p) => `[Attachment: ${p}]`).join("\n");
    text = text ? `${text}\n\n${attachmentInfo}` : attachmentInfo;
    logger.info("Attachments appended to message", {
      count: attachmentPaths.length,
      channelId,
    });
  }

  // Inject to WOPR with image URLs for vision models
  await injectMessage(
    bot,
    ctx,
    logger,
    text,
    user,
    chat,
    sessionKey,
    channelInfo,
    msg.message_id,
    imageUrls.length > 0 ? imageUrls : undefined,
  );
}

// Inject a command to WOPR and reply with the response
export async function injectCommandMessage(
  grammyCtx: Context,
  bot: Bot,
  ctx: WOPRPluginContext,
  logger: winston.Logger,
  message: string,
): Promise<void> {
  if (!grammyCtx.chat) {
    await grammyCtx.reply("Bot is not connected to WOPR.");
    return;
  }

  const sessionKey = getSessionKey(grammyCtx);
  const channelInfo = getChannelRef(grammyCtx);
  const from = getDisplayName(grammyCtx);
  const prefix = `[${from}]: `;

  ctx.logMessage(sessionKey, message, { from, channel: channelInfo });

  try {
    const response = await ctx.inject(sessionKey, prefix + message, {
      from,
      channel: channelInfo,
    });
    await sendMessage(bot, logger, grammyCtx.chat.id, response, {
      replyToMessageId: grammyCtx.message?.message_id,
    });
  } catch (err) {
    logger.error("Failed to inject command message:", err);
    await grammyCtx.reply("An error occurred processing your request.");
  }
}

// Check authorization for a command handler; returns true if blocked
export async function checkCommandAuth(
  grammyCtx: Context,
  config: TelegramConfig,
  logger: winston.Logger,
): Promise<boolean> {
  const user = grammyCtx.from;
  const chat = grammyCtx.chat;
  if (!user || !chat) return true;
  const isGroup = chat.type === "group" || chat.type === "supergroup";
  if (!isAllowed(config, String(user.id), user.username, isGroup)) {
    logger.info(`Command from ${user.id} blocked by policy`);
    return true;
  }
  return false;
}
