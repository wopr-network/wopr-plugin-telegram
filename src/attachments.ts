import fs, { createWriteStream, existsSync, mkdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { type Bot, InputFile } from "grammy";
import type winston from "winston";
import type { SendOptions, TelegramConfig } from "./types.js";

export const TELEGRAM_MAX_LENGTH = 4096;
export const TELEGRAM_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024; // 20MB

export const ATTACHMENTS_DIR = existsSync("/data") ? "/data/attachments" : path.join(process.cwd(), "attachments");

// Validate that a file path is within allowed directories to prevent arbitrary file read
export function validateTokenFilePath(filePath: string): string {
  const WOPR_HOME = process.env.WOPR_HOME || path.join(os.homedir(), ".wopr");
  const allowedDirs = [path.resolve(WOPR_HOME), path.resolve(process.cwd())];

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
        `Path must be within WOPR_HOME (${WOPR_HOME}) or the current working directory.`,
    );
  }

  return resolved;
}

// Resolve bot token from config or environment
export function resolveToken(config: TelegramConfig): string {
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
    "Telegram bot token required. Set channels.telegram.botToken, tokenFile, or TELEGRAM_BOT_TOKEN env var.",
  );
}

/**
 * Download a file from Telegram's servers using the Bot API.
 * Returns the local file path on success, or null on failure.
 */
export async function downloadTelegramFile(
  bot: Bot,
  config: TelegramConfig,
  logger: winston.Logger,
  fileId: string,
  fileName: string,
  userId: string | number,
): Promise<{ localPath: string; telegramFilePath: string } | null> {
  try {
    const file = await bot.api.getFile(fileId);
    if (!file.file_path) {
      logger.warn("Telegram getFile returned no file_path", { fileId });
      return null;
    }

    // Check file size against limit
    if (file.file_size && file.file_size > TELEGRAM_DOWNLOAD_LIMIT_BYTES) {
      logger.warn("File exceeds Telegram download limit", {
        fileId,
        size: file.file_size,
        limit: TELEGRAM_DOWNLOAD_LIMIT_BYTES,
      });
      return null;
    }

    // Check against user-configured max
    const maxBytes = (config.mediaMaxMb ?? 5) * 1024 * 1024;
    if (file.file_size && file.file_size > maxBytes) {
      logger.warn("File exceeds configured mediaMaxMb", {
        fileId,
        size: file.file_size,
        limit: maxBytes,
      });
      return null;
    }

    // Build download URL
    const token = resolveToken(config);
    const downloadUrl = `https://api.telegram.org/file/bot${token}/${file.file_path}`;

    // Ensure attachments directory exists
    if (!existsSync(ATTACHMENTS_DIR)) {
      mkdirSync(ATTACHMENTS_DIR, { recursive: true });
    }

    // Create safe filename
    const timestamp = Date.now();
    const safeName = fileName.replace(/[^a-zA-Z0-9._-]/g, "_") || "attachment";
    const localName = `${timestamp}-${userId}-${safeName}`;
    const localPath = path.join(ATTACHMENTS_DIR, localName);

    // Download the file
    const response = await fetch(downloadUrl);
    if (!response.ok || !response.body) {
      logger.warn("Failed to download Telegram file", {
        fileId,
        status: response.status,
      });
      return null;
    }

    const fileStream = createWriteStream(localPath);
    const nodeStream = Readable.fromWeb(response.body as import("node:stream/web").ReadableStream);
    await pipeline(nodeStream, fileStream);

    logger.info("Telegram file saved", {
      filename: localName,
      size: file.file_size,
      fileId,
    });
    return { localPath, telegramFilePath: file.file_path };
  } catch (err) {
    logger.error("Error downloading Telegram file", {
      fileId,
      error: String(err),
    });
    return null;
  }
}

/**
 * Send a photo to a Telegram chat.
 * Accepts a URL, file path, or Buffer.
 */
export async function sendPhoto(
  bot: Bot,
  logger: winston.Logger,
  chatId: number | string,
  photo: string | Buffer,
  caption?: string,
  replyToMessageId?: number,
): Promise<void> {
  let input: InputFile | string;
  if (Buffer.isBuffer(photo)) {
    input = new InputFile(photo);
  } else if (photo.startsWith("http://") || photo.startsWith("https://")) {
    input = photo;
  } else {
    // Local file path
    input = new InputFile(fs.createReadStream(photo), path.basename(photo));
  }
  try {
    await bot.api.sendPhoto(chatId, input, {
      caption,
      parse_mode: "HTML",
      reply_to_message_id: replyToMessageId,
    });
  } catch (err) {
    logger.error("Failed to send photo", { chatId, error: String(err) });
    throw err;
  }
}

/**
 * Send a document to a Telegram chat.
 * Accepts a URL, file path, or Buffer.
 */
export async function sendDocument(
  bot: Bot,
  logger: winston.Logger,
  chatId: number | string,
  document: string | Buffer,
  caption?: string,
  replyToMessageId?: number,
  fileName?: string,
): Promise<void> {
  let input: InputFile | string;
  if (Buffer.isBuffer(document)) {
    input = new InputFile(document, fileName);
  } else if (document.startsWith("http://") || document.startsWith("https://")) {
    input = document;
  } else {
    // Local file path
    input = new InputFile(fs.createReadStream(document), fileName || path.basename(document));
  }

  try {
    await bot.api.sendDocument(chatId, input, {
      caption,
      parse_mode: "HTML",
      reply_to_message_id: replyToMessageId,
    });
  } catch (err) {
    logger.error("Failed to send document", { chatId, error: String(err) });
    throw err;
  }
}

export async function sendMessage(
  bot: Bot,
  logger: winston.Logger,
  chatId: number | string,
  text: string,
  opts: SendOptions = {},
): Promise<void> {
  // Handle media responses
  if (opts.mediaUrl || opts.mediaBuffer) {
    const media = opts.mediaBuffer ?? opts.mediaUrl;
    if (media && opts.mediaType === "photo") {
      await sendPhoto(bot, logger, chatId, media, text || undefined, opts.replyToMessageId);
      return;
    }
    if (media && opts.mediaType === "document") {
      await sendDocument(bot, logger, chatId, media, text || undefined, opts.replyToMessageId);
      return;
    }
  }

  const maxLength = TELEGRAM_MAX_LENGTH;
  const chunks: string[] = [];

  // Split long messages
  if (text.length <= maxLength) {
    chunks.push(text);
  } else {
    // Split by sentences first, then hard-split any oversized pieces
    let current = "";
    const sentences = text.split(/(?<=[.!?])\s+/);
    for (const sentence of sentences) {
      if (current.length + sentence.length + 1 <= maxLength) {
        current += (current ? " " : "") + sentence;
      } else {
        if (current) chunks.push(current);
        // Hard-split sentences that exceed maxLength on their own
        if (sentence.length > maxLength) {
          for (let j = 0; j < sentence.length; j += maxLength) {
            const piece = sentence.slice(j, j + maxLength);
            if (j + maxLength < sentence.length) {
              chunks.push(piece);
            } else {
              current = piece;
            }
          }
        } else {
          current = sentence;
        }
      }
    }
    if (current) chunks.push(current);
  }

  // Send chunks
  for (let i = 0; i < chunks.length; i++) {
    const chunk = chunks[i];
    const replyId = i === 0 ? opts.replyToMessageId : undefined;

    try {
      // Attach inline keyboard only to the last chunk
      const markup = i === chunks.length - 1 && opts.reply_markup ? opts.reply_markup : undefined;
      await bot.api.sendMessage(chatId, chunk, {
        parse_mode: "HTML",
        reply_to_message_id: replyId,
        reply_markup: markup,
      });
    } catch (err) {
      logger.error("Failed to send Telegram message:", err);
      throw err;
    }
  }
}
