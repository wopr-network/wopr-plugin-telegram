import type { Bot } from "grammy";
import type winston from "winston";
import type { sendMessage } from "./attachments.js";
import type { ChannelCommand, ChannelMessageParser, ChannelProvider } from "./types.js";

const registeredCommands: Map<string, ChannelCommand> = new Map();
const registeredParsers: Map<string, ChannelMessageParser> = new Map();

export function getRegisteredCommand(name: string): ChannelCommand | undefined {
  return registeredCommands.get(name);
}

export function getRegisteredParsers(): IterableIterator<ChannelMessageParser> {
  return registeredParsers.values();
}

export function clearRegistrations(): void {
  registeredCommands.clear();
  registeredParsers.clear();
}

export function createChannelProvider(
  getBot: () => Bot | null,
  getLogger: () => winston.Logger,
  sendMsg: typeof sendMessage,
): ChannelProvider {
  return {
    id: "telegram",

    registerCommand(cmd: ChannelCommand): void {
      registeredCommands.set(cmd.name, cmd);
      getLogger()?.info(`Channel command registered: ${cmd.name}`);
    },

    unregisterCommand(name: string): void {
      registeredCommands.delete(name);
    },

    getCommands(): ChannelCommand[] {
      return Array.from(registeredCommands.values());
    },

    addMessageParser(parser: ChannelMessageParser): void {
      registeredParsers.set(parser.id, parser);
      getLogger()?.info(`Message parser registered: ${parser.id}`);
    },

    removeMessageParser(id: string): void {
      registeredParsers.delete(id);
    },

    getMessageParsers(): ChannelMessageParser[] {
      return Array.from(registeredParsers.values());
    },

    async send(channel: string, content: string): Promise<void> {
      const bot = getBot();
      if (!bot) throw new Error("Telegram bot not initialized");
      // Channel ID may be a raw chat ID or prefixed (dm:123, group:456)
      const chatId = channel.replace(/^(dm|group):/, "");
      await sendMsg(bot, getLogger(), chatId, content);
    },

    getBotUsername(): string {
      return getBot()?.botInfo?.username || "unknown";
    },
  };
}
