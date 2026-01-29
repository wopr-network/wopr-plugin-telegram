# Deployment Guide

Production deployment options for `wopr-plugin-telegram`.

---

## Table of Contents

- [Deployment Modes](#deployment-modes)
- [Webhook Setup](#webhook-setup)
- [Serverless Deployment](#serverless-deployment)
- [Docker Deployment](#docker-deployment)
- [Reverse Proxy Setup](#reverse-proxy-setup)
- [SSL/TLS Configuration](#ssltls-configuration)
- [Monitoring & Logging](#monitoring--logging)
- [Scaling Considerations](#scaling-considerations)

---

## Deployment Modes

### Polling Mode (Default)

**Best for:** Development, small bots, simple deployments

```yaml
channels:
  telegram:
    botToken: "..."
    # No webhook settings = polling mode
```

**Pros:**
- Zero-config setup
- Works behind NAT/firewall
- No public URL needed
- No SSL certificate needed

**Cons:**
- Slight latency (1-5 seconds)
- Higher resource usage (constant requests)
- Single instance only

### Webhook Mode

**Best for:** Production, high-traffic bots, low-latency requirements

```yaml
channels:
  telegram:
    botToken: "..."
    webhookUrl: "https://yourdomain.com/webhook"
    webhookPort: 3000
```

**Pros:**
- Near real-time updates
- Lower resource usage
- Can scale horizontally
- Better for serverless

**Cons:**
- Requires HTTPS
- Needs public URL
- More complex setup

---

## Webhook Setup

### Step 1: Prerequisites

- Domain name pointing to your server
- Valid SSL certificate
- Server accessible on ports 443, 80, 88, or 8443

### Step 2: Configure Plugin

```yaml
# ~/.wopr/config.yaml
channels:
  telegram:
    botToken: "${TELEGRAM_BOT_TOKEN}"  # Use env var
    webhookUrl: "https://bot.example.com/webhook"
    webhookPort: 3000
    timeoutSeconds: 60
```

### Step 3: Set Environment Variable

```bash
export TELEGRAM_BOT_TOKEN="123456:ABC..."
```

### Step 4: Start WOPR

```bash
wopr daemon start
```

The plugin will automatically register the webhook with Telegram.

### Step 5: Verify Webhook

```bash
# Check webhook status
curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo
```

Expected response:
```json
{
  "ok": true,
  "result": {
    "url": "https://bot.example.com/webhook",
    "has_custom_certificate": false,
    "pending_update_count": 0,
    "max_connections": 40
  }
}
```

### Webhook Path

The webhook endpoint is handled internally by the plugin. You don't need to configure routes.

---

## Serverless Deployment

### AWS Lambda

```javascript
// lambda.js
const { Bot, webhookCallback } = require('grammy');

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

// Handler
exports.handler = async (event) => {
  const callback = webhookCallback(bot, 'aws-lambda');
  return callback(event);
};
```

**Note:** For full WOPR integration with Lambda, you'd need to:
1. Run WOPR in a container or as a separate service
2. Use the plugin's webhook mode
3. Or use API Gateway + Lambda for just the webhook receiver

### Vercel

```javascript
// api/webhook.js
const { Bot, webhookCallback } = require('grammy');

const bot = new Bot(process.env.TELEGRAM_BOT_TOKEN);

export default webhookCallback(bot, 'https');
```

### Cloudflare Workers

```javascript
// worker.js
import { Bot, webhookCallback } from 'grammy';

const bot = new Bot(TELEGRAM_BOT_TOKEN);

export default {
  async fetch(request, env) {
    const callback = webhookCallback(bot, 'cloudflare-mod');
    return callback(request);
  }
};
```

**Current Limitation:** The plugin currently uses polling by default. For serverless deployment, you'll need to run WOPR as a persistent service or use a custom webhook adapter.

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

EXPOSE 3000

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
    ports:
      - "3000:3000"
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
  -p 3000:3000 \
  wopr-telegram

# Or with docker-compose
docker-compose up -d
```

---

## Reverse Proxy Setup

### Nginx

```nginx
# /etc/nginx/sites-available/bot.example.com
server {
    listen 443 ssl http2;
    server_name bot.example.com;

    ssl_certificate /etc/letsencrypt/live/bot.example.com/fullchain.pem;
    ssl_certificate_key /etc/letsencrypt/live/bot.example.com/privkey.pem;

    location /webhook {
        proxy_pass http://localhost:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
        
        # WebSocket support (if needed)
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection "upgrade";
    }

    # Health check endpoint
    location /health {
        proxy_pass http://localhost:3000/health;
        access_log off;
    }
}

# Redirect HTTP to HTTPS
server {
    listen 80;
    server_name bot.example.com;
    return 301 https://$server_name$request_uri;
}
```

Enable:
```bash
sudo ln -s /etc/nginx/sites-available/bot.example.com /etc/nginx/sites-enabled/
sudo nginx -t
sudo systemctl reload nginx
```

### Caddy

```caddyfile
# Caddyfile
bot.example.com {
    reverse_proxy localhost:3000
    
    # Automatic HTTPS
    tls {
        protocols tls1.2 tls1.3
    }
}
```

Start Caddy:
```bash
caddy run
```

### Apache

```apache
# /etc/apache2/sites-available/bot.example.com.conf
<VirtualHost *:443>
    ServerName bot.example.com
    
    SSLEngine on
    SSLCertificateFile /etc/letsencrypt/live/bot.example.com/fullchain.pem
    SSLCertificateKeyFile /etc/letsencrypt/live/bot.example.com/privkey.pem

    ProxyPreserveHost On
    ProxyPass /webhook http://localhost:3000/webhook
    ProxyPassReverse /webhook http://localhost:3000/webhook

    <Proxy *>
        Order allow,deny
        Allow from all
    </Proxy>
</VirtualHost>
```

Enable:
```bash
sudo a2enmod ssl proxy proxy_http
sudo a2ensite bot.example.com
sudo systemctl reload apache2
```

---

## SSL/TLS Configuration

### Let's Encrypt (Recommended)

```bash
# Install certbot
sudo apt install certbot python3-certbot-nginx

# Obtain certificate
sudo certbot --nginx -d bot.example.com

# Auto-renewal (should be set up automatically)
sudo certbot renew --dry-run
```

### Certificate Requirements

Telegram requires:
- Valid (not self-signed) certificate
- HTTPS only
- TLS 1.2 or higher

**Not supported:**
- Self-signed certificates
- IP addresses (must use domain)
- HTTP (not HTTPS)

### Cloudflare

If using Cloudflare:

1. Set SSL mode to "Full (Strict)"
2. Create Origin Certificate for your server
3. Install on your server
4. Use `webhookUrl` with your domain

```yaml
channels:
  telegram:
    webhookUrl: "https://bot.example.com/webhook"
    # Cloudflare handles SSL termination
```

---

## Monitoring & Logging

### Log Files

The plugin logs to:
```
~/.wopr/logs/telegram-plugin.log        # All logs
~/.wopr/logs/telegram-plugin-error.log  # Errors only
```

### Log Rotation

Set up logrotate:

```bash
# /etc/logrotate.d/wopr-telegram
/root/.wopr/logs/*.log {
    daily
    rotate 7
    compress
    delaycompress
    missingok
    notifempty
    create 0600 root root
}
```

### Health Checks

Add to your monitoring:

```bash
# Check if bot is responding
curl https://api.telegram.org/bot<TOKEN>/getMe

# Check webhook status
curl https://api.telegram.org/bot<TOKEN>/getWebhookInfo

# Check WOPR daemon
wopr daemon status
```

### Prometheus Metrics (Future)

Consider implementing metrics for:
- Messages processed
- Response latency
- Error rates
- Webhook vs polling ratio

---

## Scaling Considerations

### Single Instance (Polling)

- Good for: < 1000 messages/day
- Simple setup
- No shared state needed

### Single Instance (Webhook)

- Good for: < 10,000 messages/day
- Better latency
- Requires HTTPS setup

### Multi-Instance (Advanced)

For very high traffic:

1. **Use webhook mode** with load balancer
2. **Shared session storage** (Redis)
3. **Stateless WOPR instances**

```
                    ┌─────────────┐
  Telegram  ───────▶│   Nginx     │
                    │  (LB/SSL)   │
                    └──────┬──────┘
                           │
           ┌───────────────┼───────────────┐
           ▼               ▼               ▼
    ┌─────────────┐ ┌─────────────┐ ┌─────────────┐
    │  WOPR #1    │ │  WOPR #2    │ │  WOPR #3    │
    │  + Plugin   │ │  + Plugin   │ │  + Plugin   │
    └──────┬──────┘ └──────┬──────┘ └──────┬──────┘
           │               │               │
           └───────────────┼───────────────┘
                           ▼
                    ┌─────────────┐
                    │    Redis    │
                    │  (Sessions) │
                    └─────────────┘
```

**Note:** Multi-instance setup requires WOPR core changes for shared state.

---

## Security Best Practices

### 1. Use Environment Variables

Never commit tokens to version control:

```yaml
# Good
botToken: "${TELEGRAM_BOT_TOKEN}"

# Bad
botToken: "123456:ABC..."  # Never do this!
```

### 2. Restrict File Permissions

```bash
chmod 600 ~/.wopr/config.yaml
chmod 700 ~/.wopr
```

### 3. Use Webhook Secret (Future)

Consider implementing webhook secret validation:

```yaml
channels:
  telegram:
    webhookUrl: "https://..."
    webhookSecret: "random-secret-here"  # Validate incoming requests
```

### 4. Firewall Rules

```bash
# Allow only Telegram IP ranges (if known)
# Or use Cloudflare/iptables to restrict access
```

### 5. Regular Updates

```bash
# Keep dependencies updated
npm update wopr-plugin-telegram

# Check for security advisories
npm audit
```

---

## See Also

- [CONFIGURATION.md](./CONFIGURATION.md) - Configuration options
- [TROUBLESHOOTING.md](./TROUBLESHOOTING.md) - Common issues
- [Grammy Deployment](https://grammy.dev/guide/deployment) - Grammy-specific deployment tips
