import type { Bot } from "grammy";
import type winston from "winston";

export const STREAM_FLUSH_INTERVAL_MS = 2000;
const TELEGRAM_MAX_LENGTH = 4096;

let streamIdCounter = 0;
const activeStreams = new Map<string, { streamId: number; stream: TelegramMessageStream }>();

/**
 * Manages streaming a response into a Telegram message via edit-in-place.
 * Buffers incoming tokens, flushes edits at intervals to respect rate limits.
 */
export class TelegramMessageStream {
  private chatId: number | string;
  private messageId: number | null = null;
  private replyToMessageId: number | undefined;
  private content = "";
  private pendingContent: string[] = [];
  private flushTimer: NodeJS.Timeout | null = null;
  private finalized = false;
  private cancelled = false;
  private processing = false;
  private editFailed = false;
  private bot: Bot;
  private logger: winston.Logger;

  constructor(bot: Bot, logger: winston.Logger, chatId: number | string, replyToMessageId?: number) {
    this.bot = bot;
    this.logger = logger;
    this.chatId = chatId;
    this.replyToMessageId = replyToMessageId;

    // Start periodic flush
    this.flushTimer = setInterval(() => this.processPending(), STREAM_FLUSH_INTERVAL_MS);
  }

  /** Cancel this stream (e.g. user sent a new message). */
  cancel(): void {
    this.cancelled = true;
    this.cleanup();
  }

  /** Append text from a stream chunk. */
  append(text: string): void {
    if (this.finalized || this.cancelled) return;
    this.pendingContent.push(text);
  }

  /** Drain pending chunks and edit the Telegram message. */
  private async processPending(): Promise<void> {
    if (this.processing || this.finalized || this.cancelled || this.pendingContent.length === 0) {
      return;
    }
    this.processing = true;

    try {
      const batch = this.pendingContent.splice(0).join("");
      if (!batch) return;

      this.content += batch;

      // Truncate display to Telegram limit (full content preserved for fallback)
      const displayText =
        this.content.length > TELEGRAM_MAX_LENGTH
          ? `${this.content.slice(0, TELEGRAM_MAX_LENGTH - 4)} ...`
          : this.content;

      if (!this.messageId) {
        // Send initial message
        await this.sendInitial(displayText);
      } else {
        // Edit existing message
        await this.editMessage(displayText);
      }
    } catch (err) {
      this.logger.error("Stream processPending error:", err);
    } finally {
      this.processing = false;
    }
  }

  /** Send the initial placeholder or first content message. */
  private async sendInitial(text: string): Promise<void> {
    try {
      const result = await this.bot.api.sendMessage(this.chatId, text, {
        reply_to_message_id: this.replyToMessageId,
      });
      this.messageId = result.message_id;
      this.logger.debug(`Stream: sent initial message ${this.messageId} in chat ${this.chatId}`);
    } catch (err) {
      this.logger.error("Stream: failed to send initial message:", err);
      this.editFailed = true;
    }
  }

  /** Edit the in-place message with updated content. */
  private async editMessage(text: string): Promise<void> {
    if (!this.messageId || this.editFailed) return;
    try {
      await this.bot.api.editMessageText(this.chatId, this.messageId, text, {
        parse_mode: "Markdown",
      });
    } catch (err: unknown) {
      // "message is not modified" is not a real error — content unchanged
      const errObj = err as { description?: string };
      if (errObj?.description?.includes("message is not modified")) return;
      this.logger.error("Stream: editMessageText failed:", err);
      // If edit fails (e.g. rate limit), mark as failed so finalize sends complete message
      this.editFailed = true;
    }
  }

  /** Stop the flush timer. */
  private cleanup(): void {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
  }

  /**
   * Finalize the stream — flush all remaining content.
   * Returns the full accumulated content (for fallback if edits failed).
   */
  async finalize(): Promise<string> {
    if (this.finalized) return this.content;
    this.cleanup();

    // Wait for any in-flight processing
    if (this.processing) {
      let waitCount = 0;
      while (this.processing && waitCount < 50) {
        await new Promise((r) => setTimeout(r, 100));
        waitCount++;
      }
    }

    this.finalized = true;

    // Drain remaining pending content
    if (this.pendingContent.length > 0) {
      this.content += this.pendingContent.splice(0).join("");
    }

    if (this.cancelled) return this.content;

    // Final edit with complete content
    if (this.messageId && !this.editFailed && this.content) {
      const displayText =
        this.content.length > TELEGRAM_MAX_LENGTH
          ? `${this.content.slice(0, TELEGRAM_MAX_LENGTH - 4)} ...`
          : this.content;
      await this.editMessage(displayText);
    }

    return this.content;
  }

  /** Whether edits failed and we need to fall back to sending a complete message. */
  get needsFallback(): boolean {
    return this.editFailed;
  }

  /** Whether we never managed to send an initial message. */
  get hasMessage(): boolean {
    return this.messageId !== null;
  }

  /** The full accumulated content. */
  get fullContent(): string {
    return this.content;
  }
}

export function getActiveStream(key: string): { streamId: number; stream: TelegramMessageStream } | undefined {
  return activeStreams.get(key);
}

export function setActiveStream(key: string, streamId: number, stream: TelegramMessageStream): void {
  activeStreams.set(key, { streamId, stream });
}

export function removeActiveStream(key: string, expectedId?: number): void {
  if (expectedId !== undefined) {
    if (activeStreams.get(key)?.streamId === expectedId) {
      activeStreams.delete(key);
    }
  } else {
    activeStreams.delete(key);
  }
}

export function nextStreamId(): number {
  return ++streamIdCounter;
}

export function cancelAllStreams(): void {
  for (const [, { stream }] of activeStreams) {
    stream.cancel();
  }
  activeStreams.clear();
}
