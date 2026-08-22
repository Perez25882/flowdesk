# Running Flowdesk on this machine

What is actually running after the 22 Aug setup, and how to bring it back.

## The one gotcha: NODE_ENV

This machine has `NODE_ENV=production` set as a **global** environment
variable. `dotenv` does not overwrite variables that already exist, so the
`NODE_ENV=development` line in `.env` is ignored and the API boots in
production mode — where it deliberately refuses to start, because
`META_ACCESS_TOKEN` and `META_PHONE_NUMBER_ID` must never be set in a Tech
Provider deployment.

Every command below therefore sets it explicitly. The permanent fix is to
remove the global variable (System Properties → Environment Variables), which
is also worth doing because `npm install` with `NODE_ENV=production` skips
devDependencies.

## Bring it up

Four terminals, from `C:\Users\DELL\Downloads\flowdesk-docs`:

```powershell
# 1. API + workers (port 3000)
$env:NODE_ENV='development'; pnpm dev:api

# 2. Dashboard (port 5173)
$env:NODE_ENV='development'; pnpm dev:web

# 3. Public tunnel — Vite proxies /api/v1 to the API, so one URL serves
#    both the dashboard and the webhook
$env:NODE_ENV='development'; pnpm tunnel

# 4. Send a test message through the whole pipeline
$env:NODE_ENV='development'; pnpm simulate --text "How much is a bag of rice?" --from 233558425882
```

Postgres 17 and Redis 8 run as Windows services and are already up; the
`docker-compose.yml` is an alternative, not a requirement.

Check it is healthy: `http://127.0.0.1:3000/health` should report
`db: connected, redis: connected`.

## What is wired

| Piece | Value |
| --- | --- |
| Public URL | `https://incurrable-wilhelmina-uncolloquially.ngrok-free.dev` |
| Webhook | `<public URL>/api/v1/webhook`, verify token in `.env` |
| WhatsApp number | `+1 555-650-1846` (Meta test number), phone id `1104754576062818` |
| WABA | `2750994771937021`, subscribed to the FlowDesk app |
| Connected shop | **Manoip** — `GROUNDED_AUTO`, `CATALOGUE` |
| Assistant model | `meta/llama-3.1-8b-instruct` on NVIDIA NIM |

The ngrok URL is reserved to the account, so it survives restarts and does not
have to be re-pasted into Meta. If you ever do change it, re-point the
subscription with:

```powershell
node qa\meta-wire.mjs --callback "https://<new-host>/api/v1/webhook"
```

## Moving to your own number

The number above is Meta's test number. It can only exchange messages with the
recipients registered against it in the Meta console, which is why
`+233558425882` works. Putting the shop's real number (`+233205464182`) on it
is a console job that needs an OTP sent to that handset: WhatsApp Manager → Add
phone number → verify. Nothing in the code changes — once the number is
verified, run:

```powershell
node qa\meta-waba.mjs                       # confirm the new phone number id
$env:NODE_ENV='development'
pnpm --filter @flowdesk/api exec tsx ..\..\qa\connect-number.ts <owner-email>
```

In production every shop does this for itself through Embedded Signup; these
scripts exist only so a local run does not need the dialog.

## Scripts added for this

- `qa/meta-wire.mjs` — set/read the webhook subscription (`--check` reads only)
- `qa/meta-waba.mjs` — find the WhatsApp Business Account behind the number
- `qa/connect-number.ts` — write the number onto one business row, encrypting
  the token exactly as Embedded Signup does

None of them print a secret.
