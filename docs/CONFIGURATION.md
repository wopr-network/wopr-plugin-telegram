# Configuration Reference

Complete configuration guide for `wopr-plugin-telegram`.

---

## Table of Contents

- [Quick Reference](#quick-reference)
- [Authentication](#authentication)
- [DM Policies](#dm-policies)
- [Group Policies](#group-policies)
- [Media Settings](#media-settings)
- [Webhook Configuration](#webhook-configuration)
- [Environment Variables](#environment-variables)
- [Configuration Examples](#configuration-examples)

---

## Quick Reference

### All Configuration Options

| Option | Type | Default | Required | Description |
|--------|------|---------|----------|-------------|
| `botToken` | string | - | Yes* | Bot token from @BotFather |
| `tokenFile` | string | - | Yes* | Path to file containing token |
| `dmPolicy` | string | `"pairing"` | No | How to handle DMs |
| `allowFrom` | array | `[]` | No | Allowed user IDs for DMs |
| `groupPolicy` | string | `"allowlist"` | No | How to handle group messages |
| `groupAllowFrom` | array | `[]` | No | Allowed users in groups |
| `mediaMaxMb` | number | `5` | No | Max attachment size in MB |
| `timeoutSeconds` | number | `30` | No | API timeout in seconds |
| `webhookUrl` | string | - | No | Webhook URL (optional) |
| `webhookPort` | number | `3000` | No | Webhook server port |

*One of `botToken`, `tokenFile`, or `TELEGRAM_BOT_TOKEN` env var is required.

---

## Authentication

You must provide a bot token from [@BotFather](https://t.me/botfather). There are three ways to authenticate:

### Option 1: Inline Token (Config File)

```yaml
channels:
  telegram:
    botToken: "123456789:ABCdefGHIjklMNOpqrSTUvwxyz"
```

**Pros:** Simple, self-contained  
**Cons:** Token in config file (ensure file permissions are restricted)

### Option 2: Token File

```yaml
channels:
  telegram:
    tokenFile: "/etc/wopr/telegram-token.txt"
```

Create the token file:
```bash
echo "123456789:ABCdef..." > /etc/wopr/telegram-token.txt
chmod 600 /etc/wopr/telegram-token.txt
```

**Pros:** Token separated from config, easier to rotate  
**Cons:** Extra file to manage

### Option 3: Environment Variable

```bash
export TELEGRAM_BOT_TOKEN="123456789:ABCdef..."
```

No config entry needed - the plugin automatically checks for this environment variable.

**Pros:** Best for CI/CD, Docker, secrets management  
**Cons:** Must ensure env var is set before starting WOPR

### Priority Order

If multiple methods are provided, the plugin uses this priority:

1. `botToken` in config file
2. `tokenFile` in config file
3. `TELEGRAM_BOT_TOKEN` environment variable

---

## DM Policies

Control who can send direct messages to your bot.

### `dmPolicy` Options

| Value | Behavior |
|-------|----------|
| `"pairing"` | All DMs allowed, pairing handled by WOPR trust system |
| `"allowlist"` | Only users in `allowFrom` can DM |
| `"open"` | Anyone can DM |
| `"disabled"` | All DMs ignored |

### `allowFrom` Format

```yaml
channels:
  telegram:
    dmPolicy: "allowlist"
    allowFrom:
      - "123456789"           # Telegram user ID (recommended)
      - "@username"           # Telegram username
      - "tg:123456789"        # Prefixed format (also accepted)
      - "*"                   # Wildcard = anyone (same as "open" policy)
```

**Note:** User IDs are preferred because usernames can change.

### DM Policy Examples

**Private bot (only you):**
```yaml
channels:
  telegram:
    botToken: "..."
    dmPolicy: "allowlist"
    allowFrom:
      - "123456789"  # Your user ID
```

**Team bot:**
```yaml
channels:
  telegram:
    botToken: "..."
    dmPolicy: "allowlist"
    allowFrom:
      - "123456789"  # Alice
      - "987654321"  # Bob
      - "@charlie"   # Charlie (by username)
```

**Public bot with WOPR pairing:**
```yaml
channels:
  telegram:
    botToken: "..."
    dmPolicy: "pairing"  # Anyone can DM, but WOPR pairing required
```

---

## Group Policies

Control bot behavior in groups, supergroups, and channels.

### `groupPolicy` Options

| Value | Behavior |
|-------|----------|
| `"allowlist"` | Only users in `groupAllowFrom` can trigger |
| `"open"` | Anyone can trigger |
| `"disabled"` | Bot ignores all group messages |

### `groupAllowFrom` Format

Same format as `allowFrom`:

```yaml
channels:
  telegram:
    groupPolicy: "allowlist"
    groupAllowFrom:
      - "123456789"    # Specific user
      - "@admin"       # By username
      - "*"            # Everyone (same as "open")
```

### Important: Group Privacy Setting

For the bot to see messages in groups, you **must** disable privacy mode:

1. Message [@BotFather](https://t.me/botfather)
2. Send `/mybots`
3. Select your bot
4. Go to **Bot Settings** → **Group Privacy** 
5. Select **Turn Off**

Without this, the bot only sees:
- Messages that @mention it
- Messages that are replies to it
- Commands (starting with `/`)

---

## Media Settings

### `mediaMaxMb`

Maximum file size for photos/documents in megabytes.

```yaml
channels:
  telegram:
    mediaMaxMb: 10  # Allow up to 10MB files
```

**Default:** 5 MB  
**Range:** 1-20 MB (Telegram Bot API limits)

### Media Handling

When users send media:

1. **Photos:** Caption text is extracted and sent to AI
2. **Documents:** Filename and caption sent to AI
3. **Other media:** Acknowledged but content not processed
4. **Oversized files:** Rejected with warning message

---

## Webhook Configuration

For production deployments, webhooks are recommended over polling.

### Basic Webhook Setup

```yaml
channels:
  telegram:
    botToken: "..."
    webhookUrl: "https://yourdomain.com/webhook"
    webhookPort: 3000
```

### Requirements

- **HTTPS URL** - Telegram requires secure webhooks
- **Valid SSL certificate** - No self-signed certs
- **Publicly accessible** - Telegram servers must reach your URL
- **Correct port** - Usually 443, 80, 88, or 8443

### Webhook vs Polling

| Aspect | Polling | Webhook |
|--------|---------|---------|
| Setup complexity | Easy | Requires HTTPS |
| Latency | 1-5 seconds | Near real-time |
| Resource usage | Higher (constant requests) | Lower (push-based) |
| Server requirements | None | Web server |
| Scaling | Single instance | Multiple instances possible |

**For detailed deployment guide:** [DEPLOYMENT.md](./DEPLOYMENT.md)

---

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token (alternative to config) | `123456:ABC...` |
| `WOPR_HOME` | WOPR config directory | `~/.wopr` |

The plugin also inherits WOPR's logging configuration.

---

## Configuration Examples

### Minimal Development Setup

```yaml
channels:
  telegram:
    botToken: "123456:ABC..."
```

### Secure Production Setup

```yaml
channels:
  telegram:
    # Token from TELEGRAM_BOT_TOKEN env var
    dmPolicy: "allowlist"
    allowFrom:
      - "123456789"  # Admin only for DMs
    groupPolicy: "allowlist"
    groupAllowFrom:
      - "*"  # Anyone in groups (groups are invite-only anyway)
    mediaMaxMb: 10
    timeoutSeconds: 60
    webhookUrl: "https://bot.example.com/webhook"
    webhookPort: 443
```

### Multi-Environment Setup

Use environment-specific config files:

```yaml
# config.development.yaml
channels:
  telegram:
    botToken: "DEV_TOKEN_HERE"
    dmPolicy: "open"  # More permissive in dev

# config.production.yaml
channels:
  telegram:
    # Token from env var in production
    dmPolicy: "allowlist"
    allowFrom:
      - "${ADMIN_USER_ID}"  # Templating if your config supports it
```

---

## Validation

To validate your configuration:

```bash
# Test token
curl https://api.telegram.org/bot<YOUR_TOKEN>/getMe

# Should return:
# {"ok":true,"result":{"id":123456789,"is_bot":true,...}}

# Check WOPR config
wopr config validate

# View effective config
wopr config show
```

---

## See Also

- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) - Common configuration issues
- [DEPLOYMENT.md](./DEPLOYMENT.md) - Production deployment guide
- [Grammy Configuration](https://grammy.dev/guide/config) - Grammy-specific options
