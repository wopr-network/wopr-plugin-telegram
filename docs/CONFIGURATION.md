# Configuration Reference

Complete configuration guide for `wopr-plugin-telegram`.

---

## Table of Contents

- [Quick Reference](#quick-reference)
- [Authentication](#authentication)
- [DM Policies](#dm-policies)
- [Group Policies](#group-policies)
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
| `timeoutSeconds` | number | `30` | No | API timeout in seconds |

*One of `botToken`, `tokenFile`, or `TELEGRAM_BOT_TOKEN` env var is required.

**Note:** The `mediaMaxMb`, `webhookUrl`, and `webhookPort` options appear in the config schema but are not currently implemented in the plugin.

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

## Environment Variables

| Variable | Description | Example |
|----------|-------------|---------|
| `TELEGRAM_BOT_TOKEN` | Bot token (alternative to config) | `123456:ABC...` |
| `WOPR_HOME` | WOPR config directory (used for log file paths) | `~/.wopr` |

The plugin writes logs to `$WOPR_HOME/logs/telegram-plugin.log` and `$WOPR_HOME/logs/telegram-plugin-error.log`.

---

## Configuration Examples

### Minimal Development Setup

```yaml
channels:
  telegram:
    botToken: "123456:ABC..."
```

### Private Bot (Admin Only)

```yaml
channels:
  telegram:
    # Token from TELEGRAM_BOT_TOKEN env var
    dmPolicy: "allowlist"
    allowFrom:
      - "123456789"  # Admin only for DMs
    groupPolicy: "disabled"  # No group support
    timeoutSeconds: 60
```

### Team Bot with Open Groups

```yaml
channels:
  telegram:
    botToken: "123456:ABC..."
    dmPolicy: "allowlist"
    allowFrom:
      - "123456789"  # Alice
      - "987654321"  # Bob
    groupPolicy: "open"  # Anyone in groups can trigger
```

### Public Bot

```yaml
channels:
  telegram:
    # Token from env var
    dmPolicy: "pairing"  # WOPR handles pairing
    groupPolicy: "open"
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
- [Grammy Configuration](https://grammy.dev/guide/config) - Grammy-specific options
