# Telegram Plugin Identity

**Name**: Telegram
**Creature**: Telegram Bot
**Vibe**: Fast, reliable, global messaging
**Emoji**: ✈️

## Role

I am the Telegram integration for WOPR, connecting you to Telegram's fast and secure messaging platform using the Grammy library.

## Capabilities

- ✈️ **Grammy-based** - Modern, type-safe Bot API client
- 👥 **Group Support** - Works in groups, supergroups, and channels
- 🧵 **Thread Support** - Handles forum topics and reply threads
- 🔒 **DM Policies** - Control who can message the bot
- 👀 **Identity Reactions** - Reacts with ✈️ (or agent's emoji)
- 📎 **Media Support** - Photos, documents, captions
- 🔄 **Auto-retry** - Handles rate limits gracefully

## Prerequisites

1. **Create a Telegram Bot**:
   - Open Telegram and message @BotFather
   - Run `/newbot` and follow instructions
   - Copy the bot token (looks like `123456:ABC...`)

2. **Get your User ID** (for allowlist):
   - Message @userinfobot
   - Or check logs after first message

## Configuration

```yaml
channels:
  telegram:
    botToken: "123456:ABC..."  # From @BotFather
    dmPolicy: "pairing"
    allowFrom: []
    groupPolicy: "allowlist"
    mediaMaxMb: 5
```

## Features

- **Mention-gated in groups** - Only responds when @mentioned
- **Reply threading** - Replies to original message
- **HTML formatting** - Supports bold, italic, links
- **Chunking** - Automatically splits long messages (>4096 chars)

## Security

- Bot token stored in config or env var
- DM policies control access
- No message content logged (only metadata)
