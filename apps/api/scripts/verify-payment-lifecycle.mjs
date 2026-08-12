#!/usr/bin/env node
/**
 * Live verification of the payment confidence lifecycle.
 *
 * Companion to smoke-test.mjs, which covers the WhatsApp journey end to end but
 * cannot reach its payment section without working Meta credentials: it aborts
 * at "connect a WhatsApp number" whenever the local .env carries Meta values
 * that switch `features.whatsapp` on without authenticating, because the
 * documented dev bypass then never engages and no order is ever created.
 *
 * Money handling should not be unverifiable just because WhatsApp is
 * unconfigured. `POST /orders` accepts a bare `customerPhone`, so the payment
 * lifecycle is reachable without WhatsApp at all:
 *
 *   log an unattested claim -> it must not move money
 *   attest it               -> it must move money, once
 *   attest it again         -> must be rejected, not silently repeated
 *   void it                 -> money reverses AND the row survives with its reason
 *   void it again           -> must be rejected
 *   log a refund (OUT)      -> must subtract, not add
 */

import { randomUUID } from 'node:crypto';

const API = `${process.env.API_URL ?? 'http://localhost:3000'}/api/v1`;

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

const paidOn = async (token, orderId) => {
  const res = await call(`/orders/${orderId}`, { token });
  return Number(res.body?.data?.amountPaid ?? -1);
};

console.log('\nPayment confidence lifecycle\n' + '='.repeat(60));

// ── Setup ────────────────────────────────────────────────────────────────
const email = `pay-${randomUUID().slice(0, 8)}@example.com`;
const register = await call('/auth/register', {
  method: 'POST',
  body: {
    businessName: 'Void Test Shop',
    ownerName: 'Owner',
    email,
    password: 'CorrectHorse9!',
    phone: '233555000222',
  },
});
const token = register.body?.data?.accessToken ?? register.body?.data?.token;
check('registers a business', Boolean(token), JSON.stringify(register.body).slice(0, 200));
if (!token) process.exit(1);

const order = await call('/orders', {
  method: 'POST',
  token,
  body: {
    customerPhone: '233209998877',
    customerName: 'Ama Serwaa',
    rawMessage: 'manual order for payment lifecycle test',
    items: [{ description: 'Rice 50kg', quantity: 1, unitPrice: 500 }],
  },
});
const orderId = order.body?.data?.id;
const customerId = order.body?.data?.customerId ?? order.body?.data?.customer?.id;
check('creates a manual order', Boolean(orderId), JSON.stringify(order.body).slice(0, 300));
if (!orderId || !customerId) process.exit(1);

const total = Number(order.body?.data?.totalAmount ?? 0);
check('order total is 500', total === 500, `got ${total}`);

// ── A claim must not move money ──────────────────────────────────────────
console.log('\n1. An unattested claim counts for nothing');
const claim = await call('/payments', {
  method: 'POST',
  token,
  body: { customerId, orderId, amount: 500, method: 'MOMO_MTN', attested: false },
});
const claimId = claim.body?.data?.id;
check('logs an unattested claim', claim.status === 201, JSON.stringify(claim.body).slice(0, 200));
check('claim is CLAIMED', claim.body?.data?.confidence === 'CLAIMED', String(claim.body?.data?.confidence));
check('claim does NOT move amountPaid', (await paidOn(token, orderId)) === 0, 'money moved on a bare claim');

// ── Attestation moves money, exactly once ────────────────────────────────
console.log('\n2. Attestation moves money, once');
const attest = await call(`/payments/${claimId}/attest`, { method: 'PATCH', token });
check('attesting succeeds', attest.status === 200, `got ${attest.status}`);
check('confidence is SELLER_ATTESTED', attest.body?.data?.confidence === 'SELLER_ATTESTED', String(attest.body?.data?.confidence));
check('amountPaid is now 500', (await paidOn(token, orderId)) === 500, 'attestation did not move money');

const reAttest = await call(`/payments/${claimId}/attest`, { method: 'PATCH', token });
check('attesting twice is rejected', reAttest.status === 400, `got ${reAttest.status}`);
check('amountPaid still 500 after double attest', (await paidOn(token, orderId)) === 500, 'money double-counted');

// ── Voiding reverses money but keeps the record ──────────────────────────
console.log('\n3. Voiding reverses the money and KEEPS the record');
const voided = await call(`/payments/${claimId}/void`, {
  method: 'POST',
  token,
  body: { reason: 'lifecycle verification' },
});
check('voiding succeeds', voided.status === 204, `got ${voided.status}`);
check('amountPaid back to 0', (await paidOn(token, orderId)) === 0, 'void did not reverse');

const listed = await call(`/payments?customerId=${customerId}`, { token });
const row = listed.body?.data?.find((p) => p.id === claimId);
check('the voided payment is STILL on the record', Boolean(row), 'row was destroyed - the alibi is gone');
check('it carries its void timestamp', Boolean(row) && row.voidedAt !== null, JSON.stringify(row));
check('it carries its reason', row?.voidReason === 'lifecycle verification', String(row?.voidReason));

const reVoid = await call(`/payments/${claimId}/void`, {
  method: 'POST',
  token,
  body: { reason: 'double submit' },
});
check('voiding twice is rejected', reVoid.status === 400, `got ${reVoid.status}`);

const noReason = await call(`/payments/${claimId}/void`, { method: 'POST', token, body: {} });
check('a void with no reason is rejected', noReason.status === 400, `got ${noReason.status}`);

// ── Refunds subtract ─────────────────────────────────────────────────────
console.log('\n4. A refund subtracts rather than adds');
await call('/payments', {
  method: 'POST',
  token,
  body: { customerId, orderId, amount: 500, method: 'MOMO_MTN', attested: true },
});
check('a fresh attested payment brings amountPaid to 500', (await paidOn(token, orderId)) === 500, 'setup failed');

await call('/payments', {
  method: 'POST',
  token,
  body: { customerId, orderId, amount: 200, method: 'MOMO_MTN', direction: 'OUT', attested: true },
});
const afterRefund = await paidOn(token, orderId);
check('a 200 refund leaves amountPaid at 300', afterRefund === 300, `got ${afterRefund} - refund was not netted`);

console.log('\n' + '='.repeat(60));
console.log(`${passed} passed, ${failed} failed\n`);
process.exit(failed === 0 ? 0 : 1);
