import type { Bot, Context } from "grammy";
import type winston from "winston";
import { sendMessage } from "./attachments.js";
import {
  getPendingFriendRequest,
  isFriendRequestCallback,
  parseFriendRequestCallback,
  removePendingFriendRequest,
} from "./friend-buttons.js";
import { buildMainKeyboard, buildModelKeyboard, parseCallbackData } from "./keyboards.js";
import { checkCommandAuth, getDisplayName, getSessionKey, injectCommandMessage, isAllowed } from "./message-handler.js";
import type { AgentIdentity, ChannelRef, TelegramConfig, WOPRPluginContext } from "./types.js";

// Bot command definitions for BotFather menu
export const botCommands = [
  { command: "ask", description: "Ask WOPR a question" },
  { command: "model", description: "Switch AI model (e.g. /model gpt-4o)" },
  { command: "session", description: "Switch to a named session" },
  { command: "status", description: "Show current session status" },
  { command: "claim", description: "Claim bot ownership with pairing code" },
  { command: "help", description: "Show available commands" },
];

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
  const chatTitle = "title" in chat ? (chat as { title?: string }).title : undefined;
  return {
    type: "telegram",
    id: channelId,
    name: chatTitle || user.first_name || "Telegram",
  };
}

// Register command handlers on the bot instance
export function registerCommandHandlers(
  botInstance: Bot,
  ctx: WOPRPluginContext,
  config: TelegramConfig,
  identity: AgentIdentity,
  logger: winston.Logger,
): void {
  // /ask <question> - Ask WOPR a question
  botInstance.command("ask", async (grammyCtx) => {
    if (await checkCommandAuth(grammyCtx, config, logger)) return;
    const question = typeof grammyCtx.match === "string" ? grammyCtx.match.trim() : "";
    if (!question) {
      await grammyCtx.reply("Usage: /ask <your question>\n\nExample: /ask What is the meaning of life?");
      return;
    }
    await injectCommandMessage(grammyCtx, botInstance, ctx, logger, question);
  });

  // /model <name> - Switch AI model
  botInstance.command("model", async (grammyCtx) => {
    if (await checkCommandAuth(grammyCtx, config, logger)) return;
    const modelName = typeof grammyCtx.match === "string" ? grammyCtx.match.trim() : "";
    if (!modelName) {
      await grammyCtx.reply("Usage: /model <model-name>\n\nExample: /model gpt-4o\nExample: /model opus");
      return;
    }
    await injectCommandMessage(grammyCtx, botInstance, ctx, logger, `/model ${modelName}`);
  });

  // /session <name> - Switch to a named session
  botInstance.command("session", async (grammyCtx) => {
    if (await checkCommandAuth(grammyCtx, config, logger)) return;
    const sessionName = typeof grammyCtx.match === "string" ? grammyCtx.match.trim() : "";
    if (!sessionName) {
      await grammyCtx.reply("Usage: /session <name>\n\nExample: /session project-alpha");
      return;
    }
    await injectCommandMessage(grammyCtx, botInstance, ctx, logger, `/session ${sessionName}`);
  });

  // /status - Show session status
  botInstance.command("status", async (grammyCtx) => {
    if (await checkCommandAuth(grammyCtx, config, logger)) return;
    if (!grammyCtx.chat) {
      await grammyCtx.reply("Bot is not connected to WOPR.");
      return;
    }
    const sessionKey = getSessionKey(grammyCtx);
    const sessions = ctx.getSessions();
    const isActive = sessions.includes(sessionKey);

    const statusLines = [
      `<b>Session Status</b>`,
      ``,
      `<b>Bot:</b> ${identity.name || "WOPR"}`,
      `<b>Session:</b> <code>${sessionKey}</code>`,
      `<b>Active:</b> ${isActive ? "Yes" : "No"}`,
      `<b>Active Sessions:</b> ${sessions.length}`,
    ];
    await sendMessage(botInstance, logger, grammyCtx.chat.id, statusLines.join("\n"), {
      replyToMessageId: grammyCtx.message?.message_id,
      reply_markup: buildMainKeyboard(),
    });
  });

  // /claim <code> - Claim bot ownership
  botInstance.command("claim", async (grammyCtx) => {
    if (await checkCommandAuth(grammyCtx, config, logger)) return;
    const chat = grammyCtx.chat;
    if (!chat) return;
    const isGroup = chat.type === "group" || chat.type === "supergroup";
    if (isGroup) {
      await grammyCtx.reply("The /claim command only works in DMs. Please DM me to claim ownership.");
      return;
    }
    const code = typeof grammyCtx.match === "string" ? grammyCtx.match.trim() : "";
    if (!code) {
      await grammyCtx.reply("Usage: /claim <pairing-code>\n\nExample: /claim ABC123");
      return;
    }
    await injectCommandMessage(grammyCtx, botInstance, ctx, logger, `/claim ${code}`);
  });

  // /help - Show available commands
  botInstance.command("help", async (grammyCtx) => {
    if (await checkCommandAuth(grammyCtx, config, logger)) return;
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
    await sendMessage(botInstance, logger, grammyCtx.chat.id, helpText.join("\n"), {
      replyToMessageId: grammyCtx.message?.message_id,
      reply_markup: buildMainKeyboard(),
    });
  });
}

// Register callback query handlers for inline keyboard buttons
export function registerCallbackHandlers(
  botInstance: Bot,
  ctx: WOPRPluginContext,
  config: TelegramConfig,
  identity: AgentIdentity,
  logger: winston.Logger,
): void {
  botInstance.on("callback_query:data", async (grammyCtx) => {
    const data = grammyCtx.callbackQuery.data;
    const action = parseCallbackData(data);
    const chatId = grammyCtx.callbackQuery.message?.chat.id;

    if (!chatId) {
      await grammyCtx.answerCallbackQuery({ text: "Bot is not ready." });
      return;
    }

    // Handle friend request accept/deny buttons — owner DM only
    if (isFriendRequestCallback(data)) {
      // Verify callback is from the configured owner chat to prevent unauthorized use
      if (!config.ownerChatId || String(chatId) !== String(config.ownerChatId)) {
        await grammyCtx.answerCallbackQuery({ text: "Not authorized." });
        return;
      }

      const parsed = parseFriendRequestCallback(data);
      if (!parsed) {
        await grammyCtx.answerCallbackQuery({ text: "Invalid button." });
        return;
      }

      const pending = getPendingFriendRequest(parsed.requestId);
      if (!pending) {
        await grammyCtx.answerCallbackQuery({ text: "Friend request expired or already handled." });
        return;
      }

      const p2pExt = ctx.getExtension?.("p2p") as
        | {
            acceptFriendRequest?: (
              from: string,
              pending: { requestPubkey: string; encryptPub: string; channelId: string; signature: string },
            ) => Promise<string>;
            denyFriendRequest?: (from: string, signature: string) => Promise<void>;
          }
        | undefined;

      if (parsed.action === "accept") {
        try {
          await grammyCtx.answerCallbackQuery({ text: "Accepting..." });
          const acceptMessage = p2pExt?.acceptFriendRequest
            ? await p2pExt.acceptFriendRequest(pending.requestFrom, pending)
            : `Friend request from ${pending.requestFrom} accepted.`;
          removePendingFriendRequest(parsed.requestId);
          await sendMessage(
            botInstance,
            logger,
            chatId,
            `Friend request from <b>${pending.requestFrom}</b> <b>accepted</b>.\n\n${acceptMessage}`,
          );
          logger.info(`[telegram] Friend request from ${pending.requestFrom} accepted via button`);
        } catch (err) {
          logger.error(`[telegram] Failed to accept friend request from ${pending.requestFrom}:`, err);
          await sendMessage(botInstance, logger, chatId, `Failed to accept friend request: ${String(err)}`);
        }
      } else {
        try {
          await grammyCtx.answerCallbackQuery({ text: "Denying..." });
          if (p2pExt?.denyFriendRequest) {
            await p2pExt.denyFriendRequest(pending.requestFrom, pending.signature);
          }
          removePendingFriendRequest(parsed.requestId);
          await sendMessage(
            botInstance,
            logger,
            chatId,
            `Friend request from <b>${pending.requestFrom}</b> <b>denied</b>.`,
          );
          logger.info(`[telegram] Friend request from ${pending.requestFrom} denied via button`);
        } catch (err) {
          logger.error(`[telegram] Failed to deny friend request from ${pending.requestFrom}:`, err);
          await sendMessage(botInstance, logger, chatId, `Failed to deny friend request: ${String(err)}`);
        }
      }
      return;
    }

    // Check authorization
    const user = grammyCtx.from;
    const chat = grammyCtx.callbackQuery.message?.chat;
    if (chat && user) {
      const isGroup = chat.type === "group" || chat.type === "supergroup";
      if (!isAllowed(config, String(user.id), user.username, isGroup)) {
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
          await sendMessage(botInstance, logger, chatId, helpText.join("\n"), {
            reply_markup: buildMainKeyboard(),
          });
          break;
        }

        case "model_list": {
          await grammyCtx.answerCallbackQuery();
          // Default model list — WOPR core does not expose a getModels() API
          // to plugins, so we provide common model names as quick-switch options.
          const defaultModels = ["opus", "sonnet", "haiku", "gpt-4o", "gpt-4o-mini"];
          const kb = buildModelKeyboard(defaultModels);
          await sendMessage(botInstance, logger, chatId, "<b>Select a model:</b>", {
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
            const response = await ctx.inject(sessionKey, `[${from}]: /model ${action.model}`, {
              from,
              channel: channelInfo,
            });
            await sendMessage(botInstance, logger, chatId, response, {
              reply_markup: buildMainKeyboard(),
            });
          } catch (err) {
            logger.error("Model switch callback failed:", err);
            await sendMessage(botInstance, logger, chatId, "Failed to switch model. Try /model &lt;name&gt; instead.");
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
            const response = await ctx.inject(newSessionName, `[${from}]: /session ${newSessionName}`, {
              from,
              channel: channelInfo,
            });
            await sendMessage(botInstance, logger, chatId, response, {
              reply_markup: buildMainKeyboard(),
            });
          } catch (err) {
            logger.error("New session callback failed:", err);
            await sendMessage(botInstance, logger, chatId, "Failed to create new session.");
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
            const response = await ctx.inject(action.session, `[${from}]: /session ${action.session}`, {
              from,
              channel: channelInfo,
            });
            await sendMessage(botInstance, logger, chatId, response, {
              reply_markup: buildMainKeyboard(),
            });
          } catch (err) {
            logger.error("Session switch callback failed:", err);
            await sendMessage(botInstance, logger, chatId, "Failed to switch session.");
          }
          break;
        }

        case "status": {
          await grammyCtx.answerCallbackQuery();
          const sessionKey = getSessionKeyFromCallback(grammyCtx);
          const sessions = ctx.getSessions();
          const isActive = sessions.includes(sessionKey);
          const statusLines = [
            `<b>Session Status</b>`,
            ``,
            `<b>Bot:</b> ${identity.name || "WOPR"}`,
            `<b>Session:</b> <code>${sessionKey}</code>`,
            `<b>Active:</b> ${isActive ? "Yes" : "No"}`,
            `<b>Active Sessions:</b> ${sessions.length}`,
          ];
          await sendMessage(botInstance, logger, chatId, statusLines.join("\n"), {
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
