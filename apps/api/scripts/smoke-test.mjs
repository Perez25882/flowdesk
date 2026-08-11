#!/usr/bin/env node
/**
 * End-to-end smoke test for the Flowdesk message pipeline.
 *
 * Exercises the product's headline journey against a running API:
 *
 *   register -> connect WhatsApp number -> build catalog
 *     -> signed inbound webhook (as Meta would send it)
 *     -> message stored, classified, order created with real prices
 *     -> owner confirms -> stock deducted -> balance updated
 *
 * Run with the API up:  node scripts/smoke-test.mjs
 */

import { createHmac, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/** Minimal .env reader — the script must not depend on the API's own config. */
function loadEnv() {
  const out = {};
  for (const line of readFileSync(join(ROOT, '.env'), 'utf8').split('\n')) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)$/);
    if (!match) continue;
    out[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

const env = loadEnv();
const BASE = process.env.API_URL ?? 'http://localhost:3000';
const API = `${BASE}/api/v1`;
const PHONE_NUMBER_ID = `smoke-${randomUUID().slice(0, 8)}`;
const CUSTOMER_WA = '233201112233';

let passed = 0;
let failed = 0;

function check(label, condition, detail = '') {
  if (condition) {
    console.log(`  ✓ ${label}`);
    passed += 1;
  } else {
    console.log(`  ✗ ${label}${detail ? ` — ${detail}` : ''}`);
    failed += 1;
  }
}

async function call(path, { method = 'GET', body, token } = {}) {
  const headers = {};
  if (body) headers['Content-Type'] = 'application/json';
  if (token) headers.Authorization = `Bearer ${token}`;

  const response = await fetch(`${API}${path}`, {
    method,
    headers,
    body: body ? JSON.stringify(body) : undefined,
  });

  const text = await response.text();
  let json;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text };
  }
  return { status: response.status, body: json };
}

/** Signs a webhook body exactly as Meta does, so signature validation is exercised. */
async function sendWebhookTo(phoneNumberId, customerWa, profileName, messageText) {
  const payload = {
    object: 'whatsapp_business_account',
    entry: [
      {
        id: 'entry-1',
        changes: [
          {
            field: 'messages',
            value: {
              messaging_product: 'whatsapp',
              metadata: { display_phone_number: '233555000111', phone_number_id: phoneNumberId },
              contacts: [{ profile: { name: profileName }, wa_id: customerWa }],
              messages: [
                {
                  from: customerWa,
                  id: `wamid.${randomUUID()}`,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  type: 'text',
                  text: { body: messageText },
                },
              ],
            },
          },
        ],
      },
    ],
  };

  const raw = JSON.stringify(payload);
  const signature = createHmac('sha256', env.META_WEBHOOK_SECRET).update(raw).digest('hex');

  const response = await fetch(`${API}/webhook`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-hub-signature-256': `sha256=${signature}`,
    },
    body: raw,
  });

  return { status: response.status, body: await response.json().catch(() => ({})) };
}

/** Delivers to the primary test business. */
async function sendWebhook(messageText) {
  return sendWebhookTo(PHONE_NUMBER_ID, CUSTOMER_WA, 'Emmanuel Osei', messageText);
}

/** Polls until the async worker pipeline produces a result, or times out. */
async function waitFor(label, fn, timeoutMs = 20_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const result = await fn();
    if (result) return result;
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  console.log(`  ✗ timed out waiting for ${label}`);
  failed += 1;
  return null;
}

async function main() {
  console.log('\nFlowdesk end-to-end smoke test');
  console.log('='.repeat(60));

  // ── Account ──────────────────────────────────────────────────────────────
  console.log('\n1. Account');
  const email = `smoke-${randomUUID().slice(0, 8)}@flowdesk.test`;
  const register = await call('/auth/register', {
    method: 'POST',
    body: {
      businessName: "Ama's Store",
      ownerName: 'Ama Serwaa',
      email,
      password: 'SmokeTest-Passw0rd',
      phone: '0244000111',
    },
  });
  check('registers a business', register.status === 201, JSON.stringify(register.body));
  const token = register.body?.data?.accessToken;
  if (!token) {
    console.log('\nAborting: no access token returned.');
    process.exit(1);
  }

  const wrongPassword = await call('/auth/login', {
    method: 'POST',
    body: { email, password: 'definitely-wrong' },
  });
  check('rejects a wrong password', wrongPassword.status === 401);

  // ── WhatsApp ─────────────────────────────────────────────────────────────
  console.log('\n2. WhatsApp connection');
  const connect = await call('/whatsapp/connect/manual', {
    method: 'POST',
    token,
    body: { phoneNumberId: PHONE_NUMBER_ID, accessToken: 'smoke-test-token' },
  });
  check('connects a WhatsApp number', connect.status === 200, JSON.stringify(connect.body));

  // ── Catalog ──────────────────────────────────────────────────────────────
  console.log('\n3. Product catalog');
  const products = [
    { name: 'Rice 50kg', unit: 'bag', price: 450, stockQuantity: 20, reorderThreshold: 8,
      aliases: ['rice', 'big rice', 'bag of rice'] },
    { name: 'Malta Guinness 33cl', unit: 'bottle', price: 5.5, stockQuantity: 200,
      reorderThreshold: 48, aliases: ['malta', 'malt'] },
  ];

  for (const product of products) {
    const result = await call('/products', { method: 'POST', token, body: product });
    check(`creates ${product.name}`, result.status === 201, JSON.stringify(result.body));
  }

  // ── The headline demo ────────────────────────────────────────────────────
  console.log('\n4. Inbound WhatsApp message -> order');
  const webhook = await sendWebhook('Hello, I want 2 bags of rice 50kg and 12 malta');
  check('accepts a signed webhook', webhook.status === 200, JSON.stringify(webhook.body));

  const badSignature = await fetch(`${API}/webhook`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-hub-signature-256': 'sha256=' + '0'.repeat(64) },
    body: JSON.stringify({ object: 'test', entry: [] }),
  });
  check('rejects an invalid webhook signature', badSignature.status === 401);

  const orders = await waitFor('order creation', async () => {
    const result = await call('/orders?status=PENDING', { token });
    const list = result.body?.data;
    return Array.isArray(list) && list.length > 0 ? list : null;
  });

  if (!orders) {
    console.log('\nAborting: no order was created from the inbound message.');
    summary();
    process.exit(1);
  }

  const order = orders[0];
  console.log(`     -> ${order.referenceNumber}  GHS ${order.totalAmount}`);
  for (const item of order.items ?? []) {
    console.log(`        ${item.quantity} x ${item.description} @ ${item.unitPrice}`);
  }

  check('order has a reference number', /^FD-/.test(order.referenceNumber ?? ''));
  check('order extracted two line items', (order.items ?? []).length === 2,
    `got ${(order.items ?? []).length}`);
  check('both items matched the catalog', (order.items ?? []).every((i) => i.matched));
  // 2 x 450 + 12 x 5.50 = 966
  check('order total is priced correctly (GHS 966)', Number(order.totalAmount) === 966,
    `got ${order.totalAmount}`);

  const customer = await call('/customers', { token });
  const created = customer.body?.data?.[0];
  check('customer auto-created from the message', Boolean(created), JSON.stringify(customer.body));
  check('customer name taken from the WhatsApp profile', created?.name === 'Emmanuel Osei',
    `got ${created?.name}`);

  // ── Lifecycle ────────────────────────────────────────────────────────────
  console.log('\n5. Order lifecycle');
  const confirm = await call(`/orders/${order.id}/status`, {
    method: 'PATCH',
    token,
    body: { status: 'CONFIRMED' },
  });
  check('confirms the order', confirm.status === 200, JSON.stringify(confirm.body));

  const afterConfirm = await call('/products?lowStock=true', { token });
  const lowStock = afterConfirm.body?.data ?? [];
  // Rice: 20 - 2 = 18, threshold 8 -> not low. Malta: 200 - 12 = 188, threshold 48 -> not low.
  check('no false low-stock alerts', lowStock.length === 0, JSON.stringify(lowStock));

  const balanceAfterConfirm = await call('/customers', { token });
  const owing = Number(balanceAfterConfirm.body?.data?.[0]?.outstandingBalance ?? 0);
  check('outstanding balance reflects the confirmed order', owing === 966, `got ${owing}`);

  // ── Payment ──────────────────────────────────────────────────────────────
  console.log('\n6. Payment');
  const payment = await call('/payments', {
    method: 'POST',
    token,
    body: { customerId: created.id, orderId: order.id, amount: 500, method: 'MOMO_MTN' },
  });
  check('logs a payment', payment.status === 201, JSON.stringify(payment.body));

  const afterPayment = await call('/customers', { token });
  const remaining = Number(afterPayment.body?.data?.[0]?.outstandingBalance ?? 0);
  check('balance reduced by the payment (966 - 500 = 466)', remaining === 466, `got ${remaining}`);

  const spend = Number(afterPayment.body?.data?.[0]?.totalSpend ?? 0);
  check('total spend recorded', spend === 500, `got ${spend}`);

  const orderCount = Number(afterPayment.body?.data?.[0]?.totalOrders ?? 0);
  check('customer order count maintained', orderCount === 1, `got ${orderCount}`);

  // Voiding a payment must reverse its effect while keeping the record.
  // A deleted payment is a destroyed alibi, so the row surviving is the assertion
  // that matters most here.
  const paymentId = payment.body?.data?.id;
  if (paymentId) {
    const voided = await call(`/payments/${paymentId}/void`, {
      method: 'POST',
      token,
      body: { reason: 'smoke test reversal' },
    });
    check('voiding a payment succeeds', voided.status === 204, `got ${voided.status}`);

    const reverted = await call('/customers', { token });
    const restored = Number(reverted.body?.data?.[0]?.outstandingBalance ?? 0);
    check('voiding a payment restores the balance', restored === 966, `got ${restored}`);

    const after = await call(`/payments?customerId=${created.id}`, { token });
    const row = after.body?.data?.find((p) => p.id === paymentId);
    check('the voided payment is still on the record', Boolean(row), 'row was destroyed');
    check(
      'the voided payment carries its reason',
      row?.voidedAt !== null && row?.voidReason === 'smoke test reversal',
      JSON.stringify(row),
    );

    const secondVoid = await call(`/payments/${paymentId}/void`, {
      method: 'POST',
      token,
      body: { reason: 'double submit' },
    });
    check('voiding twice is rejected', secondVoid.status === 400, `got ${secondVoid.status}`);
  }

  // ── Lifecycle rules ──────────────────────────────────────────────────────
  console.log('\n7. Order lifecycle rules');
  const skipAhead = await call(`/orders/${order.id}/status`, {
    method: 'PATCH',
    token,
    body: { status: 'FULFILLED' },
  });
  // The order is CONFIRMED; jumping straight to FULFILLED skips PROCESSING.
  check('rejects an illegal status jump', skipAhead.status === 400, JSON.stringify(skipAhead.body));

  const cancelNoReason = await call(`/orders/${order.id}/status`, {
    method: 'PATCH',
    token,
    body: { status: 'CANCELLED' },
  });
  check(
    'requires a reason when cancelling',
    cancelNoReason.status === 400,
    JSON.stringify(cancelNoReason.body),
  );

  // ── Tenant isolation ─────────────────────────────────────────────────────
  console.log('\n8. Tenant isolation');
  const otherEmail = `smoke-other-${randomUUID().slice(0, 8)}@flowdesk.test`;
  const other = await call('/auth/register', {
    method: 'POST',
    body: {
      businessName: 'Unrelated Trading Co',
      ownerName: 'Someone Else',
      email: otherEmail,
      password: 'SmokeTest-Passw0rd',
    },
  });
  const otherToken = other.body?.data?.accessToken;
  check('registers a second business', Boolean(otherToken));

  if (otherToken) {
    const theirOrders = await call('/orders', { token: otherToken });
    check(
      "second business sees none of the first's orders",
      Array.isArray(theirOrders.body?.data) && theirOrders.body.data.length === 0,
      JSON.stringify(theirOrders.body?.data?.length),
    );

    const theirCustomers = await call('/customers', { token: otherToken });
    check(
      "second business sees none of the first's customers",
      Array.isArray(theirCustomers.body?.data) && theirCustomers.body.data.length === 0,
    );

    // Direct object reference: knowing the id must not be enough to read it.
    const stolen = await call(`/orders/${order.id}`, { token: otherToken });
    check(
      "cannot fetch another business's order by id",
      stolen.status === 404 || stolen.status === 403,
      `status ${stolen.status}`,
    );

    const stolenPayment = await call('/payments', {
      method: 'POST',
      token: otherToken,
      body: { customerId: created.id, amount: 50, method: 'CASH' },
    });
    check(
      "cannot attach a payment to another business's customer",
      stolenPayment.status === 404 || stolenPayment.status === 403,
      `status ${stolenPayment.status}`,
    );
  }

  // ── Staff ────────────────────────────────────────────────────────────────
  console.log('\n9. Staff access');
  const invite = await call('/staff/invite', {
    method: 'POST',
    token,
    body: { name: 'Kofi Boateng', phone: '0209876543', role: 'DELIVERY' },
  });
  check('owner can invite staff', invite.status === 201, JSON.stringify(invite.body));

  const inviteToken = invite.body?.data?.inviteToken;
  if (inviteToken) {
    const accept = await call('/staff/accept', {
      method: 'POST',
      body: { token: inviteToken, password: 'StaffPassw0rd!' },
    });
    check('staff can accept the invite without a token', accept.status === 200,
      JSON.stringify(accept.body));

    const staffLogin = await call('/staff/login', {
      method: 'POST',
      body: { phone: '0209876543', password: 'StaffPassw0rd!' },
    });
    check('staff can sign in', staffLogin.status === 200, JSON.stringify(staffLogin.body));

    const staffToken = staffLogin.body?.data?.accessToken;
    if (staffToken) {
      const staffInvites = await call('/staff/invite', {
        method: 'POST',
        token: staffToken,
        body: { name: 'Someone', phone: '0201111111', role: 'OPERATIONS' },
      });
      check(
        'delivery staff cannot invite other staff',
        staffInvites.status === 403,
        `status ${staffInvites.status}`,
      );
    }
  } else {
    check('invite returned a token', false, 'no inviteToken in response');
  }

  // ── Plan usage ───────────────────────────────────────────────────────────
  console.log('\n10. Plan usage');
  const usage = await call('/businesses/me/usage', { token });
  check('reports plan usage', usage.status === 200, JSON.stringify(usage.body));

  const snapshot = usage.body?.data;
  if (snapshot) {
    console.log(
      `     -> orders ${snapshot.orders?.used}/${snapshot.orders?.limit}` +
        `, products ${snapshot.products?.used}/${snapshot.products?.limit}` +
        `, staff ${snapshot.staff?.used}/${snapshot.staff?.limit}`,
    );
    check('order usage was counted', Number(snapshot.orders?.used) >= 1);
    check('product usage was counted', Number(snapshot.products?.used) === 2);
    check('starter plan caps products at 50', Number(snapshot.products?.limit) === 50);
  }

  // ── Multi-tenant WhatsApp routing ────────────────────────────────────────
  console.log('\n11. Multi-tenant WhatsApp');

  if (otherToken) {
    // A second tenant connects its OWN number, and a message to that number
    // must land in that tenant's dashboard and nowhere else.
    const otherPhoneNumberId = `smoke-b-${randomUUID().slice(0, 8)}`;
    const otherConnect = await call('/whatsapp/connect/manual', {
      method: 'POST',
      token: otherToken,
      body: { phoneNumberId: otherPhoneNumberId, accessToken: 'smoke-token-b' },
    });
    check('second business connects its own number', otherConnect.status === 200);

    // The same number cannot be claimed by two tenants — it is the routing key.
    const stealNumber = await call('/whatsapp/connect/manual', {
      method: 'POST',
      token,
      body: { phoneNumberId: otherPhoneNumberId, accessToken: 'smoke-token-a' },
    });
    check(
      "cannot connect a number already claimed by another business",
      stealNumber.status === 409,
      `status ${stealNumber.status}`,
    );

    // Deliver to tenant B's number and confirm it lands only in tenant B.
    const beforeA = await call('/messages', { token });
    const beforeCountA = beforeA.body?.data?.length ?? 0;

    const toB = await sendWebhookTo(otherPhoneNumberId, '233207770001', 'Kojo', '5 malta please');
    check('accepts a webhook for the second business', toB.status === 200);

    const bMessages = await waitFor('message routed to the second business', async () => {
      const result = await call('/messages', { token: otherToken });
      const list = result.body?.data;
      return Array.isArray(list) && list.length > 0 ? list : null;
    });

    check('message routed to the owning business', Boolean(bMessages));
    check(
      'routed message is the one that was sent',
      bMessages?.[0]?.body === '5 malta please',
      JSON.stringify(bMessages?.[0]?.body),
    );

    const afterA = await call('/messages', { token });
    check(
      "second business's traffic did not leak into the first",
      (afterA.body?.data?.length ?? 0) === beforeCountA,
      `${beforeCountA} -> ${afterA.body?.data?.length}`,
    );

    // Tenant B sells nothing, so "5 malta" must NOT become a priced order —
    // proving catalog evidence is scoped per tenant rather than shared.
    const bOrders = await call('/orders', { token: otherToken });
    const bPriced = (bOrders.body?.data ?? []).some((order) => Number(order.totalAmount) > 0);
    check("second business's empty catalog produced no priced order", !bPriced);
  }

  // With a placeholder token, Meta rejects the first send. That must be
  // recorded against this tenant so the owner is told to reconnect — and it
  // must not affect anyone else.
  const waStatus = await waitFor('connection health to be evaluated', async () => {
    const result = await call('/whatsapp/status', { token });
    return result.body?.data?.state && result.body.data.state !== 'ACTIVE' ? result : null;
  }, 25_000);

  check('reports WhatsApp connection health', Boolean(waStatus));
  check(
    'invalid credentials mark the connection TOKEN_INVALID',
    waStatus?.body?.data?.state === 'TOKEN_INVALID',
    JSON.stringify(waStatus?.body?.data?.state),
  );
  check(
    'records an owner-facing reason for the outage',
    typeof waStatus?.body?.data?.error === 'string' && waStatus.body.data.error.length > 0,
  );

  summary();
  process.exit(failed === 0 ? 0 : 1);
}

function summary() {
  console.log('\n' + '='.repeat(60));
  console.log(`${passed} passed, ${failed} failed`);
}

main().catch((error) => {
  console.error('\nSmoke test crashed:', error);
  process.exit(1);
});
