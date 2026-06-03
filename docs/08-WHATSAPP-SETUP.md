# Flowdesk — WhatsApp Business API Setup Guide

---

## Overview

Flowdesk uses the **Meta Cloud API** (formerly Cloud API). Meta hosts the WhatsApp infrastructure — you do not run a WhatsApp server. You register a webhook URL that Meta calls whenever a message arrives.

Cost: Free access to the API. You pay per conversation after the free tier (1000 service conversations/month per WhatsApp Business Account).

---

## Step 1: Meta Developer Account

1. Go to [developers.facebook.com](https://developers.facebook.com)
2. Log in with a Facebook account (create one if needed — use a business account)
3. Click "My Apps" → "Create App"
4. App type: **Business**
5. App name: "Flowdesk" (or your white-label name)
6. Business account: create or select your Meta Business account

---

## Step 2: Add WhatsApp Product

1. In your app dashboard → "Add Product" → WhatsApp → Set Up
2. You'll land on the WhatsApp Getting Started page
3. Note your **App ID** and **App Secret** (Settings → Basic) → add to `.env`

---

## Step 3: Create a WhatsApp Business Account

1. In the WhatsApp section → "Getting Started"
2. Create or connect a **WhatsApp Business Account (WABA)**
3. Add a phone number (this is the number businesses will use for Flowdesk)
   - For development: Meta provides a test number with 5 test recipients
   - For production: use a real business phone number
4. Note the **Phone Number ID** → add to `.env` as `META_PHONE_NUMBER_ID`

---

## Step 4: Create a System User Token

This is the access token your server uses to send messages.

1. Go to [business.facebook.com](https://business.facebook.com)
2. Settings → Users → System Users
3. Create a System User (Admin role)
4. Click "Generate New Token" → select your app → select these permissions:
   - `whatsapp_business_messaging`
   - `whatsapp_business_management`
5. Copy the token → add to `.env` as `META_ACCESS_TOKEN`
6. **Important:** System user tokens don't expire (unlike user tokens). Keep it secure.

---

## Step 5: Register the Webhook

1. In your app → WhatsApp → Configuration
2. Webhook section → Edit
3. **Callback URL:** `https://yourdomain.com/api/v1/webhook`
   (Must be HTTPS. Use Cloudflare Tunnel for local development.)
4. **Verify Token:** Any string you choose → set as `META_VERIFY_TOKEN` in `.env`
5. Click Verify and Save
6. Subscribe to webhook fields: `messages`, `message_status`

---

## Step 6: Local Development Webhook

Meta requires a public HTTPS URL. For local development:

**Option A: Cloudflare Tunnel (recommended, free)**
```bash
# Install cloudflared
wget https://github.com/cloudflare/cloudflared/releases/latest/download/cloudflared-linux-amd64.deb
sudo dpkg -i cloudflared-linux-amd64.deb

# Create tunnel (no account required for temporary tunnels)
cloudflared tunnel --url http://localhost:3001

# Output: https://random-name.trycloudflare.com
# Use this URL as your webhook callback URL
```

**Option B: ngrok**
```bash
ngrok http 3001
# Use the https URL as your webhook callback URL
```

---

## Step 7: Test the Connection

Send a WhatsApp message to your test number. Check:

```bash
# Check the database
psql $DATABASE_URL -c "SELECT id, body, intent FROM messages ORDER BY created_at DESC LIMIT 5;"

# Check the queue (if Bull Board is running)
open http://localhost:3001/admin/queues

# Check logs
pm2 logs api --lines 50
```

---

## Phone Number Format (Ghana)

All phone numbers must be normalized to international format without `+`:

| Input Format | Normalized |
|-------------|-----------|
| 0244123456 | 233244123456 |
| +233244123456 | 233244123456 |
| 233244123456 | 233244123456 |
| 244123456 | 233244123456 |

Ghana numbers: country code `233` + 9 digits (no leading 0).

Use `normalizeGhanaPhone()` from `utils/reference-generator.ts` on every phone number before storage.

---

## Message Types Reference

| Meta Type | Description | Flowdesk Action |
|-----------|-------------|-----------------|
| `text` | Plain text message | Intent classification → pipeline |
| `image` | Image attachment | Check for MoMo screenshot pattern |
| `audio` | Voice note | Flag for manual review |
| `video` | Video | Log only |
| `document` | PDF, doc, etc. | Log, notify owner |
| `sticker` | Sticker | Log only |
| `reaction` | Emoji reaction to message | Log only |
| `button` | Button reply | Treat as text for classification |
| `interactive` | List reply | Treat as text for classification |

---

## Conversation Pricing (Ghana)

As of 2024 Meta pricing:

| Category | Price per 24hr window |
|---------|-----------------------|
| Service (customer-initiated) | ~$0.044 |
| Utility (business-initiated with template) | ~$0.024 |
| Authentication | ~$0.035 |
| Marketing | ~$0.058 |
| First 1000 service conversations/month | Free |

**For Flowdesk pricing:**
- Starter plan (500 conversations): 500 × $0.044 = $22 cost → covered by GHS 150 (~$13) subscription at current rates
- Business plan (2000 conversations): 2000 × $0.044 = $88 cost → partially covered, make up on Business plan price
- **Correct approach:** Price plans in Cedis, adjust quarterly for exchange rate. Absorb conversation cost as COGS.

---

## Conversation Window Rule

Within a **24-hour window** of the customer's last message: send any free-form text.  
Outside the 24-hour window: **must use an approved Message Template**.

Flowdesk checks `customer.lastInteractionAt` before sending:

```typescript
const withinWindow = (lastInteraction: Date): boolean => {
  const windowMs = 24 * 60 * 60 * 1000; // 24 hours
  return Date.now() - lastInteraction.getTime() < windowMs;
};
```

**For MVP:** All auto-replies are triggered by customer messages (so always within the 24hr window). Proactive messages (order ready, broadcast) require pre-approved templates.

---

## Message Templates

Templates must be approved by Meta before use. Approval takes 1–24 hours.

Template format:
```json
{
  "name": "order_confirmed",
  "language": "en",
  "category": "UTILITY",
  "components": [
    {
      "type": "BODY",
      "text": "Your order {{1}} has been confirmed and is being prepared. We'll notify you when it's ready."
    }
  ]
}
```

**Templates to create on day one:**
1. `order_received` — "We received your order (Ref: {{1}}). We'll confirm shortly."
2. `order_confirmed` — "Your order {{1}} is confirmed and being prepared."
3. `order_fulfilled` — "Your order {{1}} has been dispatched. Thank you!"
4. `payment_received` — "Payment of GHS {{1}} received for order {{2}}. Thank you."
5. `low_stock_alert` — "Stock alert: {{1}} is running low. Current stock: {{2}} {{3}}."

---

## Webhook Payload Structure

Understanding the exact Meta payload shape:

```json
{
  "object": "whatsapp_business_account",
  "entry": [{
    "id": "WABA_ID",
    "changes": [{
      "value": {
        "messaging_product": "whatsapp",
        "metadata": {
          "display_phone_number": "233244000000",
          "phone_number_id": "PHONE_NUMBER_ID"
        },
        "contacts": [{
          "profile": { "name": "Kwame Mensah" },
          "wa_id": "233244123456"
        }],
        "messages": [{
          "from": "233244123456",
          "id": "wamid.xxx",
          "timestamp": "1714000000",
          "text": { "body": "I want 3 bags of rice" },
          "type": "text"
        }]
      },
      "field": "messages"
    }]
  }]
}
```

**The key path:** `entry[0].changes[0].value.messages[0]`

Always check `entry[0].changes[0].field === 'messages'` before processing — Meta sends other event types (account_alerts, etc.) to the same webhook.

---

## Sending a Message

```typescript
// POST to this URL
const url = `https://graph.facebook.com/${env.META_API_VERSION}/${env.META_PHONE_NUMBER_ID}/messages`;

// Request body for a text message
const body = {
  messaging_product: 'whatsapp',
  recipient_type: 'individual',
  to: '233244123456',  // normalized phone number
  type: 'text',
  text: {
    preview_url: false,
    body: 'Your order FD-00234 has been confirmed!'
  }
};

// Headers
const headers = {
  'Authorization': `Bearer ${env.META_ACCESS_TOKEN}`,
  'Content-Type': 'application/json'
};
```

---

## Rate Limits

| Limit | Value |
|-------|-------|
| Messages per second (per phone number) | 80 |
| Template messages per second | 20 |
| API calls per hour | 200,000 |

BullMQ concurrency for the notification queue: max 40 concurrent sends (50% of rate limit for safety).

---

## Error Codes to Handle

| Code | Meaning | Action |
|------|---------|--------|
| 130429 | Rate limit hit | Retry with exponential backoff |
| 131026 | Recipient phone not on WhatsApp | Mark customer as non-WA, log |
| 131047 | Sender's 24hr window expired | Send via approved template |
| 131051 | Message blocked | Log, notify owner |
| 132000 | Template not found | Log error, alert developer |
| 100 | Invalid parameter | Log full error, this is a code bug |

---

## Security Checklist

- [ ] `META_WEBHOOK_SECRET` is set (not the verify token — the app secret for HMAC)
- [ ] Every POST to /webhook validates `X-Hub-Signature-256` header before processing
- [ ] `META_ACCESS_TOKEN` stored in environment variable, never in code or logs
- [ ] Webhook URL only accepts POST from Meta IP ranges (enforced via Cloudflare WAF in Phase 2)
- [ ] `META_VERIFY_TOKEN` is a random string (not a guessable word)
