# Formic Messaging Integration Guide

## Overview

Formic supports integration with **Telegram** and **Line** messaging apps, allowing you to manage tasks directly from your phone or desktop messaging client.

### What You Can Do

- Create tasks by sending natural language messages
- View board status with `/board` command
- Get task details with `/status [task-id]`
- Queue tasks for execution with `/run [task-id]`
- Receive real-time notifications when tasks complete, fail, or need review

---

## Prerequisites

- Formic server running (locally or deployed)
- Public HTTPS URL for webhooks (required by both platforms)
  - For local development: Use [ngrok](https://ngrok.com/) or [cloudflared](https://developers.cloudflare.com/cloudflare-one/connections/connect-apps/)
  - For production: Your deployed server URL

---

## Telegram Integration

### Step 1: Create a Telegram Bot

1. Open Telegram and search for [@BotFather](https://t.me/BotFather)
2. Start a chat and send `/newbot`
3. Follow the prompts:
   - Choose a display name (e.g., "Formic Task Manager")
   - Choose a username (must end in `bot`, e.g., `formic_tasks_bot`)
4. BotFather will provide an **API token** like:
   ```
   123456789:ABCdefGHIjklMNOpqrsTUVwxyz
   ```
5. Save this token securely

### Step 2: Configure Environment Variable

Set the `TELEGRAM_BOT_TOKEN` environment variable before starting Formic:

```bash
# Option 1: Export in terminal
export TELEGRAM_BOT_TOKEN="your-telegram-bot-token-here"

# Option 2: Add to .env file (if using dotenv)
echo 'TELEGRAM_BOT_TOKEN=your-telegram-bot-token-here' >> .env

# Option 3: Add to shell profile for persistence
echo 'export TELEGRAM_BOT_TOKEN="your-telegram-bot-token-here"' >> ~/.zshrc
```

### Step 3: Expose Local Server (Development Only)

For local development, you need a public HTTPS URL. Use ngrok:

```bash
# Install ngrok if needed
brew install ngrok  # macOS
# or download from https://ngrok.com/download

# Start ngrok tunnel to Formic port
ngrok http 8000
```

Ngrok will provide a URL like `https://abc123.ngrok.io`. Note this URL.

### Step 4: Set Webhook URL

Tell Telegram where to send updates:

```bash
# Replace with your actual ngrok URL
curl -X POST http://localhost:8000/api/messaging/telegram/set-webhook \
  -H "Content-Type: application/json" \
  -d '{"webhookUrl": "https://your-ngrok-url.ngrok-free.dev/api/webhooks/telegram"}'
```

Expected response:
```json
{
  "success": true,
  "webhookUrl": "https://abc123.ngrok.io/api/webhooks/telegram",
  "message": "Webhook URL set successfully"
}
```

### Step 5: Start Using the Bot

1. Open Telegram and find your bot by username
2. Send `/start` to link the chat to your Formic workspace
3. Start creating tasks!

---

## Line Integration

### Step 1: Create a Line Channel

1. Go to [Line Developers Console](https://developers.line.biz/)
2. Log in with your Line account
3. Create a new **Provider** (if you don't have one)
4. Create a new **Messaging API Channel**:
   - Choose your provider
   - Fill in the channel details (name, description, category)
   - Accept the terms of service

### Step 2: Get Credentials

In your channel settings:

1. Go to **Basic settings** tab
   - Copy the **Channel secret**

2. Go to **Messaging API** tab
   - Scroll to **Channel access token**
   - Click **Issue** to generate a long-lived token
   - Copy the token

### Step 3: Configure Environment Variables

```bash
# Set both environment variables
export LINE_CHANNEL_ACCESS_TOKEN="your-line-channel-access-token-here"
export LINE_CHANNEL_SECRET="your-line-channel-secret-here"

# Or add to .env file
echo 'LINE_CHANNEL_ACCESS_TOKEN=your-channel-access-token-here' >> .env
echo 'LINE_CHANNEL_SECRET=your-channel-secret-here' >> .env
```

### Step 4: Configure Webhook in Line Console

1. In the **Messaging API** tab, find **Webhook settings**
2. Click **Edit** next to Webhook URL
3. Enter your webhook URL:
   ```
   https://your-domain.com/api/webhooks/line
   ```
   For local development with ngrok:
   ```
   https://your-ngrok-url.ngrok-free.dev/api/webhooks/line
   ```
4. Enable **Use webhook**
5. Click **Verify** to test the connection

### Step 5: Disable Auto-Reply (Recommended)

In the **Messaging API** tab:
- Set **Auto-reply messages** to **Disabled**
- Set **Greeting messages** to **Disabled**

This prevents Line's default responses from interfering with Formic bot responses.

### Step 6: Add Bot as Friend

1. In the **Messaging API** tab, find the **QR code**
2. Scan with Line app to add the bot as a friend
3. Send `/start` to link the chat to your workspace

---

## Bot Commands Reference

| Command | Description | Example |
|---------|-------------|---------|
| `/start` | Link chat to current Formic workspace | `/start` |
| `/help` | Show available commands | `/help` |
| `/board` | View all tasks organized by status | `/board` |
| `/status [id]` | Get detailed info for a specific task | `/status t-15` |
| `/run [id]` | Queue a task for execution | `/run t-15` |

### Quick Task Creation

Send any message **without** a `/` prefix to create a new task:

```
Add dark mode to settings page
```

This creates a task with:
- **Title**: "Add dark mode to settings page"
- **Priority**: medium (default)
- **Status**: todo

---

## API Endpoints

### Check Integration Status

```bash
curl http://localhost:8000/api/messaging/status
```

Response:
```json
{
  "telegram": {
    "configured": true,
    "botInfo": {
      "id": 123456789,
      "username": "formic_tasks_bot",
      "first_name": "Formic Task Manager"
    }
  },
  "line": {
    "configured": true
  },
  "sessions": {
    "total": 2,
    "byPlatform": {
      "telegram": 1,
      "line": 1
    }
  }
}
```

### View Active Sessions

```bash
curl http://localhost:8000/api/messaging/sessions
```

### Set Telegram Webhook

```bash
curl -X POST http://localhost:8000/api/messaging/telegram/set-webhook \
  -H "Content-Type: application/json" \
  -d '{"webhookUrl": "https://your-domain.com/api/webhooks/telegram"}'
```

---

## Session Persistence

Sessions are stored in `.formic/messaging.json` and include:
- Platform (telegram/line)
- Chat ID
- User information
- Linked workspace path
- Notification preferences
- Last active timestamp

Sessions survive server restarts.

---

## Notifications

When tasks change status, Formic automatically sends notifications to linked chats:

| Event | Notification |
|-------|--------------|
| Task completed | "Task Completed - [task-id] Task Title" |
| Task failed | "Task Failed - [task-id] Task Title" |
| Ready for review | "Ready for Review - [task-id] Task Title" |

Notifications include quick action buttons to view task details.

---

## Troubleshooting

### Telegram Issues

#### Bot not responding
1. Check `TELEGRAM_BOT_TOKEN` is set correctly
2. Verify webhook is set:
   ```bash
   curl http://localhost:8000/api/messaging/status
   ```
3. Check server logs for errors

#### Webhook verification fails
- Ensure URL is HTTPS (Telegram requires it)
- Check ngrok tunnel is running
- Verify the URL path is `/api/webhooks/telegram`

#### "Telegram integration not configured" error
- Set `TELEGRAM_BOT_TOKEN` environment variable
- Restart the Formic server

### Line Issues

#### Signature verification failed
- Verify `LINE_CHANNEL_SECRET` matches the value in Line Console
- Ensure raw body parsing is working (check server logs)

#### Bot not responding
1. Check both environment variables are set:
   - `LINE_CHANNEL_ACCESS_TOKEN`
   - `LINE_CHANNEL_SECRET`
2. Verify webhook URL in Line Console
3. Disable auto-reply messages in Line Console

#### "Line integration not configured" error
- Both `LINE_CHANNEL_ACCESS_TOKEN` and `LINE_CHANNEL_SECRET` must be set
- Restart the Formic server after setting variables

### General Issues

#### Ngrok tunnel expired
- Free ngrok URLs change each restart
- Re-run ngrok and update webhook URL
- Consider ngrok paid plan for static URLs

#### Tasks not appearing
- Send `/start` first to link the chat to a workspace
- Check that Formic server is running

---

## Production Deployment

For production deployments:

1. **Use a stable HTTPS URL** - No ngrok needed if you have a domain with SSL

2. **Set environment variables securely**:
   ```bash
   # Example: Docker Compose
   services:
     formic:
       environment:
         - TELEGRAM_BOT_TOKEN=${TELEGRAM_BOT_TOKEN}
         - LINE_CHANNEL_ACCESS_TOKEN=${LINE_CHANNEL_ACCESS_TOKEN}
         - LINE_CHANNEL_SECRET=${LINE_CHANNEL_SECRET}
   ```

3. **Update webhook URLs** to your production domain:
   - Telegram: Use the API endpoint
   - Line: Update in Line Developers Console

4. **Monitor webhook health** - Check `/api/messaging/status` periodically

---

## Security Considerations

- **Never commit tokens** to version control
- **Use environment variables** or secret management
- **Line webhook verification** - Signatures are verified automatically
- **Telegram** - Consider implementing additional IP verification for webhooks
- **Sessions** - Stored locally in `.formic/messaging.json`; secure this file appropriately

---

## Quick Reference

```bash
# Environment Variables
export TELEGRAM_BOT_TOKEN="your-token"
export LINE_CHANNEL_ACCESS_TOKEN="your-token"
export LINE_CHANNEL_SECRET="your-secret"

# Start Formic
formic start

# Expose locally (development)
ngrok http 8000

# Set Telegram webhook
curl -X POST http://localhost:8000/api/messaging/telegram/set-webhook \
  -H "Content-Type: application/json" \
  -d '{"webhookUrl": "https://your-ngrok-url.ngrok.io/api/webhooks/telegram"}'

# Check status
curl http://localhost:8000/api/messaging/status

# View sessions
curl http://localhost:8000/api/messaging/sessions
```
