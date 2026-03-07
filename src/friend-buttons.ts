/**
 * Telegram Friend Request Buttons
 *
 * Creates inline keyboard Accept/Deny buttons for friend requests.
 * Sent as a DM to the bot owner when a p2p friend request arrives.
 */

import crypto from "node:crypto";
import { InlineKeyboard } from "grammy";

// Align TTL with pairing code TTL (15 minutes)
const BUTTON_REQUEST_TTL_MS = 15 * 60 * 1000;

// Request IDs are 8 random bytes (16 hex chars), well within Telegram's 64-byte
// callback_data limit (64 - len("friend_accept:") = 50 chars available).
const REQUEST_ID_BYTES = 8;

export const FRIEND_CB_PREFIX = {
  ACCEPT: "friend_accept:",
  DENY: "friend_deny:",
} as const;

/**
 * Pending friend request with button context
 */
export interface PendingFriendRequest {
  id: string;
  requestFrom: string;
  requestPubkey: string;
  encryptPub: string;
  timestamp: number;
  channelId: string;
  messageId?: number;
  signature: string;
}

// Store pending friend requests (keyed by stable random request ID)
const pendingFriendRequests: Map<string, PendingFriendRequest> = new Map();

/**
 * Escape HTML special characters to prevent injection in Telegram HTML parse mode
 */
function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/**
 * Validate an Ed25519 public key (32 bytes, hex-encoded = 64 chars)
 */
export function isValidEd25519Pubkey(pubkey: string): boolean {
  if (typeof pubkey !== "string") return false;
  return /^[0-9a-fA-F]{64}$/.test(pubkey);
}

/**
 * Build Accept/Deny inline keyboard for a friend request, keyed by stable request ID.
 */
export function buildFriendRequestKeyboard(requestId: string): InlineKeyboard {
  return new InlineKeyboard()
    .text("✅ Accept", `${FRIEND_CB_PREFIX.ACCEPT}${requestId}`)
    .text("❌ Deny", `${FRIEND_CB_PREFIX.DENY}${requestId}`);
}

/**
 * Format a friend request notification message.
 * User-supplied strings are HTML-escaped to prevent injection.
 */
export function formatFriendRequestMessage(requestFrom: string, pubkey: string, channelName: string): string {
  const pubkeyShort = `${pubkey.slice(0, 12)}...`;
  return [
    "<b>Friend Request Received</b>",
    "",
    `<b>From:</b> @${escapeHtml(requestFrom)}`,
    `<b>Pubkey:</b> <code>${pubkeyShort}</code>`,
    `<b>Channel:</b> ${escapeHtml(channelName)}`,
    "",
    "Click Accept to add as friend, Deny to ignore.",
  ].join("\n");
}

/**
 * Store a pending friend request after validating pubkey format.
 * Returns `{ id }` on success, or an error string if validation fails.
 * Runs cleanup of expired requests before storing to keep the map bounded.
 */
export function storePendingFriendRequest(
  requestFrom: string,
  pubkey: string,
  encryptPub: string,
  channelId: string,
  signature: string,
): { id: string } | string {
  if (!isValidEd25519Pubkey(pubkey)) {
    return "Invalid public key format (expected 64-char hex Ed25519 key)";
  }

  if (!isValidEd25519Pubkey(encryptPub)) {
    return "Invalid encryption public key format";
  }

  // Evict stale entries before adding a new one to keep the map bounded
  cleanupExpiredFriendRequests();

  const id = crypto.randomBytes(REQUEST_ID_BYTES).toString("hex");
  pendingFriendRequests.set(id, {
    id,
    requestFrom,
    requestPubkey: pubkey,
    encryptPub,
    timestamp: Date.now(),
    channelId,
    signature,
  });

  return { id };
}

/**
 * Get a pending friend request by its stable request ID.
 * Returns undefined if not found or if the request has expired (and removes it).
 */
export function getPendingFriendRequest(requestId: string): PendingFriendRequest | undefined {
  const pending = pendingFriendRequests.get(requestId);
  if (!pending) return undefined;

  if (Date.now() - pending.timestamp > BUTTON_REQUEST_TTL_MS) {
    pendingFriendRequests.delete(requestId);
    return undefined;
  }

  return pending;
}

/**
 * Remove a pending friend request by its stable request ID
 */
export function removePendingFriendRequest(requestId: string): void {
  pendingFriendRequests.delete(requestId);
}

/**
 * Bind a Telegram message ID to a pending friend request so we can verify provenance later
 */
export function setMessageIdOnPendingFriendRequest(requestId: string, messageId: number): void {
  const pending = pendingFriendRequests.get(requestId);
  if (pending) {
    pending.messageId = messageId;
  }
}

/**
 * Check if a callback_data string is a friend request button
 */
export function isFriendRequestCallback(data: string): boolean {
  return data.startsWith(FRIEND_CB_PREFIX.ACCEPT) || data.startsWith(FRIEND_CB_PREFIX.DENY);
}

/**
 * Parse a friend request callback_data string.
 * Returns `{ action, requestId }` where requestId is the stable random ID.
 */
export function parseFriendRequestCallback(data: string): { action: "accept" | "deny"; requestId: string } | null {
  if (data.startsWith(FRIEND_CB_PREFIX.ACCEPT)) {
    return { action: "accept", requestId: data.slice(FRIEND_CB_PREFIX.ACCEPT.length) };
  }
  if (data.startsWith(FRIEND_CB_PREFIX.DENY)) {
    return { action: "deny", requestId: data.slice(FRIEND_CB_PREFIX.DENY.length) };
  }
  return null;
}

/**
 * Clean up expired pending requests (older than TTL)
 */
export function cleanupExpiredFriendRequests(): void {
  const now = Date.now();
  for (const [key, request] of pendingFriendRequests) {
    if (now - request.timestamp > BUTTON_REQUEST_TTL_MS) {
      pendingFriendRequests.delete(key);
    }
  }
}
