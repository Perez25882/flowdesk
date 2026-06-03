# Flowdesk Launch Guide

This guide will get you from zero to a live, chargeable MVP.

---

## 1. Prerequisites

| Requirement | Version | Why |
|-------------|---------|-----|
| Node.js | `>= 20` | Runtime for API and build |
| pnpm | `>= 9` | Package manager (workspace monorepo) |
| PostgreSQL | `>= 15` | Primary database |
| Redis | `>= 7` | Queues, caching, OTP store, session pub/sub |

**Verify:**

```bash
node -v      # should print v20.x or higher
pnpm -v      # should print 9.x or higher
```

**Install (if missing):**

```bash
# macOS (Homebrew)
brew install node pnpm postgresql redis

# Ubuntu / Debian
sudo apt update
sudo apt install -y postgresql postgresql-contrib redis-server
npm install -g pnpm
```

---

## 2. Clone & Install

```bash
git clone <your-repo> flowdesk
cd flowdesk
pnpm install
```

---

## 3. Database Setup

### 3.1 Create the database

```bash
# Start PostgreSQL (if not running)
sudo service postgresql start   # Linux
brew services start postgresql  # macOS

# Create database and user
sudo -u postgres psql -c "CREATE DATABASE flowdesk;"
sudo -u postgres psql -c "CREATE USER flowdesk WITH ENCRYPTED PASSWORD 'your_secure_password';"
sudo -u postgres psql -c "GRANT ALL PRIVILEGES ON DATABASE flowdesk TO flowdesk;"
```

### 3.2 Run migrations

```bash
cd apps/api
npx prisma migrate dev --name init
npx prisma generate
```

---

## 4. Redis Setup

```bash
# Start Redis (if not running)
sudo service redis-server start   # Linux
brew services start redis         # macOS

# Test connection
redis-cli ping   # should return "PONG"
```

---

## 5. Environment Variables

Copy the example file and fill in your real values:

```bash
cp .env.example apps/api/.env
```

### Required Keys — How to Get Each One

#### `JWT_SECRET` & `JWT_REFRESH_SECRET`
Generate two different random 64-character strings:

```bash
node -e "console.log(require('crypto').randomBytes(64).toString('hex'))"
# Run this TWICE and save both outputs separately
```

#### `META_APP_ID`, `META_APP_SECRET`, `META_VERIFY_TOKEN`
1. Go to [developers.facebook.com](https://developers.facebook.com)
2. Create a new app → Select **Business** type
3. Add product: **WhatsApp**
4. In app dashboard → Settings → Basic → copy **App ID** and **App Secret**
5. Set `META_VERIFY_TOKEN` to any random string you choose (used for webhook verification)
6. `META_WEBHOOK_SECRET` = the same as your App Secret (used for payload signature verification)

#### `META_PHONE_NUMBER_ID` & `META_ACCESS_TOKEN`
1. In your Meta app → WhatsApp → API Setup
2. Copy the **Phone Number ID** (looks like `123456789012345`)
3. Generate a **System User Token** with `whatsapp_business_messaging` and `whatsapp_business_management` permissions
4. Or use the temporary token, but for production generate a long-lived token
5. Paste both into `.env`

#### `ANTHROPIC_API_KEY`
1. Go to [console.anthropic.com](https://console.anthropic.com)
2. Create an API key
3. This powers the AI intent classifier (Haiku model)

#### `AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_REGION`, `AWS_S3_BUCKET`
1. Go to [AWS Console](https://console.aws.amazon.com) → IAM → Users → Create user
2. Attach policy: `AmazonS3FullAccess`
3. Create access key → copy ID and Secret
4. Go to S3 → Create bucket (e.g., `flowdesk-media-gh`)
5. Choose region (e.g., `eu-west-1`)
6. Disable "Block all public access" if you want public image URLs
7. Add bucket CORS policy (see section 9)

#### `PAYSTACK_SECRET_KEY` & `PAYSTACK_PUBLIC_KEY`
1. Sign up at [paystack.com](https://paystack.com)
2. Go to Settings → API Keys & Webhooks
3. Copy **Test Secret Key** and **Test Public Key** (use live keys when ready)
4. In Paystack dashboard → Settings → Webhooks → add: `https://api.yourdomain.com/api/v1/webhooks/paystack`

#### `RESEND_API_KEY` & `RESEND_FROM_EMAIL` (optional)
1. Sign up at [resend.com](https://resend.com)
2. Add and verify your domain
3. Create an API key
4. Set `RESEND_FROM_EMAIL` to something like `noreply@yourdomain.com`

---

## 6. Local Development Run

**Terminal 1 — API:**

```bash
cd apps/api
pnpm dev
# Server starts on http://localhost:3000
```

**Terminal 2 — Web:**

```bash
cd apps/web
pnpm dev
# Vite dev server starts on http://localhost:5173
# Proxies /api/v1 → localhost:3000 automatically
```

Open [http://localhost:5173](http://localhost:5173) and you should see the Flowdesk landing page.

---

## 7. WhatsApp Webhook Configuration (Critical)

For Flowdesk to receive incoming WhatsApp messages, Meta must be able to reach your server.

### Local development tunnel (ngrok)

```bash
# Install ngrok if you haven't
npm install -g ngrok

# Expose your local API
ngrok http 3000
```

Copy the HTTPS forwarding URL (e.g., `https://abc123.ngrok-free.app`).

### Configure Meta webhook

1. In Meta app dashboard → WhatsApp → Configuration
2. Webhook URL: `https://abc123.ngrok-free.app/api/v1/webhooks/whatsapp`
3. Verify Token: the same as your `META_VERIFY_TOKEN`
4. Subscribe to fields: `messages`, `message_deliveries`, `message_reads`
5. Click **Verify and Save**

### Production webhook URL

Replace ngrok with your actual domain:

```
https://api.yourdomain.com/api/v1/webhooks/whatsapp
```

---

## 8. First Time Registration

1. Open the app in your browser
2. Click **"Start free trial"** on the landing page
3. Fill in your name, business name, and WhatsApp phone number
4. You'll be redirected to login
5. Enter your phone number and request OTP
6. The OTP is sent via WhatsApp message to your registered number
7. Enter the OTP and log in
8. You now have a 14-day trial

---

## 9. S3 Bucket CORS Policy

In your S3 bucket → Permissions → CORS, paste:

```json
[
  {
    "AllowedHeaders": ["*"],
    "AllowedMethods": ["PUT", "POST", "GET"],
    "AllowedOrigins": ["https://app.yourdomain.com", "http://localhost:5173"],
    "MaxAgeSeconds": 3000
  }
]
```

---

## 10. Production Build & Deploy

### Build the API

```bash
cd apps/api
pnpm build
dist/server.js   # compiled output
```

### Build the Web App

```bash
cd apps/web
pnpm build
dist/            # static files for nginx/caddy/vercel/etc
```

### Recommended Production Architecture

```
User → Cloudflare / AWS CloudFront (CDN + SSL)
         ├── app.yourdomain.com → Vercel / Netlify / S3 (static web build)
         └── api.yourdomain.com → VPS / EC2 / Railway / Render (Node.js API)
                  ↓
            PostgreSQL (managed: Supabase, Neon, AWS RDS)
            Redis (managed: Upstash, Redis Cloud)
```

### Environment on Production

Set `NODE_ENV=production` and `FRONTEND_URL=https://app.yourdomain.com`.

Use a process manager like PM2:

```bash
npm install -g pm2
pm2 start dist/server.js --name flowdesk-api
pm2 save
pm2 startup
```

---

## 11. Post-Launch Checklist

| # | Task | How to verify |
|---|------|-------------|
| 1 | Webhook receives messages | Send a WhatsApp to your business number → check API logs |
| 2 | Orders auto-create | Send "I want 2 bags of rice" → check dashboard orders |
| 3 | Auto-replies send | Check WhatsApp chat → you should see confirmation |
| 4 | Media uploads work | Send an image → appears in Messages with URL |
| 5 | Payments record | Create a payment in dashboard → customer gets WhatsApp receipt |
| 6 | Paystack webhooks work | Simulate a charge.success event in Paystack dashboard |
| 7 | Plan limits enforce | Exceed conversation limit → get 402 response |
| 8 | Staff invites work | Invite staff → they receive WhatsApp invite link |

---

## 12. Common Issues

### "OTP not received"
- Check API logs: `sendOTPWhatsApp` should log success or error
- Verify your `META_ACCESS_TOKEN` is valid and not expired
- Ensure the phone number is registered with Meta WhatsApp Business
- Check that `findBusinessByPhone` returns the business for that number

### "Webhook verification failed"
- Ensure `META_VERIFY_TOKEN` matches exactly in Meta dashboard and `.env`
- Check webhook URL is HTTPS (required by Meta)
- Ensure `/api/v1/webhooks/whatsapp` route is publicly accessible

### "Media uploads fail"
- Check AWS credentials have S3 access
- Verify bucket name and region match `.env`
- Check bucket CORS policy includes your frontend domain

### "Paystack webhooks not working"
- Ensure Paystack webhook URL is HTTPS
- Verify `PAYSTACK_SECRET_KEY` in `.env` matches the key used in Paystack dashboard
- Check `X-Paystack-Signature` header is being received

---

## 13. Need Help?

- API docs (when running locally): `http://localhost:3000/documentation`
- Check logs: API uses Pino — logs are JSON formatted
- Database: Use Prisma Studio `npx prisma studio` to inspect data
