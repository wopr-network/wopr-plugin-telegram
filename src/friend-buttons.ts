/**
 * Telegram Friend Request Buttons
 *
 * Creates inline keyboard Accept/Deny buttons for friend requests.
 * Sent as a DM to the bot owner when a p2p friend request arrives.
 */

import { InlineKeyboard } from "grammy";

// Align TTL with pairing code TTL (15 minutes)
const BUTTON_REQUEST_TTL_MS = 15 * 60 * 1000;

// Telegram callback_data max length is 64 bytes
const TG_CALLBACK_DATA_MAX_LENGTH = 64;
// "friend_accept:" = 14 chars (longest prefix)
const MAX_USERNAME_IN_CALLBACK_DATA = TG_CALLBACK_DATA_MAX_LENGTH - "friend_accept:".length;

export const FRIEND_CB_PREFIX = {
  ACCEPT: "friend_accept:",
  DENY: "friend_deny:",
} as const;

/**
 * Pending friend request with button context
 */
export interface PendingFriendRequest {
  requestFrom: string;
  requestPubkey: string;
  encryptPub: string;
  timestamp: number;
  channelId: string;
  messageId?: number;
  signature: string;
}

// Store pending friend requests (keyed by lowercase requestFrom)
const pendingFriendRequests: Map<string, PendingFriendRequest> = new Map();

/**
 * Validate an Ed25519 public key (32 bytes, hex-encoded = 64 chars)
 */
export function isValidEd25519Pubkey(pubkey: string): boolean {
  if (typeof pubkey !== "string") return false;
  return /^[0-9a-fA-F]{64}$/.test(pubkey);
}

/**
 * Truncate a username to fit within Telegram's 64-byte callback_data limit
 */
function truncateForCallbackData(username: string): string {
  if (username.length <= MAX_USERNAME_IN_CALLBACK_DATA) {
    return username;
  }
  return username.slice(0, MAX_USERNAME_IN_CALLBACK_DATA);
}

/**
 * Build Accept/Deny inline keyboard for a friend request
 */
export function buildFriendRequestKeyboard(requestFrom: string): InlineKeyboard {
  const truncatedFrom = truncateForCallbackData(requestFrom);
  return new InlineKeyboard()
    .text("✅ Accept", `${FRIEND_CB_PREFIX.ACCEPT}${truncatedFrom}`)
    .text("❌ Deny", `${FRIEND_CB_PREFIX.DENY}${truncatedFrom}`);
}

/**
 * Format a friend request notification message
 */
export function formatFriendRequestMessage(requestFrom: string, pubkey: string, channelName: string): string {
  const pubkeyShort = `${pubkey.slice(0, 12)}...`;
  return [
    "<b>Friend Request Received</b>",
    "",
    `<b>From:</b> @${requestFrom}`,
    `<b>Pubkey:</b> <code>${pubkeyShort}</code>`,
    `<b>Channel:</b> ${channelName}`,
    "",
    "Click Accept to add as friend, Deny to ignore.",
  ].join("\n");
}

/**
 * Store a pending friend request after validating pubkey format.
 * Returns an error string if validation fails, undefined on success.
 */
export function storePendingFriendRequest(
  requestFrom: string,
  pubkey: string,
  encryptPub: string,
  channelId: string,
  signature: string,
): string | undefined {
  if (!isValidEd25519Pubkey(pubkey)) {
    return "Invalid public key format (expected 64-char hex Ed25519 key)";
  }

  if (!isValidEd25519Pubkey(encryptPub)) {
    return "Invalid encryption public key format";
  }

  pendingFriendRequests.set(requestFrom.toLowerCase(), {
    requestFrom,
    requestPubkey: pubkey,
    encryptPub,
    timestamp: Date.now(),
    channelId,
    signature,
  });

  return undefined;
}

/**
 * Get a pending friend request
 */
export function getPendingFriendRequest(requestFrom: string): PendingFriendRequest | undefined {
  return pendingFriendRequests.get(requestFrom.toLowerCase());
}

/**
 * Remove a pending friend request
 */
export function removePendingFriendRequest(requestFrom: string): void {
  pendingFriendRequests.delete(requestFrom.toLowerCase());
}

/**
 * Bind a Telegram message ID to a pending friend request so we can verify provenance later
 */
export function setMessageIdOnPendingFriendRequest(requestFrom: string, messageId: number): void {
  const pending = pendingFriendRequests.get(requestFrom.toLowerCase());
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
 * Parse a friend request callback_data string
 */
export function parseFriendRequestCallback(data: string): { action: "accept" | "deny"; from: string } | null {
  if (data.startsWith(FRIEND_CB_PREFIX.ACCEPT)) {
    return { action: "accept", from: data.slice(FRIEND_CB_PREFIX.ACCEPT.length) };
  }
  if (data.startsWith(FRIEND_CB_PREFIX.DENY)) {
    return { action: "deny", from: data.slice(FRIEND_CB_PREFIX.DENY.length) };
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
