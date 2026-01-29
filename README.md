# wopr-plugin-telegram

Telegram integration for [WOPR](https://github.com/TSavo/wopr) using [Grammy](https://grammy.dev/).

## Features

- ✈️ **Grammy Library** - Modern, type-safe Telegram Bot API
- 👥 **Group Support** - Works in groups, supergroups, channels
- 🧵 **Threads** - Forum topics and reply threading
- 🔒 **DM Policies** - Control who can message the bot
- 👀 **Identity Reactions** - Reacts with agent's emoji
- 📎 **Media** - Photo/document support with captions
- 🔄 **Auto-retry** - Rate limit handling
- ✂️ **Auto-chunking** - Splits long messages automatically

## Prerequisites

### 1. Create a Telegram Bot

1. Open Telegram and message [@BotFather](https://t.me/botfather)
2. Run `/newbot` and follow instructions
3. **Copy the bot token** (looks like `123456:ABC-DEF...`)
4. (Optional) Set bot name, description, avatar

### 2. Get Your User ID

Message [@userinfobot](https://t.me/userinfobot) to get your Telegram user ID.

## Installation

```bash
wopr channels add telegram
```

Or manually:
```bash
npm install wopr-plugin-telegram
```

## Configuration

```yaml
# ~/.wopr/config.yaml
channels:
  telegram:
    # Required - Bot token from @BotFather
    botToken: "123456:ABC..."
    # OR use environment variable: TELEGRAM_BOT_TOKEN
    
    # Optional
    dmPolicy: "pairing"           # DM handling: allowlist, pairing, open, disabled
    allowFrom: []                 # Allowed user IDs for DMs
    groupPolicy: "allowlist"      # Group handling
    groupAllowFrom: []            # Allowed senders in groups
    mediaMaxMb: 5                 # Max attachment size
    timeoutSeconds: 30            # API timeout
```

## How It Works

1. **Bot Token** - Authenticates with Telegram Bot API
2. **Long Polling** - Receives messages in real-time
3. **Mention Detection** - In groups, only responds to @mentions
4. **Reply Threading** - Replies to original message
5. **HTML Formatting** - Supports formatting in responses

## Commands

| Command | Description |
|---------|-------------|
| `wopr configure --plugin telegram` | Configure bot token |
| `@BotName message` | Mention bot in groups |
| Reply to bot | Continue conversation |

## Architecture

```
┌─────────────┐      HTTP (Bot API)     ┌─────────────┐
│ WOPR Plugin │ ◄─────────────────────► │   Telegram  │
│   (Grammy)  │      Long Polling       │   Servers   │
└─────────────┘                         └─────────────┘
                                               │
                                               ▼
                                        ┌─────────────┐
                                        │   Users     │
                                        └─────────────┘
```

## Group Behavior

- Bot only responds when **@mentioned** or when you **reply** to its messages
- This prevents spam in busy groups
- Bot reacts with 👀 (or your agent's emoji) to acknowledge

## DM Behavior

- Based on `dmPolicy`:
  - `pairing` - All DMs allowed, pairing handled separately
  - `allowlist` - Only users in `allowFrom` can DM
  - `open` - Anyone can DM
  - `disabled` - DMs ignored

## Troubleshooting

### Bot not responding
```bash
# Check if token is valid
curl https://api.telegram.org/bot<YOUR_TOKEN>/getMe

# Check logs
wopr logs --follow
```

### Groups not working
- Make sure bot privacy mode is disabled:
  1. Message @BotFather
  2. Run `/mybots` → select bot → Bot Settings → Group Privacy → Turn Off
- Bot must be admin in groups (for some features)

### Rate limits
Grammy handles rate limits automatically with exponential backoff.

## Environment Variables

| Variable | Description |
|----------|-------------|
| `TELEGRAM_BOT_TOKEN` | Bot token (alternative to config) |

## Security

- ✅ Bot token stored in config or env
- ✅ DM policies control access
- ✅ No message content logged
- ✅ HTTPS only to Telegram API

## License

MIT

## See Also

- [WOPR](https://github.com/TSavo/wopr) - The main WOPR project
- [Grammy](https://grammy.dev/) - The Telegram Bot Framework
- [Telegram Bot API](https://core.telegram.org/bots/api) - Official API docs
