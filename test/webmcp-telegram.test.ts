/**
 * Tests for WebMCP Telegram tool registration.
 *
 * Validates correct API endpoints, auth headers, URL encoding,
 * and error handling for the browser-side WebMCP tool layer.
 */

import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  type AuthContext,
  type WebMCPRegistry,
  registerTelegramTools,
} from "../src/webmcp-telegram.js";

// Mock global fetch
const mockFetch = vi.fn();
vi.stubGlobal("fetch", mockFetch);

function mockJsonResponse(data: unknown, ok = true, status = 200) {
  return {
    ok,
    status,
    json: vi.fn().mockResolvedValue(data),
  };
}

function createRegistry(): WebMCPRegistry {
  const tools = new Map<string, { name: string; handler: Function; [k: string]: unknown }>();
  return {
    register(tool: { name: string; handler: Function }) {
      tools.set(tool.name, tool);
    },
    get(name: string) {
      return tools.get(name) as any;
    },
    list() {
      return [...tools.keys()];
    },
  };
}

function getTool(registry: WebMCPRegistry, name: string) {
  const tool = registry.get(name);
  if (!tool) throw new Error(`Tool "${name}" not registered`);
  return tool;
}

describe("registerTelegramTools", () => {
  let registry: WebMCPRegistry;
  const API_BASE = "/api";

  beforeEach(() => {
    registry = createRegistry();
    mockFetch.mockReset();
  });

  it("should register all 3 tools", () => {
    registerTelegramTools(registry, API_BASE);

    const names = registry.list();
    expect(names).toHaveLength(3);
    expect(names).toContain("getTelegramStatus");
    expect(names).toContain("listTelegramChats");
    expect(names).toContain("getTelegramMessageStats");
  });

  it("should use default apiBase when not provided", () => {
    registerTelegramTools(registry);

    expect(registry.list()).toHaveLength(3);
  });

  describe("getTelegramStatus", () => {
    it("should GET /plugins/telegram/status", async () => {
      const status = { online: true, username: "wopr_bot", latencyMs: -1 };
      mockFetch.mockResolvedValue(mockJsonResponse(status));
      registerTelegramTools(registry, API_BASE);

      const tool = getTool(registry, "getTelegramStatus");
      const result = await tool.handler({}, {});

      expect(mockFetch).toHaveBeenCalledWith(
        "/api/plugins/telegram/status",
        expect.any(Object),
      );
      expect(result).toEqual(status);
    });

    it("should include bearer token when auth.token is present", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ online: true }));
      registerTelegramTools(registry, API_BASE);

      const tool = getTool(registry, "getTelegramStatus");
      const auth: AuthContext = { token: "my-token" };
      await tool.handler({}, auth);

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe("Bearer my-token");
    });

    it("should not include Authorization header when no token", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ online: false }));
      registerTelegramTools(registry, API_BASE);

      const tool = getTool(registry, "getTelegramStatus");
      await tool.handler({}, {});

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBeUndefined();
    });
  });

  describe("listTelegramChats", () => {
    it("should GET /plugins/telegram/chats", async () => {
      const chats = { chats: [{ id: "12345", type: "dm", name: "DM 12345" }] };
      mockFetch.mockResolvedValue(mockJsonResponse(chats));
      registerTelegramTools(registry, API_BASE);

      const tool = getTool(registry, "listTelegramChats");
      const result = await tool.handler({}, {});

      expect(mockFetch).toHaveBeenCalledWith(
        "/api/plugins/telegram/chats",
        expect.any(Object),
      );
      expect(result).toEqual(chats);
    });

    it("should include bearer token in auth header", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ chats: [] }));
      registerTelegramTools(registry, API_BASE);

      const tool = getTool(registry, "listTelegramChats");
      await tool.handler({}, { token: "tok-chats" });

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe("Bearer tok-chats");
    });
  });

  describe("getTelegramMessageStats", () => {
    it("should GET /plugins/telegram/stats", async () => {
      const stats = { sessionsActive: 5, activeConversations: 5 };
      mockFetch.mockResolvedValue(mockJsonResponse(stats));
      registerTelegramTools(registry, API_BASE);

      const tool = getTool(registry, "getTelegramMessageStats");
      const result = await tool.handler({}, {});

      expect(mockFetch).toHaveBeenCalledWith(
        "/api/plugins/telegram/stats",
        expect.any(Object),
      );
      expect(result).toEqual(stats);
    });

    it("should include bearer token in auth header", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({ sessionsActive: 0 }));
      registerTelegramTools(registry, API_BASE);

      const tool = getTool(registry, "getTelegramMessageStats");
      await tool.handler({}, { token: "tok-stats" });

      const headers = mockFetch.mock.calls[0][1].headers;
      expect(headers.Authorization).toBe("Bearer tok-stats");
    });
  });

  describe("error handling", () => {
    it("should throw on non-ok response with error from body", async () => {
      mockFetch.mockResolvedValue(
        mockJsonResponse({ error: "Telegram plugin not loaded" }, false, 404),
      );
      registerTelegramTools(registry, API_BASE);

      const tool = getTool(registry, "getTelegramStatus");

      await expect(tool.handler({}, {})).rejects.toThrow("Telegram plugin not loaded");
    });

    it("should throw with status code when body has no error field", async () => {
      mockFetch.mockResolvedValue(mockJsonResponse({}, false, 500));
      registerTelegramTools(registry, API_BASE);

      const tool = getTool(registry, "listTelegramChats");

      await expect(tool.handler({}, {})).rejects.toThrow("Request failed (500)");
    });

    it("should handle json parse failure on error response", async () => {
      mockFetch.mockResolvedValue({
        ok: false,
        status: 502,
        json: vi.fn().mockRejectedValue(new Error("invalid json")),
      });
      registerTelegramTools(registry, API_BASE);

      const tool = getTool(registry, "getTelegramMessageStats");

      await expect(tool.handler({}, {})).rejects.toThrow("Request failed");
    });
  });
});
