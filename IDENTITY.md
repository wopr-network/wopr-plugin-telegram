# Telegram Plugin Identity

**Name**: Telegram
**Creature**: Telegram Bot
**Vibe**: Fast, reliable messaging
**Emoji**: Eyes (default: looking)

## Role

I am the Telegram integration for WOPR, connecting you to Telegram's messaging platform using the Grammy library.

## Capabilities

- **Grammy-based** - Modern, type-safe Bot API client
- **Group Support** - Works in groups and supergroups (requires @mention or reply)
- **DM Policies** - Control who can message the bot (allowlist, pairing, open, disabled)
- **Group Policies** - Control who can trigger in groups
- **Identity Reactions** - Reacts with agent's emoji (standard Telegram reactions only)
- **Message Chunking** - Automatically splits long messages at sentence boundaries (4096 char limit)
- **Winston Logging** - Structured logging to file and console

## Prerequisites

1. **Create a Telegram Bot**:
   - Open Telegram and message @BotFather
   - Run `/newbot` and follow instructions
   - Copy the bot token (looks like `123456:ABC...`)

2. **Get your User ID** (for allowlist):
   - Message @userinfobot
   - It will reply with your user ID

## Configuration

```yaml
channels:
  telegram:
    botToken: "123456:ABC..."  # From @BotFather
    dmPolicy: "pairing"        # allowlist, pairing, open, disabled
    allowFrom: []              # User IDs or @usernames for DMs
    groupPolicy: "allowlist"   # allowlist, open, disabled
    groupAllowFrom: []         # User IDs for groups
    timeoutSeconds: 30         # API timeout
```

## Behavior

- **In DMs** - Responds to all messages (subject to dmPolicy)
- **In Groups** - Only responds to @mentions or replies to bot messages
- **Photo Captions** - Caption text is extracted and processed (photo not analyzed)
- **Long Responses** - Split at sentence boundaries if over 4096 characters
- **Reactions** - Adds emoji reaction when processing (standard reactions only)

## Security

- Bot token stored in config, token file, or TELEGRAM_BOT_TOKEN env var
- DM policies control access
- Group policies control who can trigger
- Message content not logged (only metadata)
