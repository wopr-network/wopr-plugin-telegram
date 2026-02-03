# Deployment Guide

Production deployment notes for `wopr-plugin-telegram`.

---

## Table of Contents

- [Update Mode](#update-mode)
- [Docker Deployment](#docker-deployment)
- [Systemd Service](#systemd-service)
- [Logging](#logging)
- [Security Best Practices](#security-best-practices)

---

## Update Mode

The plugin currently uses **long polling** to receive updates from Telegram. This is the default mode and does not require any special server setup.

**Note:** Webhook mode configuration options exist in the schema but are not currently implemented. The bot always uses polling regardless of `webhookUrl` settings.

### Polling Characteristics

- Works behind NAT/firewall (outbound connections only)
- No public URL or SSL certificate required
- Slight latency (1-5 seconds typical)
- Single instance only (cannot scale horizontally)
- Suitable for most use cases

---

## Docker Deployment

### Basic Dockerfile

```dockerfile
FROM node:20-alpine

# Install WOPR
RUN npm install -g wopr

# Install plugin
RUN wopr plugin install github:TSavo/wopr-plugin-telegram

# Copy config
COPY config.yaml /root/.wopr/config.yaml

# Set environment
ENV TELEGRAM_BOT_TOKEN=""
ENV WOPR_HOME=/root/.wopr

CMD ["wopr", "daemon", "start", "--foreground"]
```

### Docker Compose

```yaml
# docker-compose.yaml
version: '3.8'

services:
  wopr:
    build: .
    container_name: wopr-telegram
    environment:
      - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
      - WOPR_HOME=/data
    volumes:
      - wopr-data:/data
    restart: unless-stopped
    healthcheck:
      test: ["CMD", "wopr", "daemon", "status"]
      interval: 30s
      timeout: 10s
      retries: 3

volumes:
  wopr-data:
```

### Building and Running

```bash
# Build
docker build -t wopr-telegram .

# Run
docker run -d \
  -e TELEGRAM_BOT_TOKEN="123456:ABC..." \
  -v wopr-data:/root/.wopr \
  wopr-telegram

# Or with docker-compose
docker-compose up -d
```

---

## Systemd Service

For running WOPR as a system service:

```ini
# /etc/systemd/system/wopr.service
[Unit]
Description=WOPR AI Assistant
After=network.target

[Service]
Type=simple
User=wopr
Environment=WOPR_HOME=/home/wopr/.wopr
Environment=TELEGRAM_BOT_TOKEN=your-token-here
ExecStart=/usr/bin/wopr daemon start --foreground
Restart=on-failure
RestartSec=10

[Install]
WantedBy=multi-user.target
```

Enable and start:

```bash
sudo systemctl daemon-reload
sudo systemctl enable wopr
sudo systemctl start wopr
sudo systemctl status wopr
```

---

## Logging

The plugin writes logs to:

```
$WOPR_HOME/logs/telegram-plugin.log        # All logs (debug level)
$WOPR_HOME/logs/telegram-plugin-error.log  # Errors only
```

Console output shows warnings and errors only.

### Log Rotation

Set up logrotate for production:

```
# /etc/logrotate.d/wopr-telegram
/home/wopr/.wopr/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0600 wopr wopr
}
```

### Viewing Logs

```bash
# Tail recent logs
tail -f ~/.wopr/logs/telegram-plugin.log

# View errors only
tail -f ~/.wopr/logs/telegram-plugin-error.log

# Or use WOPR CLI
wopr logs --follow
```

---

## Security Best Practices

### 1. Use Environment Variables for Tokens

Never commit tokens to version control:

```yaml
# Good - use env var
channels:
  telegram:
    # Token read from TELEGRAM_BOT_TOKEN env var
    dmPolicy: "allowlist"
```

```bash
# Set in environment
export TELEGRAM_BOT_TOKEN="123456:ABC..."
```

### 2. Restrict File Permissions

```bash
chmod 600 ~/.wopr/config.yaml
chmod 700 ~/.wopr
chmod 700 ~/.wopr/logs
```

### 3. Use Allowlists in Production

```yaml
channels:
  telegram:
    dmPolicy: "allowlist"
    allowFrom:
      - "123456789"  # Only trusted users
    groupPolicy: "allowlist"
    groupAllowFrom:
      - "123456789"
```

### 4. Run as Non-Root User

Create a dedicated user for the service:

```bash
sudo useradd -r -s /bin/false wopr
sudo mkdir -p /home/wopr/.wopr
sudo chown -R wopr:wopr /home/wopr/.wopr
```

### 5. Regular Updates

```bash
# Keep dependencies updated
npm update wopr-plugin-telegram

# Check for security advisories
npm audit
```

---

## Health Monitoring

### Check Bot Status

```bash
# Test if bot is responding
curl https://api.telegram.org/bot<TOKEN>/getMe

# Check WOPR daemon
wopr daemon status
```

### Basic Health Check Script

```bash
#!/bin/bash
# health-check.sh

TOKEN="${TELEGRAM_BOT_TOKEN}"
RESPONSE=$(curl -s "https://api.telegram.org/bot${TOKEN}/getMe")

if echo "$RESPONSE" | grep -q '"ok":true'; then
    echo "Bot is healthy"
    exit 0
else
    echo "Bot health check failed"
    exit 1
fi
```

---

## See Also

- [CONFIGURATION.md](./CONFIGURATION.md) - Configuration options
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) - Common issues
