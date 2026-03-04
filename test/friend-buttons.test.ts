/**
 * Tests for Telegram friend request button helpers.
 */

import { describe, expect, it, vi } from "vitest";

// Mock grammy before importing modules that depend on it
vi.mock("grammy", () => {
  class InlineKeyboard {
    private buttons: { text: string; callback_data: string }[][] = [[]];
    text(label: string, data: string) {
      this.buttons[this.buttons.length - 1].push({ text: label, callback_data: data });
      return this;
    }
    row() {
      this.buttons.push([]);
      return this;
    }
    get inline_keyboard() {
      return this.buttons.filter((r) => r.length > 0);
    }
  }
  return { InlineKeyboard };
});

import {
  FRIEND_CB_PREFIX,
  buildFriendRequestKeyboard,
  cleanupExpiredFriendRequests,
  formatFriendRequestMessage,
  getPendingFriendRequest,
  isFriendRequestCallback,
  isValidEd25519Pubkey,
  parseFriendRequestCallback,
  removePendingFriendRequest,
  setMessageIdOnPendingFriendRequest,
  storePendingFriendRequest,
} from "../src/friend-buttons.js";

const VALID_PUBKEY = "a".repeat(64);
const VALID_ENCRYPT_PUB = "b".repeat(64);

describe("isValidEd25519Pubkey", () => {
  it("accepts a 64-char hex string", () => {
    expect(isValidEd25519Pubkey("a".repeat(64))).toBe(true);
    expect(isValidEd25519Pubkey("0123456789abcdefABCDEF".padEnd(64, "0"))).toBe(true);
  });

  it("rejects strings that are too short or too long", () => {
    expect(isValidEd25519Pubkey("a".repeat(63))).toBe(false);
    expect(isValidEd25519Pubkey("a".repeat(65))).toBe(false);
  });

  it("rejects non-hex characters", () => {
    expect(isValidEd25519Pubkey("g".repeat(64))).toBe(false);
    expect(isValidEd25519Pubkey("z".repeat(64))).toBe(false);
  });

  it("rejects non-string values", () => {
    expect(isValidEd25519Pubkey(null as unknown as string)).toBe(false);
    expect(isValidEd25519Pubkey(undefined as unknown as string)).toBe(false);
  });
});

describe("storePendingFriendRequest", () => {
  it("stores a valid request and returns an id object", () => {
    const result = storePendingFriendRequest("alice", VALID_PUBKEY, VALID_ENCRYPT_PUB, "ch1", "sig1");
    expect(typeof result).toBe("object");
    const { id } = result as { id: string };
    expect(id).toBeDefined();
    expect(typeof id).toBe("string");
    const pending = getPendingFriendRequest(id);
    expect(pending).toBeDefined();
    expect(pending?.requestFrom).toBe("alice");
    expect(pending?.requestPubkey).toBe(VALID_PUBKEY);
    removePendingFriendRequest(id);
  });

  it("rejects invalid pubkey and returns error string", () => {
    const result = storePendingFriendRequest("alice", "not-a-key", VALID_ENCRYPT_PUB, "ch1", "sig1");
    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/Invalid public key/);
  });

  it("rejects invalid encryptPub and returns error string", () => {
    const result = storePendingFriendRequest("alice", VALID_PUBKEY, "not-a-key", "ch1", "sig1");
    expect(typeof result).toBe("string");
    expect(result as string).toMatch(/Invalid encryption public key/);
  });

  it("generates a unique id for each request", () => {
    const r1 = storePendingFriendRequest("alice", VALID_PUBKEY, VALID_ENCRYPT_PUB, "ch1", "sig1");
    const r2 = storePendingFriendRequest("bob", VALID_PUBKEY, VALID_ENCRYPT_PUB, "ch2", "sig2");
    expect(typeof r1).toBe("object");
    expect(typeof r2).toBe("object");
    const id1 = (r1 as { id: string }).id;
    const id2 = (r2 as { id: string }).id;
    expect(id1).not.toBe(id2);
    removePendingFriendRequest(id1);
    removePendingFriendRequest(id2);
  });

  it("allows multiple requests from the same username simultaneously", () => {
    const r1 = storePendingFriendRequest("alice", VALID_PUBKEY, VALID_ENCRYPT_PUB, "ch1", "sig1");
    const r2 = storePendingFriendRequest("alice", VALID_PUBKEY, VALID_ENCRYPT_PUB, "ch2", "sig2");
    expect(typeof r1).toBe("object");
    expect(typeof r2).toBe("object");
    const id1 = (r1 as { id: string }).id;
    const id2 = (r2 as { id: string }).id;
    // Both requests should be independently accessible
    expect(getPendingFriendRequest(id1)).toBeDefined();
    expect(getPendingFriendRequest(id2)).toBeDefined();
    removePendingFriendRequest(id1);
    removePendingFriendRequest(id2);
  });
});

describe("setMessageIdOnPendingFriendRequest", () => {
  it("sets the message ID on a stored request", () => {
    const result = storePendingFriendRequest("bob", VALID_PUBKEY, VALID_ENCRYPT_PUB, "ch2", "sig2");
    expect(typeof result).toBe("object");
    const { id } = result as { id: string };
    setMessageIdOnPendingFriendRequest(id, 99);
    const pending = getPendingFriendRequest(id);
    expect(pending?.messageId).toBe(99);
    removePendingFriendRequest(id);
  });

  it("does nothing when request does not exist", () => {
    expect(() => setMessageIdOnPendingFriendRequest("nonexistent-id", 1)).not.toThrow();
  });
});

describe("isFriendRequestCallback", () => {
  it("returns true for accept callback data", () => {
    expect(isFriendRequestCallback(`${FRIEND_CB_PREFIX.ACCEPT}abc123`)).toBe(true);
  });

  it("returns true for deny callback data", () => {
    expect(isFriendRequestCallback(`${FRIEND_CB_PREFIX.DENY}abc123`)).toBe(true);
  });

  it("returns false for other callback data", () => {
    expect(isFriendRequestCallback("model:gpt-4o")).toBe(false);
    expect(isFriendRequestCallback("help")).toBe(false);
    expect(isFriendRequestCallback("")).toBe(false);
  });
});

describe("parseFriendRequestCallback", () => {
  it("parses accept callback data", () => {
    const result = parseFriendRequestCallback(`${FRIEND_CB_PREFIX.ACCEPT}abc123`);
    expect(result).toEqual({ action: "accept", requestId: "abc123" });
  });

  it("parses deny callback data", () => {
    const result = parseFriendRequestCallback(`${FRIEND_CB_PREFIX.DENY}def456`);
    expect(result).toEqual({ action: "deny", requestId: "def456" });
  });

  it("returns null for unrecognised data", () => {
    expect(parseFriendRequestCallback("help")).toBeNull();
    expect(parseFriendRequestCallback("")).toBeNull();
  });
});

describe("buildFriendRequestKeyboard", () => {
  it("builds a keyboard with Accept and Deny buttons for a request ID", () => {
    const requestId = "abc1234567890def";
    const kb = buildFriendRequestKeyboard(requestId);
    const rows = kb.inline_keyboard;
    expect(rows).toHaveLength(1);
    const buttons = rows[0];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].text).toContain("Accept");
    expect(buttons[0].callback_data).toBe(`${FRIEND_CB_PREFIX.ACCEPT}${requestId}`);
    expect(buttons[1].text).toContain("Deny");
    expect(buttons[1].callback_data).toBe(`${FRIEND_CB_PREFIX.DENY}${requestId}`);
  });

  it("callback_data from a stored request fits within Telegram's 64-byte limit", () => {
    const result = storePendingFriendRequest("alice", VALID_PUBKEY, VALID_ENCRYPT_PUB, "ch1", "sig1");
    const { id } = result as { id: string };
    const kb = buildFriendRequestKeyboard(id);
    for (const button of kb.inline_keyboard[0]) {
      expect(button.callback_data!.length).toBeLessThanOrEqual(64);
    }
    removePendingFriendRequest(id);
  });
});

describe("formatFriendRequestMessage", () => {
  it("includes requestFrom, pubkey short, and channelName", () => {
    const msg = formatFriendRequestMessage("alice", VALID_PUBKEY, "my-channel");
    expect(msg).toContain("alice");
    expect(msg).toContain("aaaaaaaaaaaa...");
    expect(msg).toContain("my-channel");
    expect(msg).toContain("Friend Request Received");
  });

  it("HTML-escapes special characters in requestFrom and channelName", () => {
    const msg = formatFriendRequestMessage("<script>", VALID_PUBKEY, "<b>chan</b>");
    expect(msg).not.toContain("<script>");
    expect(msg).toContain("&lt;script&gt;");
    expect(msg).not.toContain("<b>chan</b>");
    expect(msg).toContain("&lt;b&gt;chan&lt;/b&gt;");
  });

  it("HTML-escapes ampersands in requestFrom", () => {
    const msg = formatFriendRequestMessage("alice&bob", VALID_PUBKEY, "chan");
    expect(msg).toContain("alice&amp;bob");
  });
});

describe("cleanupExpiredFriendRequests", () => {
  it("does not throw when called with no pending requests", () => {
    expect(() => cleanupExpiredFriendRequests()).not.toThrow();
  });
});
