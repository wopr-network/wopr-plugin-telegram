/**
 * WOPR Telegram Plugin - Grammy-based Telegram Bot integration
 */

import crypto from "node:crypto";
import fs, { createWriteStream, existsSync, mkdirSync } from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { autoRetry } from "@grammyjs/auto-retry";
import type { ReactionTypeEmoji } from "@grammyjs/types";
import type {
	AgentIdentity,
	ChannelCommand,
	ChannelCommandContext,
	ChannelMessageContext,
	ChannelMessageParser,
	ChannelProvider,
	ChannelRef,
	ConfigSchema,
	PluginInjectOptions,
	PluginManifest,
	StreamMessage,
	WOPRPlugin,
	WOPRPluginContext,
} from "@wopr-network/plugin-types";
import {
	Bot,
	type Context,
	type InlineKeyboard,
	InputFile,
	webhookCallback,
} from "grammy";
import winston from "winston";
import {
	buildMainKeyboard,
	buildModelKeyboard,
	parseCallbackData,
} from "./keyboards.js";
import { createTelegramExtension } from "./telegram-extension.js";

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
	maxRetries?: number;
	retryMaxDelay?: number;
	webhookPath?: string;
	webhookSecret?: string;
	ackReaction?: string;
}

// Module-level state
let ctx: WOPRPluginContext | null = null;
let config: TelegramConfig = {};
let agentIdentity: AgentIdentity = { name: "WOPR", emoji: "👀" };
let bot: Bot | null = null;
let webhookServer: http.Server | null = null;
const _isShuttingDown = false;
let logger: winston.Logger;

// Streaming constants
const STREAM_FLUSH_INTERVAL_MS = 2000; // Flush edits every 2s (~30 edits/min max)
const TELEGRAM_MAX_LENGTH = 4096; // Telegram message character limit
// Active streams keyed by unique stream ID — prevents race conditions when
// a new stream starts for the same chat before the old one's cleanup runs.
let streamIdCounter = 0;
const activeStreams = new Map<
	string,
	{ streamId: number; stream: TelegramMessageStream }
>();

/**
 * Manages streaming a response into a Telegram message via edit-in-place.
 * Buffers incoming tokens, flushes edits at intervals to respect rate limits.
 */
class TelegramMessageStream {
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

	constructor(chatId: number | string, replyToMessageId?: number) {
		this.chatId = chatId;
		this.replyToMessageId = replyToMessageId;

		// Start periodic flush
		this.flushTimer = setInterval(
			() => this.processPending(),
			STREAM_FLUSH_INTERVAL_MS,
		);
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
		if (
			this.processing ||
			this.finalized ||
			this.cancelled ||
			this.pendingContent.length === 0
		) {
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
			logger.error("Stream processPending error:", err);
		} finally {
			this.processing = false;
		}
	}

	/** Send the initial placeholder or first content message. */
	private async sendInitial(text: string): Promise<void> {
		if (!bot) return;
		try {
			const result = await bot.api.sendMessage(this.chatId, text, {
				reply_to_message_id: this.replyToMessageId,
			});
			this.messageId = result.message_id;
			logger.debug(
				`Stream: sent initial message ${this.messageId} in chat ${this.chatId}`,
			);
		} catch (err) {
			logger.error("Stream: failed to send initial message:", err);
			this.editFailed = true;
		}
	}

	/** Edit the in-place message with updated content. */
	private async editMessage(text: string): Promise<void> {
		if (!bot || !this.messageId || this.editFailed) return;
		try {
			await bot.api.editMessageText(this.chatId, this.messageId, text, {
				parse_mode: "Markdown",
			});
		} catch (err: unknown) {
			// "message is not modified" is not a real error — content unchanged
			const errObj = err as { description?: string };
			if (errObj?.description?.includes("message is not modified")) return;
			logger.error("Stream: editMessageText failed:", err);
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

// Initialize winston logger
function initLogger(): winston.Logger {
	const WOPR_HOME =
		process.env.WOPR_HOME || path.join(process.env.HOME || "~", ".wopr");
	return winston.createLogger({
		level: "debug",
		format: winston.format.combine(
			winston.format.timestamp(),
			winston.format.errors({ stack: true }),
			winston.format.json(),
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
					winston.format.simple(),
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
		{
			name: "maxRetries",
			type: "number",
			label: "Max Retries",
			placeholder: "3",
			default: 3,
			description: "Maximum number of retry attempts for failed API calls",
		},
		{
			name: "retryMaxDelay",
			type: "number",
			label: "Retry Max Delay (seconds)",
			placeholder: "30",
			default: 30,
			description: "Maximum delay to wait for rate-limited retries",
		},
		{
			name: "webhookPath",
			type: "text",
			label: "Webhook Path",
			placeholder: "/telegram",
			description: "URL path for webhook endpoint (default: /telegram)",
		},
		{
			name: "webhookSecret",
			type: "password",
			label: "Webhook Secret",
			placeholder: "random-secret-string",
			description: "Secret token for validating webhook requests from Telegram",
		},
		{
			name: "ackReaction",
			type: "text",
			label: "Acknowledgment Reaction",
			placeholder: "\u{1F440}",
			description:
				"Emoji reaction sent on incoming messages to acknowledge receipt (must be a standard Telegram reaction emoji)",
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

// All emoji strings that Telegram accepts for bot reactions (Bot API 8.0+).
// This set mirrors the ReactionTypeEmoji["emoji"] union from @grammyjs/types.
const STANDARD_REACTIONS: ReadonlySet<string> = new Set<
	ReactionTypeEmoji["emoji"]
>([
	"\u{1F44D}",
	"\u{1F44E}",
	"\u{2764}",
	"\u{1F525}",
	"\u{1F970}",
	"\u{1F44F}",
	"\u{1F601}",
	"\u{1F914}",
	"\u{1F92F}",
	"\u{1F631}",
	"\u{1F92C}",
	"\u{1F622}",
	"\u{1F389}",
	"\u{1F929}",
	"\u{1F92E}",
	"\u{1F4A9}",
	"\u{1F64F}",
	"\u{1F44C}",
	"\u{1F54A}",
	"\u{1F921}",
	"\u{1F971}",
	"\u{1F974}",
	"\u{1F60D}",
	"\u{1F433}",
	"\u{2764}\u{200D}\u{1F525}",
	"\u{1F31A}",
	"\u{1F32D}",
	"\u{1F4AF}",
	"\u{1F923}",
	"\u{26A1}",
	"\u{1F34C}",
	"\u{1F3C6}",
	"\u{1F494}",
	"\u{1F928}",
	"\u{1F610}",
	"\u{1F353}",
	"\u{1F37E}",
	"\u{1F48B}",
	"\u{1F595}",
	"\u{1F608}",
	"\u{1F634}",
	"\u{1F62D}",
	"\u{1F913}",
	"\u{1F47B}",
	"\u{1F468}\u{200D}\u{1F4BB}",
	"\u{1F440}",
	"\u{1F383}",
	"\u{1F648}",
	"\u{1F607}",
	"\u{1F628}",
	"\u{1F91D}",
	"\u{270D}",
	"\u{1F917}",
	"\u{1FAE1}",
	"\u{1F385}",
	"\u{1F384}",
	"\u{2603}",
	"\u{1F485}",
	"\u{1F92A}",
	"\u{1F5FF}",
	"\u{1F192}",
	"\u{1F498}",
	"\u{1F649}",
	"\u{1F984}",
	"\u{1F618}",
	"\u{1F48A}",
	"\u{1F64A}",
	"\u{1F60E}",
	"\u{1F47E}",
	"\u{1F937}\u{200D}\u{2642}",
	"\u{1F937}",
	"\u{1F937}\u{200D}\u{2640}",
	"\u{1F621}",
]);

function isStandardReaction(
	emoji: string,
): emoji is ReactionTypeEmoji["emoji"] {
	return STANDARD_REACTIONS.has(emoji);
}

function getAckReaction(): string {
	// Config override takes priority, then agent identity emoji, then default
	return (
		config.ackReaction?.trim() || agentIdentity.emoji?.trim() || "\u{1F440}"
	);
}

// Telegram Bot API file size limit
const TELEGRAM_DOWNLOAD_LIMIT_BYTES = 20 * 1024 * 1024; // 20MB download limit

// Attachments directory
const ATTACHMENTS_DIR = existsSync("/data")
	? "/data/attachments"
	: path.join(process.cwd(), "attachments");

// ============================================================================
// Channel Provider (cross-plugin command/parser registration)
// ============================================================================

const registeredCommands: Map<string, ChannelCommand> = new Map();
const registeredParsers: Map<string, ChannelMessageParser> = new Map();

/**
 * Telegram Channel Provider — allows other plugins to register commands and
 * message parsers on the Telegram channel, mirroring the Discord pattern.
 */
const telegramChannelProvider: ChannelProvider = {
	id: "telegram",

	registerCommand(cmd: ChannelCommand): void {
		registeredCommands.set(cmd.name, cmd);
		logger?.info(`Channel command registered: ${cmd.name}`);
	},

	unregisterCommand(name: string): void {
		registeredCommands.delete(name);
	},

	getCommands(): ChannelCommand[] {
		return Array.from(registeredCommands.values());
	},

	addMessageParser(parser: ChannelMessageParser): void {
		registeredParsers.set(parser.id, parser);
		logger?.info(`Message parser registered: ${parser.id}`);
	},

	removeMessageParser(id: string): void {
		registeredParsers.delete(id);
	},

	getMessageParsers(): ChannelMessageParser[] {
		return Array.from(registeredParsers.values());
	},

	async send(channel: string, content: string): Promise<void> {
		if (!bot) throw new Error("Telegram bot not initialized");
		// Channel ID may be a raw chat ID or prefixed (dm:123, group:456)
		const chatId = channel.replace(/^(dm|group):/, "");
		await sendMessage(chatId, content);
	},

	getBotUsername(): string {
		return bot?.botInfo?.username || "unknown";
	},
};

/**
 * Download a file from Telegram's servers using the Bot API.
 * Returns the local file path on success, or null on failure.
 */
async function downloadTelegramFile(
	fileId: string,
	fileName: string,
	userId: string | number,
): Promise<{ localPath: string; telegramFilePath: string } | null> {
	if (!bot) return null;

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
		const token = resolveToken();
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
		const nodeStream = Readable.fromWeb(
			response.body as import("node:stream/web").ReadableStream,
		);
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

// Validate that a file path is within allowed directories to prevent arbitrary file read
function validateTokenFilePath(filePath: string): string {
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

	const isAllowedPath = allowedDirs.some((dir) =>
		resolved.startsWith(dir + path.sep),
	);
	if (!isAllowedPath) {
		throw new Error(
			`tokenFile path "${filePath}" is outside allowed directories. ` +
				`Path must be within WOPR_HOME (${WOPR_HOME}) or the current working directory.`,
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
			throw new Error(
				`Failed to read token file "${config.tokenFile}": ${err}`,
			);
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

// Check if sender is allowed
function isAllowed(
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
			(id) =>
				id === userIdStr ||
				id === `tg:${userIdStr}` ||
				(username && (id === `@${username}` || id === username)),
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
				(username && (id === `@${username}` || id === username)),
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
		const cmd = cmdName ? registeredCommands.get(cmdName) : undefined;
		if (cmd) {
			const channelId = isGroup ? `group:${chat.id}` : `dm:${user.id}`;
			const cmdCtx: ChannelCommandContext = {
				channel: channelId,
				channelType: "telegram",
				sender: user.username || String(user.id),
				args: parts.slice(1),
				reply: async (msg: string) => {
					await sendMessage(chat.id, msg, {
						replyToMessageId: grammyCtx.message?.message_id,
					});
				},
				getBotUsername: () => bot?.botInfo?.username || "unknown",
			};
			try {
				await cmd.handler(cmdCtx);
			} catch (err) {
				logger.error(`Cross-plugin command /${cmdName} failed:`, err);
				await sendMessage(
					chat.id,
					"An error occurred while processing that command.",
					{ replyToMessageId: grammyCtx.message?.message_id },
				);
			}
			return;
		}
	}

	// Run cross-plugin message parsers
	if (text) {
		for (const parser of registeredParsers.values()) {
			const matches =
				typeof parser.pattern === "function"
					? parser.pattern(text)
					: parser.pattern.test(text);
			if (matches) {
				const channelId = isGroup ? `group:${chat.id}` : `dm:${user.id}`;
				const parserCtx: ChannelMessageContext = {
					channel: channelId,
					channelType: "telegram",
					sender: user.username || String(user.id),
					content: text,
					reply: async (msg: string) => {
						await sendMessage(chat.id, msg, {
							replyToMessageId: grammyCtx.message?.message_id,
						});
					},
					getBotUsername: () => bot?.botInfo?.username || "unknown",
				};
				try {
					await parser.handler(parserCtx);
				} catch (err) {
					logger.error(`Cross-plugin parser ${parser.id} failed:`, err);
					await sendMessage(
						chat.id,
						"An error occurred while processing your message.",
						{ replyToMessageId: grammyCtx.message?.message_id },
					);
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

	const sessionKey = isGroup
		? `telegram-group:${chat.id}`
		: `telegram-dm:${user.id}`;

	// Log the incoming message
	if (ctx) {
		ctx.logMessage(sessionKey, text || "[media]", logOptions);
	}

	// Send acknowledgment reaction (Bot API 8.0+ — reactions on most message types)
	try {
		if (msg.message_id) {
			const reaction = getAckReaction();
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
		if (
			largest.file_size &&
			largest.file_size > TELEGRAM_DOWNLOAD_LIMIT_BYTES
		) {
			const sizeMb = (largest.file_size / (1024 * 1024)).toFixed(1);
			await sendMessage(
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
				chat.id,
				`Sorry, that photo exceeds the configured size limit (${sizeMb}MB, limit is ${limitMb}MB).`,
				{
					replyToMessageId: msg.message_id,
				},
			);
			return;
		}
		const result = await downloadTelegramFile(
			largest.file_id,
			"photo.jpg",
			user.id,
		);
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
			await sendMessage(
				chat.id,
				"Sorry, that file is too large. Telegram limits bot downloads to 20MB.",
				{
					replyToMessageId: msg.message_id,
				},
			);
			return;
		}
		const maxBytes = (config.mediaMaxMb ?? 5) * 1024 * 1024;
		if (doc.file_size && doc.file_size > maxBytes) {
			await sendMessage(
				chat.id,
				`Sorry, that file exceeds the configured size limit of ${config.mediaMaxMb ?? 5}MB.`,
				{
					replyToMessageId: msg.message_id,
				},
			);
			return;
		}
		const fileName = doc.file_name || "document";
		const result = await downloadTelegramFile(doc.file_id, fileName, user.id);
		if (result) {
			attachmentPaths.push(result.localPath);
		}
	}

	if (hasVoice && msg.voice) {
		const voice = msg.voice;
		// Voice messages are typically small OGG files
		if (voice.file_size && voice.file_size > TELEGRAM_DOWNLOAD_LIMIT_BYTES) {
			await sendMessage(
				chat.id,
				"Sorry, that voice message is too large to process.",
				{
					replyToMessageId: msg.message_id,
				},
			);
			return;
		}
		const voiceMaxBytes = (config.mediaMaxMb ?? 5) * 1024 * 1024;
		if (voice.file_size && voice.file_size > voiceMaxBytes) {
			await sendMessage(
				chat.id,
				`Sorry, that voice message exceeds the configured size limit of ${config.mediaMaxMb ?? 5}MB.`,
				{
					replyToMessageId: msg.message_id,
				},
			);
			return;
		}
		const result = await downloadTelegramFile(
			voice.file_id,
			"voice.ogg",
			user.id,
		);
		if (result) {
			attachmentPaths.push(result.localPath);
		}
	}

	// Append attachment info to message content (matching Discord plugin pattern)
	if (attachmentPaths.length > 0) {
		const attachmentInfo = attachmentPaths
			.map((p) => `[Attachment: ${p}]`)
			.join("\n");
		text = text ? `${text}\n\n${attachmentInfo}` : attachmentInfo;
		logger.info("Attachments appended to message", {
			count: attachmentPaths.length,
			channelId,
		});
	}

	// Inject to WOPR with image URLs for vision models
	await injectMessage(
		text,
		user,
		chat,
		sessionKey,
		channelInfo,
		msg.message_id,
		imageUrls.length > 0 ? imageUrls : undefined,
	);
}

// Start a typing indicator that refreshes every 5 seconds.
// Returns a stop function to clear the interval.
function startTypingIndicator(
	chatId: number | string,
	action: "typing" | "upload_photo" | "upload_document" = "typing",
): () => void {
	if (!bot) return () => {};

	const send = () => {
		bot?.api.sendChatAction(chatId, action).catch((err) => {
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
async function injectMessage(
	text: string,
	user: any,
	chat: any,
	sessionKey: string,
	channelInfo: ChannelRef,
	replyToMessageId?: number,
	images?: string[],
): Promise<void> {
	if (!ctx) return;

	const chatId = chat.id;
	const streamKey = `${chatId}`;

	// Cancel any active stream for this chat (user sent a new message mid-generation)
	const existing = activeStreams.get(streamKey);
	if (existing) {
		logger.info(
			`Cancelling active stream for chat ${chatId} — new message received`,
		);
		existing.stream.cancel();
		activeStreams.delete(streamKey);
	}

	// Create a new stream with a unique ID to guard against race conditions
	const stream = new TelegramMessageStream(chatId, replyToMessageId);
	const currentStreamId = ++streamIdCounter;
	activeStreams.set(streamKey, { streamId: currentStreamId, stream });

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
	const stopTyping = startTypingIndicator(chat.id);

	try {
		const response = await ctx.inject(
			sessionKey,
			messageWithPrefix,
			injectOpts,
		);

		// Stop typing indicator now that we have a response
		stopTyping();

		// Finalize the stream
		await stream.finalize();
		// Only delete if this stream is still the active one (guards against race condition)
		if (activeStreams.get(streamKey)?.streamId === currentStreamId) {
			activeStreams.delete(streamKey);
		}

		// If streaming edits failed or no message was sent, fall back to complete send
		if (stream.needsFallback || !stream.hasMessage) {
			logger.info(
				`Stream fallback: sending complete message for chat ${chatId}`,
			);
			await sendMessage(chatId, response, { replyToMessageId });
		} else if (response.length > TELEGRAM_MAX_LENGTH) {
			// Response exceeded single message limit — send overflow as new messages
			// The stream truncated display at (TELEGRAM_MAX_LENGTH - 4) then appended " ...",
			// so the user has seen content[0..4092]. Send remaining content from that point.
			const overflow = response.slice(TELEGRAM_MAX_LENGTH - 4);
			if (overflow.trim()) {
				await sendMessage(chatId, overflow);
			}
		}
	} catch (err) {
		// Stop typing on error
		stopTyping();

		// Finalize stream on error
		await stream.finalize();
		if (activeStreams.get(streamKey)?.streamId === currentStreamId) {
			activeStreams.delete(streamKey);
		}

		// If we got some content streamed, the user already sees partial output.
		// If not, re-throw so the caller can handle it.
		if (!stream.hasMessage) {
			throw err;
		}
		logger.error("Inject failed after partial stream:", err);
	}
}

// Send message to Telegram
interface SendOptions {
	replyToMessageId?: number;
	mediaUrl?: string;
	mediaBuffer?: Buffer;
	mediaType?: "photo" | "document";
	reply_markup?: InlineKeyboard;
}

/**
 * Send a photo to a Telegram chat.
 * Accepts a URL, file path, or Buffer.
 */
async function sendPhoto(
	chatId: number | string,
	photo: string | Buffer,
	caption?: string,
	replyToMessageId?: number,
): Promise<void> {
	if (!bot) throw new Error("Telegram bot not initialized");

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
async function sendDocument(
	chatId: number | string,
	document: string | Buffer,
	caption?: string,
	replyToMessageId?: number,
	fileName?: string,
): Promise<void> {
	if (!bot) throw new Error("Telegram bot not initialized");

	let input: InputFile | string;
	if (Buffer.isBuffer(document)) {
		input = new InputFile(document, fileName);
	} else if (
		document.startsWith("http://") ||
		document.startsWith("https://")
	) {
		input = document;
	} else {
		// Local file path
		input = new InputFile(
			fs.createReadStream(document),
			fileName || path.basename(document),
		);
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

async function sendMessage(
	chatId: number | string,
	text: string,
	opts: SendOptions = {},
): Promise<void> {
	if (!bot) {
		throw new Error("Telegram bot not initialized");
	}

	// Handle media responses
	if (opts.mediaUrl || opts.mediaBuffer) {
		const media = opts.mediaBuffer || opts.mediaUrl!;
		if (opts.mediaType === "photo") {
			await sendPhoto(chatId, media, text || undefined, opts.replyToMessageId);
			return;
		}
		if (opts.mediaType === "document") {
			await sendDocument(
				chatId,
				media,
				text || undefined,
				opts.replyToMessageId,
			);
			return;
		}
	}

	const maxLength = 4096; // Telegram message limit
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
			const markup =
				i === chunks.length - 1 && opts.reply_markup
					? opts.reply_markup
					: undefined;
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

// Bot command definitions for BotFather menu
const botCommands = [
	{ command: "ask", description: "Ask WOPR a question" },
	{ command: "model", description: "Switch AI model (e.g. /model gpt-4o)" },
	{ command: "session", description: "Switch to a named session" },
	{ command: "status", description: "Show current session status" },
	{ command: "claim", description: "Claim bot ownership with pairing code" },
	{ command: "help", description: "Show available commands" },
];

// Helper to get session key from a grammY context
function getSessionKey(grammyCtx: Context): string {
	const chat = grammyCtx.chat;
	const user = grammyCtx.from;
	if (!chat || !user) return "telegram-unknown";
	const isGroup = chat.type === "group" || chat.type === "supergroup";
	return isGroup ? `telegram-group:${chat.id}` : `telegram-dm:${user.id}`;
}

// Helper to get channel info from a grammY context
function getChannelRef(grammyCtx: Context): ChannelRef {
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
function getDisplayName(grammyCtx: Context): string {
	const user = grammyCtx.from;
	if (!user) return "User";
	return user.first_name || user.username || String(user.id);
}

// Inject a command to WOPR and reply with the response
async function injectCommandMessage(
	grammyCtx: Context,
	message: string,
): Promise<void> {
	if (!ctx || !grammyCtx.chat) {
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
		await sendMessage(grammyCtx.chat.id, response, {
			replyToMessageId: grammyCtx.message?.message_id,
		});
	} catch (err) {
		logger.error("Failed to inject command message:", err);
		await grammyCtx.reply("An error occurred processing your request.");
	}
}

// Check authorization for a command handler; returns true if blocked
async function checkCommandAuth(grammyCtx: Context): Promise<boolean> {
	const user = grammyCtx.from;
	const chat = grammyCtx.chat;
	if (!user || !chat) return true;
	const isGroup = chat.type === "group" || chat.type === "supergroup";
	if (!isAllowed(String(user.id), user.username, isGroup)) {
		logger.info(`Command from ${user.id} blocked by policy`);
		return true;
	}
	return false;
}

// Register command handlers on the bot instance
function registerCommandHandlers(botInstance: Bot): void {
	// /ask <question> - Ask WOPR a question
	botInstance.command("ask", async (grammyCtx) => {
		if (await checkCommandAuth(grammyCtx)) return;
		const question =
			typeof grammyCtx.match === "string" ? grammyCtx.match.trim() : "";
		if (!question) {
			await grammyCtx.reply(
				"Usage: /ask <your question>\n\nExample: /ask What is the meaning of life?",
			);
			return;
		}
		await injectCommandMessage(grammyCtx, question);
	});

	// /model <name> - Switch AI model
	botInstance.command("model", async (grammyCtx) => {
		if (await checkCommandAuth(grammyCtx)) return;
		const modelName =
			typeof grammyCtx.match === "string" ? grammyCtx.match.trim() : "";
		if (!modelName) {
			await grammyCtx.reply(
				"Usage: /model <model-name>\n\nExample: /model gpt-4o\nExample: /model opus",
			);
			return;
		}
		await injectCommandMessage(grammyCtx, `/model ${modelName}`);
	});

	// /session <name> - Switch to a named session
	botInstance.command("session", async (grammyCtx) => {
		if (await checkCommandAuth(grammyCtx)) return;
		const sessionName =
			typeof grammyCtx.match === "string" ? grammyCtx.match.trim() : "";
		if (!sessionName) {
			await grammyCtx.reply(
				"Usage: /session <name>\n\nExample: /session project-alpha",
			);
			return;
		}
		await injectCommandMessage(grammyCtx, `/session ${sessionName}`);
	});

	// /status - Show session status
	botInstance.command("status", async (grammyCtx) => {
		if (await checkCommandAuth(grammyCtx)) return;
		if (!ctx || !grammyCtx.chat) {
			await grammyCtx.reply("Bot is not connected to WOPR.");
			return;
		}
		const sessionKey = getSessionKey(grammyCtx);
		const sessions = ctx.getSessions();
		const isActive = sessions.includes(sessionKey);

		const identity = agentIdentity;
		const statusLines = [
			`<b>Session Status</b>`,
			``,
			`<b>Bot:</b> ${identity.name || "WOPR"}`,
			`<b>Session:</b> <code>${sessionKey}</code>`,
			`<b>Active:</b> ${isActive ? "Yes" : "No"}`,
			`<b>Active Sessions:</b> ${sessions.length}`,
		];
		await sendMessage(grammyCtx.chat.id, statusLines.join("\n"), {
			replyToMessageId: grammyCtx.message?.message_id,
			reply_markup: buildMainKeyboard(),
		});
	});

	// /claim <code> - Claim bot ownership
	botInstance.command("claim", async (grammyCtx) => {
		if (await checkCommandAuth(grammyCtx)) return;
		const chat = grammyCtx.chat;
		if (!chat) return;
		const isGroup = chat.type === "group" || chat.type === "supergroup";
		if (isGroup) {
			await grammyCtx.reply(
				"The /claim command only works in DMs. Please DM me to claim ownership.",
			);
			return;
		}
		const code =
			typeof grammyCtx.match === "string" ? grammyCtx.match.trim() : "";
		if (!code) {
			await grammyCtx.reply(
				"Usage: /claim <pairing-code>\n\nExample: /claim ABC123",
			);
			return;
		}
		await injectCommandMessage(grammyCtx, `/claim ${code}`);
	});

	// /help - Show available commands
	botInstance.command("help", async (grammyCtx) => {
		if (await checkCommandAuth(grammyCtx)) return;
		if (!grammyCtx.chat) return;
		const helpText = [
			`<b>WOPR Telegram Commands</b>`,
			``,
			`/ask &lt;question&gt; - Ask WOPR a question`,
			`/model &lt;name&gt; - Switch AI model (e.g. opus, haiku, gpt-4o)`,
			`/session &lt;name&gt; - Switch to a named session`,
			`/status - Show current session status`,
			`/claim &lt;code&gt; - Claim bot ownership (DM only)`,
			`/help - Show this help`,
			``,
			`You can also mention me or reply to my messages to chat.`,
		];
		await sendMessage(grammyCtx.chat.id, helpText.join("\n"), {
			replyToMessageId: grammyCtx.message?.message_id,
			reply_markup: buildMainKeyboard(),
		});
	});
}

// Register callback query handlers for inline keyboard buttons
function registerCallbackHandlers(botInstance: Bot): void {
	botInstance.on("callback_query:data", async (grammyCtx) => {
		const data = grammyCtx.callbackQuery.data;
		const action = parseCallbackData(data);
		const chatId = grammyCtx.callbackQuery.message?.chat.id;

		if (!chatId || !ctx) {
			await grammyCtx.answerCallbackQuery({ text: "Bot is not ready." });
			return;
		}

		// Check authorization
		const user = grammyCtx.from;
		const chat = grammyCtx.callbackQuery.message?.chat;
		if (chat && user) {
			const isGroup = chat.type === "group" || chat.type === "supergroup";
			if (!isAllowed(String(user.id), user.username, isGroup)) {
				await grammyCtx.answerCallbackQuery({ text: "Not authorized." });
				return;
			}
		}

		try {
			switch (action.type) {
				case "help": {
					await grammyCtx.answerCallbackQuery();
					const helpText = [
						`<b>WOPR Telegram Commands</b>`,
						``,
						`/ask &lt;question&gt; - Ask WOPR a question`,
						`/model &lt;name&gt; - Switch AI model`,
						`/session &lt;name&gt; - Switch to a named session`,
						`/status - Show current session status`,
						`/claim &lt;code&gt; - Claim bot ownership (DM only)`,
						`/help - Show this help`,
						``,
						`You can also mention me or reply to my messages to chat.`,
					];
					await sendMessage(chatId, helpText.join("\n"), {
						reply_markup: buildMainKeyboard(),
					});
					break;
				}

				case "model_list": {
					await grammyCtx.answerCallbackQuery();
					// Default model list — WOPR core does not expose a getModels() API
					// to plugins, so we provide common model names as quick-switch options.
					const defaultModels = [
						"opus",
						"sonnet",
						"haiku",
						"gpt-4o",
						"gpt-4o-mini",
					];
					const kb = buildModelKeyboard(defaultModels);
					await sendMessage(chatId, "<b>Select a model:</b>", {
						reply_markup: kb,
					});
					break;
				}

				case "model_switch": {
					await grammyCtx.answerCallbackQuery({
						text: `Switching to ${action.model}...`,
					});
					const sessionKey = getSessionKeyFromCallback(grammyCtx);
					const channelInfo = getChannelRefFromCallback(grammyCtx);
					const from = getDisplayName(grammyCtx);
					ctx.logMessage(sessionKey, `/model ${action.model}`, {
						from,
						channel: channelInfo,
					});
					try {
						const response = await ctx.inject(
							sessionKey,
							`[${from}]: /model ${action.model}`,
							{
								from,
								channel: channelInfo,
							},
						);
						await sendMessage(chatId, response, {
							reply_markup: buildMainKeyboard(),
						});
					} catch (err) {
						logger.error("Model switch callback failed:", err);
						await sendMessage(
							chatId,
							"Failed to switch model. Try /model &lt;name&gt; instead.",
						);
					}
					break;
				}

				case "session_new": {
					await grammyCtx.answerCallbackQuery({
						text: "Starting new session...",
					});
					const sessionKey = getSessionKeyFromCallback(grammyCtx);
					const channelInfo = getChannelRefFromCallback(grammyCtx);
					const from = getDisplayName(grammyCtx);
					const newSessionName = `telegram-${Date.now()}`;
					ctx.logMessage(sessionKey, `/session ${newSessionName}`, {
						from,
						channel: channelInfo,
					});
					try {
						const response = await ctx.inject(
							newSessionName,
							`[${from}]: /session ${newSessionName}`,
							{ from, channel: channelInfo },
						);
						await sendMessage(chatId, response, {
							reply_markup: buildMainKeyboard(),
						});
					} catch (err) {
						logger.error("New session callback failed:", err);
						await sendMessage(chatId, "Failed to create new session.");
					}
					break;
				}

				case "session_switch": {
					await grammyCtx.answerCallbackQuery({ text: `Switching session...` });
					const channelInfo = getChannelRefFromCallback(grammyCtx);
					const from = getDisplayName(grammyCtx);
					ctx.logMessage(action.session, `/session ${action.session}`, {
						from,
						channel: channelInfo,
					});
					try {
						const response = await ctx.inject(
							action.session,
							`[${from}]: /session ${action.session}`,
							{ from, channel: channelInfo },
						);
						await sendMessage(chatId, response, {
							reply_markup: buildMainKeyboard(),
						});
					} catch (err) {
						logger.error("Session switch callback failed:", err);
						await sendMessage(chatId, "Failed to switch session.");
					}
					break;
				}

				case "status": {
					await grammyCtx.answerCallbackQuery();
					const sessionKey = getSessionKeyFromCallback(grammyCtx);
					const sessions = ctx.getSessions();
					const isActive = sessions.includes(sessionKey);
					const identity = agentIdentity;
					const statusLines = [
						`<b>Session Status</b>`,
						``,
						`<b>Bot:</b> ${identity.name || "WOPR"}`,
						`<b>Session:</b> <code>${sessionKey}</code>`,
						`<b>Active:</b> ${isActive ? "Yes" : "No"}`,
						`<b>Active Sessions:</b> ${sessions.length}`,
					];
					await sendMessage(chatId, statusLines.join("\n"), {
						reply_markup: buildMainKeyboard(),
					});
					break;
				}

				default:
					await grammyCtx.answerCallbackQuery({ text: "Unknown action." });
					break;
			}
		} catch (err) {
			logger.error("Callback query handler error:", err);
			// Always try to acknowledge even on error to remove loading spinner
			try {
				await grammyCtx.answerCallbackQuery({ text: "An error occurred." });
			} catch {
				// Already answered or network error — ignore
			}
		}
	});
}

// Helper to derive a session key from a callback query context
function getSessionKeyFromCallback(grammyCtx: Context): string {
	const chat = grammyCtx.callbackQuery?.message?.chat;
	const user = grammyCtx.from;
	if (!chat || !user) return "telegram-unknown";
	const isGroup = chat.type === "group" || chat.type === "supergroup";
	return isGroup ? `telegram-group:${chat.id}` : `telegram-dm:${user.id}`;
}

// Helper to derive channel ref from a callback query context
function getChannelRefFromCallback(grammyCtx: Context): ChannelRef {
	const chat = grammyCtx.callbackQuery?.message?.chat;
	const user = grammyCtx.from;
	if (!chat || !user) return { type: "telegram", id: "unknown" };
	const isGroup = chat.type === "group" || chat.type === "supergroup";
	const channelId = isGroup ? `group:${chat.id}` : `dm:${user.id}`;
	return {
		type: "telegram",
		id: channelId,
		name: (chat as any).title || user.first_name || "Telegram",
	};
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
			logger.info(
				`Webhook server listening on port ${port} at path ${webhookPath}`,
			);
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
	const token = resolveToken();

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
		logger.info(
			`Auto-retry enabled: maxRetryAttempts=${maxRetryAttempts}, maxDelaySeconds=${maxDelaySeconds}`,
		);
	} else {
		logger.info("Auto-retry disabled (maxRetries=0)");
	}

	// Error handler
	bot.catch((err) => {
		logger.error("Telegram bot error:", err);
	});

	// Register command handlers before the generic message handler
	registerCommandHandlers(bot);

	// Register inline keyboard callback query handlers
	registerCallbackHandlers(bot);

	// Register commands with BotFather for the "/" menu
	try {
		await bot.api.setMyCommands(botCommands);
		logger.info("Registered bot commands with BotFather");
	} catch (err) {
		logger.warn("Failed to register bot commands:", err);
	}

	// Message handler (catches non-command messages)
	bot.on("message", async (grammyCtx) => {
		try {
			await handleMessage(grammyCtx);
		} catch (err) {
			logger.error("Error handling Telegram message:", err);
		}
	});

	// Start bot
	if (config.webhookUrl) {
		// Webhook mode — fall back to polling on failure
		logger.info(`Starting Telegram bot with webhook: ${config.webhookUrl}`);
		try {
			await startWebhook(bot);
		} catch (err) {
			logger.error("Webhook setup failed, falling back to polling:", err);
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
	requires: {
		env: ["TELEGRAM_BOT_TOKEN"],
		network: { outbound: true },
	},
	configSchema,
	setup: [
		{
			id: "bot-token",
			title: "Telegram Bot Token",
			description:
				"Get a bot token from @BotFather on Telegram and paste it here.",
			fields: {
				title: "Bot Token",
				fields: [
					configSchema.fields.find(
						(f: { name: string }) => f.name === "botToken",
					)!,
				],
			},
		},
	],
};

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
		ctx.registerConfigSchema("telegram", configSchema);

		// Register as a channel provider so other plugins can add commands/parsers
		if (ctx.registerChannelProvider) {
			ctx.registerChannelProvider(telegramChannelProvider);
			logger.info("Registered Telegram channel provider");
		}

		// Register the Telegram extension so other plugins and daemon routes can access status
		if (ctx.registerExtension) {
			const extension = createTelegramExtension(
				() => bot,
				() => ctx,
			);
			ctx.registerExtension("telegram", extension);
			logger.info("Registered Telegram extension");
		}

		// Refresh identity
		await refreshIdentity();

		// Validate config
		try {
			resolveToken();
		} catch (_err) {
			logger.warn(
				"No Telegram bot token configured. Run 'wopr configure --plugin telegram' to set up.",
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
		// Clear cross-plugin registrations to avoid stale entries on re-init
		registeredCommands.clear();
		registeredParsers.clear();

		// Unregister channel provider
		if (ctx?.unregisterChannelProvider) {
			ctx.unregisterChannelProvider("telegram");
		}

		// Unregister extension
		if (ctx?.unregisterExtension) {
			ctx.unregisterExtension("telegram");
		}

		// Cancel all active streams
		for (const [, { stream }] of activeStreams) {
			stream.cancel();
		}
		activeStreams.clear();

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
	validateTokenFilePath,
	downloadTelegramFile,
	sendPhoto,
	sendDocument,
	STANDARD_REACTIONS,
	isStandardReaction,
	telegramChannelProvider,
};
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
