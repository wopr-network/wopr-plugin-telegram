# wopr-plugin-telegram

[![npm version](https://img.shields.io/npm/v/wopr-plugin-telegram.svg)](https://www.npmjs.com/package/wopr-plugin-telegram)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![WOPR](https://img.shields.io/badge/WOPR-Plugin-blue)](https://github.com/TSavo/wopr)
[![Grammy](https://img.shields.io/badge/Grammy-1.21+-blue)](https://grammy.dev/)

🤖 **Telegram Bot Integration for [WOPR](https://github.com/TSavo/wopr)**

> Part of the [WOPR](https://github.com/TSavo/wopr) ecosystem - Self-sovereign AI session management over P2P.

Connect your WOPR AI agents to Telegram with this powerful, feature-rich plugin. Built on the modern [Grammy](https://grammy.dev/) framework for reliability and type safety.

---

## ✨ Features

| Feature | Description |
|---------|-------------|
| ✈️ **Grammy Framework** | Modern, type-safe Telegram Bot API with auto-retry |
| 👥 **Group Support** | Full support for groups, supergroups, and channels |
| 🧵 **Forum Topics** | Thread-aware messaging in forum supergroups |
| 🔒 **Flexible Policies** | Granular DM and group access controls |
| 👀 **Identity Reactions** | Reacts with your agent's custom emoji |
| 📎 **Rich Media** | Photos, documents, captions, and more |
| 🔄 **Auto-Retry** | Intelligent rate limit handling with backoff |
| ✂️ **Smart Chunking** | Automatic message splitting for long responses |
| 🌐 **Webhook & Polling** | Choose your preferred update method |
| 📊 **Winston Logging** | Structured logging with configurable levels |

---

## 📋 Prerequisites

### Step 1: Create a Telegram Bot with @BotFather

1. **Open Telegram** and search for [@BotFather](https://t.me/botfather)
2. **Start a conversation** and send `/newbot`
3. **Follow the prompts:**
   - Enter a name for your bot (e.g., "My WOPR Assistant")
   - Enter a username (must end in `bot`, e.g., `mywopr_bot`)
4. **Copy your bot token** (looks like `123456789:ABCdefGHIjklMNOpqrSTUvwxyz`)
5. **Save it securely** - you'll only see it once!

**Optional but recommended:**
- `/setdescription` - Add a description
- `/setabouttext` - Set about text  
- `/setuserpic` - Upload avatar
- `/setcommands` - Configure command menu

### Step 2: Get Your Telegram User ID

Message [@userinfobot](https://t.me/userinfobot) and it will reply with your user ID.

---

## 🚀 Quick Start

### Via WOPR CLI (Recommended)

```bash
# Add the Telegram channel
wopr channels add telegram

# Interactive configuration
wopr configure --plugin telegram
```

### Manual Installation

```bash
npm install wopr-plugin-telegram
```

### Minimal Configuration

```yaml
# ~/.wopr/config.yaml
channels:
  telegram:
    botToken: "123456:ABC..."  # From @BotFather
```

Or use environment variable:
```bash
export TELEGRAM_BOT_TOKEN="123456:ABC..."
```

---

## ⚙️ Configuration

### Complete Configuration Options

```yaml
channels:
  telegram:
    # Authentication (required - one of these)
    botToken: "123456:ABC..."           # Inline token
    tokenFile: "/path/to/token.txt"     # Or read from file
    # Or set TELEGRAM_BOT_TOKEN env var
    
    # Direct Message Policy
    dmPolicy: "pairing"                 # Options: allowlist, pairing, open, disabled
    allowFrom:                          # Who can DM the bot
      - "123456789"                     # Telegram user ID
      - "@username"                     # Telegram username
    
    # Group Settings
    groupPolicy: "allowlist"            # Options: allowlist, open, disabled
    groupAllowFrom:                     # Who can trigger in groups
      - "123456789"
      - "*"                             # Wildcard = anyone
    
    # Media & Performance
    mediaMaxMb: 5                       # Max attachment size in MB
    timeoutSeconds: 30                  # API timeout
    
    # Webhook Mode (optional - see DEPLOYMENT.md)
    webhookUrl: "https://yourdomain.com/webhook"
    webhookPort: 3000
```

### Policy Options Explained

| Policy | Description | Use Case |
|--------|-------------|----------|
| **pairing** (DM default) | All DMs allowed, pairing handled by WOPR | General use |
| **allowlist** | Only specified users can interact | Private/controlled bots |
| **open** | Anyone can interact | Public bots |
| **disabled** | Ignores all messages | Maintenance mode |

---

## 🏗️ Architecture

```
┌─────────────────┐     ┌─────────────┐     ┌─────────────┐
│   Telegram      │────▶│   Grammy    │────▶│    WOPR     │
│   Servers       │◄────│    Bot      │◄────│   Plugin    │
└─────────────────┘     └─────────────┘     └─────────────┘
        │                                           │
        │    Long Polling or Webhook                │
        │                                           ▼
        │                                    ┌─────────────┐
        └────────────────────────────────────│  AI Agent   │
                                             │  Session    │
                                             └─────────────┘
```

**Data Flow:**
1. Telegram servers send updates (via polling or webhook)
2. Grammy receives and parses the update
3. Plugin validates sender against policies
4. Message injected into WOPR session
5. AI response sent back through Telegram

---

## 💬 Usage Guide

### Direct Messages (DMs)

In DMs, the bot responds to all messages (based on your `dmPolicy`):

```
User: Hello bot!
Bot: 👋 Hello! How can I help you today?
```

### Groups & Supergroups

In groups, the bot only responds when **@mentioned** or when you **reply** to its messages:

```
User: @mywopr_bot What's the weather?
Bot: 👀 I don't have real-time weather data, but I can...

User: (replying to bot) Can you explain more?
Bot: Certainly! Let me elaborate...
```

This prevents spam in busy group chats.

### Channels

In channels, the bot:
- Receives all messages (if admin)
- Can post messages
- Cannot use reactions (channel limitation)

### Forum Topics (Threaded Groups)

In forum supergroups:
- Messages are tracked by topic
- Replies stay in the same thread
- Topic context is preserved

---

## 🔧 Polling vs Webhook

| Feature | Polling | Webhook |
|---------|---------|---------|
| **Setup** | Zero-config | Requires HTTPS server |
| **Latency** | 1-5 seconds | Near real-time |
| **Server** | No server needed | Requires public URL |
| **Firewall** | Outbound only | Inbound port needed |
| **Scalability** | Single instance | Multiple instances |
| **Best For** | Development, small bots | Production, high traffic |

**Default:** Polling (easiest to get started)

**For webhooks, see:** [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md)

---

## 🛠️ Troubleshooting

### Quick Diagnostics

```bash
# Test your bot token
curl https://api.telegram.org/bot<YOUR_TOKEN>/getMe

# Should return: {"ok":true,"result":{"id":...}}

# View WOPR logs
wopr logs --follow

# Check plugin status
wopr plugin list
```

### Common Issues

| Issue | Solution |
|-------|----------|
| Bot not responding | Check token validity, ensure daemon is running |
| Groups not working | Disable privacy mode in @BotFather → Bot Settings → Group Privacy |
| Rate limit errors | Grammy handles this automatically, just wait |
| Media not sending | Check `mediaMaxMb` and file permissions |
| Webhook not working | Verify HTTPS, check firewall, ensure correct port |

**For detailed troubleshooting:** [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md)

---

## 🔒 Security

- ✅ Bot token stored securely (config file with restricted permissions or env var)
- ✅ DM policies prevent unauthorized access
- ✅ Group policies control who can trigger in groups
- ✅ No message content logged (only metadata)
- ✅ HTTPS-only communication with Telegram API
- ✅ Input validation on all incoming messages

---

## 📚 Documentation

| Document | Description |
|----------|-------------|
| [docs/CONFIGURATION.md](docs/CONFIGURATION.md) | Complete configuration reference |
| [docs/TROUBLESHOOTING.md](docs/TROUBLESHOOTING.md) | Common issues and solutions |
| [docs/DEPLOYMENT.md](docs/DEPLOYMENT.md) | Webhook setup, serverless deployment |
| [examples/](examples/) | Example configurations |

---

## 🔗 WOPR Ecosystem

This plugin is part of the WOPR ecosystem:

| Component | Description |
|-----------|-------------|
| [WOPR](https://github.com/TSavo/wopr) | Main project - Self-sovereign AI session management |
| [wopr-plugin-discord](https://github.com/TSavo/wopr-plugin-discord) | Discord integration |
| [wopr-plugin-slack](https://github.com/TSavo/wopr-plugin-slack) | Slack integration |
| [wopr-plugin-whatsapp](https://github.com/TSavo/wopr-plugin-whatsapp) | WhatsApp integration |
| [wopr-plugin-signal](https://github.com/TSavo/wopr-plugin-signal) | Signal integration |

---

## 📝 License

MIT © [TSavo](https://github.com/TSavo)

---

## 📖 See Also

- [Grammy Documentation](https://grammy.dev/) - The Telegram Bot Framework
- [Telegram Bot API](https://core.telegram.org/bots/api) - Official API documentation
- [WOPR Documentation](https://github.com/TSavo/wopr#readme) - Main WOPR project
