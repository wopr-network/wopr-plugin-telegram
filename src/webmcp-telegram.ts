/**
 * WebMCP Telegram Tools
 *
 * Registers 3 read-only browser-side WebMCP tools for Telegram bot
 * connection status, active chat listing, and message stats.
 *
 * These tools call the WOPR daemon REST API via fetch() and are only
 * meaningful when the Telegram plugin is loaded on the instance.
 */

// ============================================================================
// Types (mirrors WebMCPRegistry from wopr-plugin-webui)
// ============================================================================

export interface AuthContext {
	token?: string;
	[key: string]: unknown;
}

export interface ParameterSchema {
	type: string;
	description: string;
	required?: boolean;
}

export interface WebMCPTool {
	name: string;
	description: string;
	parameters: Record<string, ParameterSchema>;
	handler: (
		params: Record<string, unknown>,
		auth: AuthContext,
	) => Promise<unknown>;
}

export interface WebMCPRegistry {
	register(tool: WebMCPTool): void;
	get(name: string): WebMCPTool | undefined;
	list(): string[];
}

// ============================================================================
// Internal helpers
// ============================================================================

interface RequestOptions {
	method?: string;
	body?: string;
	headers?: Record<string, string>;
}

async function daemonRequest<T>(
	apiBase: string,
	path: string,
	auth: AuthContext,
	options?: RequestOptions,
): Promise<T> {
	const headers: Record<string, string> = {
		"Content-Type": "application/json",
		...options?.headers,
	};
	if (auth.token) {
		headers.Authorization = `Bearer ${auth.token as string}`;
	}
	const res = await fetch(`${apiBase}${path}`, {
		...options,
		headers,
	});
	if (!res.ok) {
		const err = await res.json().catch(() => ({ error: "Request failed" }));
		throw new Error(
			(err as { error?: string }).error || `Request failed (${res.status})`,
		);
	}
	return res.json() as Promise<T>;
}

// ============================================================================
// Tool registration
// ============================================================================

/**
 * Register all 3 Telegram WebMCP tools on the given registry.
 *
 * The tools proxy to the Telegram plugin extension via daemon API endpoints
 * at `/plugins/telegram/status`, `/plugins/telegram/chats`, etc.
 *
 * @param registry - The WebMCPRegistry instance to register tools on
 * @param apiBase  - Base URL of the WOPR daemon API (e.g. "/api" or "http://localhost:7437")
 */
export function registerTelegramTools(
	registry: WebMCPRegistry,
	apiBase = "/api",
): void {
	// 1. getTelegramStatus
	registry.register({
		name: "getTelegramStatus",
		description:
			"Get Telegram bot connection status: online/offline, username, and latency.",
		parameters: {},
		handler: async (_params: Record<string, unknown>, auth: AuthContext) => {
			return daemonRequest(apiBase, "/plugins/telegram/status", auth);
		},
	});

	// 2. listTelegramChats
	registry.register({
		name: "listTelegramChats",
		description:
			"List active Telegram chats and groups the bot is participating in.",
		parameters: {},
		handler: async (_params: Record<string, unknown>, auth: AuthContext) => {
			return daemonRequest(apiBase, "/plugins/telegram/chats", auth);
		},
	});

	// 3. getTelegramMessageStats
	registry.register({
		name: "getTelegramMessageStats",
		description:
			"Get Telegram message processing statistics: active sessions and conversations.",
		parameters: {},
		handler: async (_params: Record<string, unknown>, auth: AuthContext) => {
			return daemonRequest(apiBase, "/plugins/telegram/stats", auth);
		},
	});
}
