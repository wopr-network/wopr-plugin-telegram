/**
 * Inline Keyboard builders for Telegram bot interactions.
 *
 * Provides keyboard factories for common actions (help, model switching,
 * session management) and callback query data parsing.
 */

import { InlineKeyboard } from "grammy";

// ---------------------------------------------------------------------------
// Callback data prefix constants
// ---------------------------------------------------------------------------

export const CB_PREFIX = {
	HELP: "help",
	MODEL_SWITCH: "model:",
	MODEL_LIST: "model_list",
	SESSION_NEW: "session_new",
	SESSION_LIST: "session_list",
	SESSION_SWITCH: "session:",
	STATUS: "status",
} as const;

// ---------------------------------------------------------------------------
// Keyboard builders
// ---------------------------------------------------------------------------

/**
 * Build the main action keyboard shown after bot responses or on /help.
 */
export function buildMainKeyboard(): InlineKeyboard {
	return new InlineKeyboard()
		.text("Switch Model", CB_PREFIX.MODEL_LIST)
		.text("New Session", CB_PREFIX.SESSION_NEW)
		.row()
		.text("Status", CB_PREFIX.STATUS)
		.text("Help", CB_PREFIX.HELP);
}

/**
 * Build a dynamic model-selection keyboard from a list of model names.
 * Each button triggers a model switch callback.
 */
export function buildModelKeyboard(models: string[]): InlineKeyboard {
	const kb = new InlineKeyboard();
	// Lay out models in rows of 2
	for (let i = 0; i < models.length; i++) {
		kb.text(models[i], `${CB_PREFIX.MODEL_SWITCH}${models[i]}`);
		if (i % 2 === 1 && i < models.length - 1) {
			kb.row();
		}
	}
	return kb;
}

/**
 * Build a dynamic session-selection keyboard from a list of session keys.
 * Each button triggers a session switch callback.
 */
export function buildSessionKeyboard(sessions: string[]): InlineKeyboard {
	const kb = new InlineKeyboard();
	for (let i = 0; i < sessions.length; i++) {
		// Display a friendlier label: strip "telegram-dm:" / "telegram-group:" prefix
		const label = sessions[i].replace(/^telegram-(dm|group):/, "").slice(0, 30); // Telegram button labels max ~64 bytes; keep short
		kb.text(label, `${CB_PREFIX.SESSION_SWITCH}${sessions[i]}`);
		if (i % 2 === 1 && i < sessions.length - 1) {
			kb.row();
		}
	}
	return kb;
}

// ---------------------------------------------------------------------------
// Callback data parsing
// ---------------------------------------------------------------------------

export type CallbackAction =
	| { type: "help" }
	| { type: "model_list" }
	| { type: "model_switch"; model: string }
	| { type: "session_new" }
	| { type: "session_list" }
	| { type: "session_switch"; session: string }
	| { type: "status" }
	| { type: "unknown"; raw: string };

/**
 * Parse a callback query data string into a structured action.
 */
export function parseCallbackData(data: string): CallbackAction {
	if (data === CB_PREFIX.HELP) return { type: "help" };
	if (data === CB_PREFIX.MODEL_LIST) return { type: "model_list" };
	if (data === CB_PREFIX.SESSION_NEW) return { type: "session_new" };
	if (data === CB_PREFIX.SESSION_LIST) return { type: "session_list" };
	if (data === CB_PREFIX.STATUS) return { type: "status" };

	if (data.startsWith(CB_PREFIX.MODEL_SWITCH)) {
		return {
			type: "model_switch",
			model: data.slice(CB_PREFIX.MODEL_SWITCH.length),
		};
	}
	if (data.startsWith(CB_PREFIX.SESSION_SWITCH)) {
		return {
			type: "session_switch",
			session: data.slice(CB_PREFIX.SESSION_SWITCH.length),
		};
	}

	return { type: "unknown", raw: data };
}
