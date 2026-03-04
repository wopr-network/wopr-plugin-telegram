/**
 * Tests for Telegram friend request button helpers.
 */

import { describe, expect, it } from "vitest";
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
  it("stores a valid request and returns undefined", () => {
    const err = storePendingFriendRequest("alice", VALID_PUBKEY, VALID_ENCRYPT_PUB, "ch1", "sig1");
    expect(err).toBeUndefined();
    const pending = getPendingFriendRequest("alice");
    expect(pending).toBeDefined();
    expect(pending?.requestFrom).toBe("alice");
    expect(pending?.requestPubkey).toBe(VALID_PUBKEY);
    removePendingFriendRequest("alice");
  });

  it("rejects invalid pubkey and returns error string", () => {
    const err = storePendingFriendRequest("alice", "not-a-key", VALID_ENCRYPT_PUB, "ch1", "sig1");
    expect(err).toMatch(/Invalid public key/);
    expect(getPendingFriendRequest("alice")).toBeUndefined();
  });

  it("rejects invalid encryptPub and returns error string", () => {
    const err = storePendingFriendRequest("alice", VALID_PUBKEY, "not-a-key", "ch1", "sig1");
    expect(err).toMatch(/Invalid encryption public key/);
    expect(getPendingFriendRequest("alice")).toBeUndefined();
  });

  it("is case-insensitive for lookup", () => {
    storePendingFriendRequest("Alice", VALID_PUBKEY, VALID_ENCRYPT_PUB, "ch1", "sig1");
    expect(getPendingFriendRequest("alice")).toBeDefined();
    expect(getPendingFriendRequest("ALICE")).toBeDefined();
    removePendingFriendRequest("Alice");
  });
});

describe("setMessageIdOnPendingFriendRequest", () => {
  it("sets the message ID on a stored request", () => {
    storePendingFriendRequest("bob", VALID_PUBKEY, VALID_ENCRYPT_PUB, "ch2", "sig2");
    setMessageIdOnPendingFriendRequest("bob", 99);
    const pending = getPendingFriendRequest("bob");
    expect(pending?.messageId).toBe(99);
    removePendingFriendRequest("bob");
  });

  it("does nothing when request does not exist", () => {
    expect(() => setMessageIdOnPendingFriendRequest("nonexistent", 1)).not.toThrow();
  });
});

describe("isFriendRequestCallback", () => {
  it("returns true for accept callback data", () => {
    expect(isFriendRequestCallback(`${FRIEND_CB_PREFIX.ACCEPT}alice`)).toBe(true);
  });

  it("returns true for deny callback data", () => {
    expect(isFriendRequestCallback(`${FRIEND_CB_PREFIX.DENY}alice`)).toBe(true);
  });

  it("returns false for other callback data", () => {
    expect(isFriendRequestCallback("model:gpt-4o")).toBe(false);
    expect(isFriendRequestCallback("help")).toBe(false);
    expect(isFriendRequestCallback("")).toBe(false);
  });
});

describe("parseFriendRequestCallback", () => {
  it("parses accept callback data", () => {
    const result = parseFriendRequestCallback(`${FRIEND_CB_PREFIX.ACCEPT}alice`);
    expect(result).toEqual({ action: "accept", from: "alice" });
  });

  it("parses deny callback data", () => {
    const result = parseFriendRequestCallback(`${FRIEND_CB_PREFIX.DENY}bob`);
    expect(result).toEqual({ action: "deny", from: "bob" });
  });

  it("returns null for unrecognised data", () => {
    expect(parseFriendRequestCallback("help")).toBeNull();
    expect(parseFriendRequestCallback("")).toBeNull();
  });
});

describe("buildFriendRequestKeyboard", () => {
  it("builds a keyboard with Accept and Deny buttons", () => {
    const kb = buildFriendRequestKeyboard("alice");
    // InlineKeyboard has an `inline_keyboard` property that is an array of rows
    const rows = kb.inline_keyboard;
    expect(rows).toHaveLength(1);
    const buttons = rows[0];
    expect(buttons).toHaveLength(2);
    expect(buttons[0].text).toContain("Accept");
    expect(buttons[0].callback_data).toBe(`${FRIEND_CB_PREFIX.ACCEPT}alice`);
    expect(buttons[1].text).toContain("Deny");
    expect(buttons[1].callback_data).toBe(`${FRIEND_CB_PREFIX.DENY}alice`);
  });

  it("truncates long usernames to fit Telegram callback_data limit", () => {
    const longUsername = "a".repeat(100);
    const kb = buildFriendRequestKeyboard(longUsername);
    const rows = kb.inline_keyboard;
    const acceptButton = rows[0][0];
    expect(acceptButton.callback_data!.length).toBeLessThanOrEqual(64);
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
});

describe("cleanupExpiredFriendRequests", () => {
  it("does not throw when called with no pending requests", () => {
    expect(() => cleanupExpiredFriendRequests()).not.toThrow();
  });
});
