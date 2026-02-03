# Troubleshooting Guide

Common issues and solutions for `wopr-plugin-telegram`.

---

## Table of Contents

- [Quick Diagnostics](#quick-diagnostics)
- [Bot Not Responding](#bot-not-responding)
- [Authentication Issues](#authentication-issues)
- [Group Issues](#group-issues)
- [Reaction Issues](#reaction-issues)
- [Message Issues](#message-issues)
- [Performance Issues](#performance-issues)
- [Getting Help](#getting-help)

---

## Quick Diagnostics

Run these commands first to gather information:

```bash
# 1. Test your bot token
curl https://api.telegram.org/bot<YOUR_TOKEN>/getMe

# 2. Check if bot is running
wopr daemon status

# 3. View recent logs
wopr logs --follow

# 4. List plugins
wopr plugin list

# 5. Check configuration
wopr config show
```

---

## Bot Not Responding

### Symptom
Bot doesn't reply to any messages.

### Checklist

1. **Is the WOPR daemon running?**
   ```bash
   wopr daemon status
   # If not running:
   wopr daemon start
   ```

2. **Is the token valid?**
   ```bash
   curl https://api.telegram.org/bot<YOUR_TOKEN>/getMe
   ```
   - Should return `{"ok":true,...}`
   - If `{"ok":false,"error_code":401}`, your token is invalid

3. **Is the plugin enabled?**
   ```bash
   wopr plugin list
   # Should show wopr-plugin-telegram as enabled
   ```
   If not:
   ```bash
   wopr plugin enable wopr-plugin-telegram
   ```

4. **Check the logs**
   ```bash
   wopr logs --follow
   # Look for errors like "Failed to start Telegram bot"
   ```

5. **Verify configuration path**
   ```bash
   # Default config location
   cat ~/.wopr/config.yaml
   # Or check WOPR_HOME
   echo $WOPR_HOME
   ```

### Common Causes

| Cause | Solution |
|-------|----------|
| Token not configured | Add `botToken` to config or set `TELEGRAM_BOT_TOKEN` |
| Plugin not enabled | Run `wopr plugin enable wopr-plugin-telegram` |
| Daemon not running | Start with `wopr daemon start` |
| Wrong config file | Check `WOPR_HOME` environment variable |

---

## Authentication Issues

### "Telegram bot token required" Error

This means the plugin couldn't find a valid token.

**Solutions:**

1. **Check config file location:**
   ```bash
   ls -la ~/.wopr/config.yaml
   # Should exist and be readable
   ```

2. **Verify config format:**
   ```yaml
   channels:
     telegram:
       botToken: "123456:ABC..."  # Note: in quotes!
   ```

3. **Test environment variable:**
   ```bash
   echo $TELEGRAM_BOT_TOKEN
   # Should show your token
   
   # If empty, set it:
   export TELEGRAM_BOT_TOKEN="123456:ABC..."
   ```

4. **Check token file (if using `tokenFile`):**
   ```bash
   cat /path/to/token.txt
   # Should contain only the token
   # Check file permissions: chmod 600 /path/to/token.txt
   ```

### Token Format

Valid token format: `123456789:ABCdefGHIjklMNOpqrSTUvwxyz123456789`

- Numbers, letters, underscores, hyphens
- Single colon separating ID and secret
- No extra spaces or newlines

---

## Group Issues

### Bot Doesn't Respond in Groups

#### Check 1: Privacy Mode

**This is the #1 cause of group issues!**

The bot must have privacy mode **disabled** to see regular messages:

1. Message [@BotFather](https://t.me/botfather)
2. Send `/mybots`
3. Select your bot
4. Click **Bot Settings**
5. Click **Group Privacy**
6. Click **Turn Off**

**What the bot can see:**
- ✅ Commands (e.g., `/start`)
- ✅ @mentions
- ✅ Replies to bot messages
- ✅ All messages (if privacy is OFF)

**What the bot cannot see:**
- ❌ Regular messages (if privacy is ON)

#### Check 2: Group Policy

Verify your group policy allows the sender:

```yaml
channels:
  telegram:
    groupPolicy: "allowlist"  # or "open"
    groupAllowFrom:
      - "123456789"  # Your user ID
      # or use "*" for everyone
```

#### Check 3: Bot Permissions

The bot should be a **member** of the group. Admin rights are optional but recommended for:
- Deleting messages
- Pinning messages
- Managing topics (in forums)

To add as admin:
1. Group Info → Administrators → Add Admin
2. Search for your bot
3. Grant permissions as needed

### Supergroup/Channel Differences

| Feature | Group | Supergroup | Channel |
|---------|-------|------------|---------|
| Member limit | 200 | 200,000+ | Unlimited |
| Threads | No | Yes (forum) | No |
| Admin tools | Basic | Full | Full |
| Bot visibility | Members | Members | Subscribers |

---

## Reaction Issues

### Bot Reaction Not Showing

The plugin reacts to messages using the agent's configured emoji. However:

1. **Only standard Telegram reactions work** - Custom emoji are not supported
2. **Some chats disable reactions** - Check chat settings
3. **Channels don't support reactions** - This is a Telegram limitation

The plugin silently ignores reaction failures, so this won't affect message processing.

### Supported Reactions

The plugin only supports standard Telegram reaction emoji. If your agent's emoji is not in the supported list, reactions will fail silently.

---

## Message Issues

### Long Messages Truncated

Messages over 4096 characters are automatically split at sentence boundaries. If splitting looks wrong:
- Check that responses have proper sentence punctuation
- Very long sentences without periods may split awkwardly

### Photo Captions Not Processed

The plugin extracts caption text from photos. The photo itself is NOT analyzed - only the text caption is sent to the AI.

If caption text isn't being processed:
- Ensure the photo actually has a caption
- Check that the sender passes policy checks

---

## Performance Issues

### Slow Response Times

| Cause | Solution |
|-------|----------|
| AI provider slow | Check provider latency, use faster model |
| Network issues | Check connection to Telegram API |
| Large context | Reduce session context window in WOPR |

### High Memory Usage

**Large groups with many messages:**
- Use stricter `groupPolicy` to filter messages
- In groups, bot only responds to @mentions and replies by default

**Memory leaks:**
- Report to GitHub issues with heap dump
- Check WOPR session storage configuration

---

## Getting Help

### Gather Information

Before opening an issue, collect:

```bash
# 1. WOPR version
wopr --version

# 2. Plugin version
npm list wopr-plugin-telegram

# 3. Node version
node --version

# 4. Relevant log entries
wopr logs | grep telegram

# 5. Config (redact token!)
cat ~/.wopr/config.yaml | sed 's/botToken:.*/botToken: "***"/'
```

### Where to Get Help

1. **GitHub Issues:** [wopr-plugin-telegram/issues](https://github.com/TSavo/wopr-plugin-telegram/issues)
2. **WOPR Main Repo:** [TSavo/wopr](https://github.com/TSavo/wopr)
3. **Grammy Docs:** [grammy.dev](https://grammy.dev)
4. **Telegram Bot API:** [core.telegram.org/bots/api](https://core.telegram.org/bots/api)

### Reporting Bugs

Include:
- WOPR version
- Plugin version
- Node.js version
- Configuration (redacted)
- Steps to reproduce
- Expected vs actual behavior
- Relevant log output

---

## See Also

- [CONFIGURATION.md](./CONFIGURATION.md) - Configuration reference
- [Grammy Error Handling](https://grammy.dev/guide/errors) - Grammy error docs
