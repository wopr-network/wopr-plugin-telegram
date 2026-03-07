import path from "node:path";
import winston from "winston";

export function initLogger(): winston.Logger {
  const WOPR_HOME = process.env.WOPR_HOME || path.join(process.env.HOME || "~", ".wopr");
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
        format: winston.format.combine(winston.format.colorize(), winston.format.simple()),
        level: "warn",
      }),
    ],
  });
}
