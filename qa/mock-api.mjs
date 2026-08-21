/**
 * A stand-in for the Flowdesk API, good enough to drive the real web app.
 *
 * The Prisma query engine cannot be downloaded in this sandbox, so the real
 * server cannot boot here. Everything the browser touches is served from this
 * file instead, with response shapes copied from the route handlers and Zod
 * schemas so the frontend is exercised exactly as it would be in production.
 *
 * The data is a plausible Kumasi provisions shop rather than lorem: numbers that
 * add up are the only way a screenshot tells you whether a layout survives real
 * content.
 */
import http from 'node:http';

const PORT = Number(process.env.MOCK_PORT ?? 3001);

const now = Date.now();
const ago = (mins) => new Date(now - mins * 60_000).toISOString();

const business = {
  id: 'biz_1',
  name: "Ama's Provisions",
  ownerName: 'Abena Mensah',
  phone: '233205464182',
  email: 'abena@amasprovisions.gh',
  plan: 'BUSINESS',
  trialEndsAt: new Date(now + 6 * 86400_000).toISOString(),
  waConnected: true,
  waDisplayNumber: '+233 20 546 4182',
  waVerifiedName: "Ama's Provisions",
  waConnectionState: 'CONNECTED',
  aiAssistMode: 'GROUNDED_AUTO',
  businessType: 'GROCERY',
  notifyOnNewOrder: true,
  notifyOnLowStock: true,
  notifyOnPayment: true,
};

const customers = [
  { id: 'c1', waNumber: '233558425882', name: 'Emmanuel Owusu', totalOrders: 14, totalSpend: 8940, outstandingBalance: 620, vip: true, blacklisted: false, tags: ['Wholesale'], lastInteractionAt: ago(12), notes: null },
  { id: 'c2', waNumber: '233244019388', name: 'Akosua Frimpong', totalOrders: 6, totalSpend: 2310, outstandingBalance: 0, vip: false, blacklisted: false, tags: [], lastInteractionAt: ago(96), notes: null },
  { id: 'c3', waNumber: '233276554120', name: 'Kwesi Boateng', totalOrders: 22, totalSpend: 15220, outstandingBalance: 1450, vip: false, blacklisted: false, tags: ['Retail'], lastInteractionAt: ago(41), notes: null },
  { id: 'c4', waNumber: '233201847733', name: null, totalOrders: 1, totalSpend: 132, outstandingBalance: 132, vip: false, blacklisted: false, tags: [], lastInteractionAt: ago(8), notes: null },
];

const products = [
  { id: 'p1', name: 'Rice 50kg', sku: 'RC50', aliases: ['rice', 'big rice'], unit: 'bag', price: 620, stockQuantity: 14, reorderThreshold: 10, active: true },
  { id: 'p2', name: 'Rice 25kg', sku: 'RC25', aliases: ['small rice'], unit: 'bag', price: 330, stockQuantity: 6, reorderThreshold: 8, active: true },
  { id: 'p3', name: 'Frytol Oil 5L', sku: 'FR5', aliases: ['oil', 'frytol'], unit: 'gallon', price: 145, stockQuantity: 0, reorderThreshold: 6, active: true },
  { id: 'p4', name: 'Malta Guinness 33cl', sku: 'MG33', aliases: ['malta'], unit: 'crate', price: 132, stockQuantity: 22, reorderThreshold: 5, active: true },
  { id: 'p5', name: 'Sugar 1kg', sku: 'SG1', aliases: ['sugar'], unit: 'pack', price: 28, stockQuantity: 60, reorderThreshold: 20, active: true },
];

const mkOrder = (id, ref, status, customer, items, minsAgo, paid = 0) => ({
  id, referenceNumber: ref, status,
  customer: { id: customer.id, waNumber: customer.waNumber, name: customer.name },
  items: items.map((it, i) => ({
    id: `${id}-i${i}`, productId: it.p, description: it.d, quantity: it.q,
    unitPrice: it.u, subtotal: it.q * it.u, matched: it.p !== null, matchConfidence: it.p ? 1 : null,
  })),
  totalAmount: items.reduce((s, it) => s + it.q * it.u, 0),
  amountPaid: paid,
  rawMessage: items.map((it) => `${it.q} ${it.d}`).join(', '),
  isManual: false,
  assignedTo: null, assignedStaffId: null,
  notes: null, cancelReason: null,
  stockDeducted: status !== 'PENDING',
  createdAt: ago(minsAgo), updatedAt: ago(minsAgo),
  confirmedAt: null, fulfilledAt: null, cancelledAt: null,
  statusHistory: [{ id: `${id}-h0`, fromStatus: null, toStatus: 'PENDING', changedBy: null, note: null, createdAt: ago(minsAgo) }],
  payments: [],
});

const orders = [
  mkOrder('o1', 'FD-00042', 'PENDING', customers[0], [{ p: 'p1', d: 'Rice 50kg', q: 2, u: 620 }], 9),
  mkOrder('o2', 'FD-00041', 'PENDING', customers[3], [{ p: 'p4', d: 'Malta Guinness 33cl', q: 1, u: 132 }], 26),
  mkOrder('o3', 'FD-00040', 'CONFIRMED', customers[2], [{ p: 'p2', d: 'Rice 25kg', q: 3, u: 330 }, { p: 'p5', d: 'Sugar 1kg', q: 10, u: 28 }], 88, 500),
  mkOrder('o4', 'FD-00039', 'PROCESSING', customers[1], [{ p: 'p4', d: 'Malta Guinness 33cl', q: 4, u: 132 }], 150, 528),
  mkOrder('o5', 'FD-00038', 'FULFILLED', customers[0], [{ p: 'p1', d: 'Rice 50kg', q: 1, u: 620 }, { p: 'p3', d: 'Frytol Oil 5L', q: 2, u: 145 }], 300, 910),
  mkOrder('o6', 'FD-00037', 'FULFILLED', customers[2], [{ p: 'p5', d: 'Sugar 1kg', q: 24, u: 28 }], 420, 672),
];

const messages = [
  { id: 'm1', customerId: 'c1', customer: { id: 'c1', name: 'Emmanuel Owusu', waNumber: '233558425882' }, direction: 'INBOUND', type: 'TEXT', body: 'I want 2 bags of rice 50kg', intent: 'ORDER', intentConfidence: 0.92, classifiedBy: 'AI', requiresReview: false, processed: true, relatedOrderId: 'o1', aiReplyText: 'Hi Emmanuel! We have your order for 2 bags of Rice 50kg — GHS 1,240. Ref FD-00042.', aiReplyStatus: 'AUTO_SENT', aiDetectedLanguage: 'en', createdAt: ago(9), mediaUrl: null },
  { id: 'm2', customerId: 'c4', customer: { id: 'c4', name: null, waNumber: '233201847733' }, direction: 'INBOUND', type: 'TEXT', body: 'abeg how much for malta crate?', intent: 'INQUIRY', intentConfidence: 0.81, classifiedBy: 'AI', requiresReview: false, processed: true, relatedOrderId: null, aiReplyText: 'A crate of Malta Guinness 33cl is GHS 132.', aiReplyStatus: 'AUTO_SENT', aiDetectedLanguage: 'pidgin', createdAt: ago(26), mediaUrl: null },
  { id: 'm3', customerId: 'c3', customer: { id: 'c3', name: 'Kwesi Boateng', waNumber: '233276554120' }, direction: 'INBOUND', type: 'TEXT', body: 'the rice too expensive oo, do 550 for me', intent: 'INQUIRY', intentConfidence: 0.44, classifiedBy: 'RULE', requiresReview: true, processed: true, relatedOrderId: null, aiReplyText: 'Our price for Rice 50kg is GHS 620. I have passed your message to the owner.', aiReplyStatus: 'DRAFT', aiDetectedLanguage: 'en', createdAt: ago(41), mediaUrl: null },
  { id: 'm4', customerId: 'c2', customer: { id: 'c2', name: 'Akosua Frimpong', waNumber: '233244019388' }, direction: 'INBOUND', type: 'IMAGE', body: 'I have paid', intent: 'PAYMENT', intentConfidence: 0.88, classifiedBy: 'AI', requiresReview: true, processed: true, relatedOrderId: 'o4', aiReplyText: null, aiReplyStatus: null, aiDetectedLanguage: 'en', createdAt: ago(96), mediaUrl: null },
  { id: 'm5', customerId: 'c1', customer: { id: 'c1', name: 'Emmanuel Owusu', waNumber: '233558425882' }, direction: 'INBOUND', type: 'TEXT', body: 'Maakye, wo ho te sen?', intent: 'GREETING', intentConfidence: 0.7, classifiedBy: 'RULE', requiresReview: false, processed: true, relatedOrderId: null, aiReplyText: 'Maakye! Ɛyɛ. How can we help you today?', aiReplyStatus: 'AUTO_SENT', aiDetectedLanguage: 'twi', createdAt: ago(180), mediaUrl: null },
];

const payments = [
  { id: 'pay1', amount: 500, method: 'MOMO_MTN', reference: 'MP2408.1122.A4821', confidence: 'SELLER_ATTESTED', direction: 'IN', customer: { id: 'c3', name: 'Kwesi Boateng', waNumber: '233276554120' }, orderId: 'o3', screenshotUrl: null, notes: null, voidedAt: null, voidReason: null, attestedAt: ago(80), createdAt: ago(85) },
  { id: 'pay2', amount: 528, method: 'MOMO_MTN', reference: 'MP2408.0931.B7710', confidence: 'SELLER_ATTESTED', direction: 'IN', customer: { id: 'c2', name: 'Akosua Frimpong', waNumber: '233244019388' }, orderId: 'o4', screenshotUrl: null, notes: null, voidedAt: null, voidReason: null, attestedAt: ago(140), createdAt: ago(145) },
  { id: 'pay3', amount: 910, method: 'CASH', reference: null, confidence: 'SELLER_ATTESTED', direction: 'IN', customer: { id: 'c1', name: 'Emmanuel Owusu', waNumber: '233558425882' }, orderId: 'o5', screenshotUrl: null, notes: 'Paid at the shop', voidedAt: null, voidReason: null, attestedAt: ago(290), createdAt: ago(295) },
  { id: 'pay4', amount: 132, method: 'MOMO_MTN', reference: 'MP2408.1500.C0021', confidence: 'CLAIMED', direction: 'IN', customer: { id: 'c4', name: null, waNumber: '233201847733' }, orderId: null, screenshotUrl: null, notes: 'Customer says they have sent it', voidedAt: null, voidReason: null, attestedAt: null, createdAt: ago(8) },
];

const staff = [
  { id: 's1', name: 'Kofi Asante', phone: '233559001122', role: 'OPERATIONS', active: true, invitedAt: ago(20000), inviteAcceptedAt: ago(19900), lastLoginAt: ago(300) },
  { id: 's2', name: 'Adjoa Baidoo', phone: '233248773311', role: 'DELIVERY', active: true, invitedAt: ago(400), inviteAcceptedAt: null, lastLoginAt: null },
];

const ok = (data) => ({ success: true, data });

const ROUTES = {
  'GET /auth/me': () => ok({ business, staff: null }),
  'POST /auth/login': () => ok({ accessToken: 'mock.access.token', business, staff: null }),
  'POST /auth/refresh': () => ok({ accessToken: 'mock.access.token', business, staff: null }),
  'POST /auth/logout': () => ok({}),
  'GET /settings/business': () => ok(business),
  'GET /businesses/me': () => ok(business),
  'GET /businesses/me/usage': () => ok({ plan: 'BUSINESS', effectivePlan: 'BUSINESS', conversations: { used: 412, limit: 2000, nearLimit: false }, orders: { used: 88, limit: null }, staffSeats: { used: 2, limit: 5 }, products: { used: 5, limit: null }, trial: { active: true, daysRemaining: 6, stage: 'running' } }),
  'GET /settings/templates': () => ok([
    { key: 'order_pending', label: 'Order received', body: 'Hi {name}! We received your order (Ref: {ref}). We will confirm shortly. — {business}', enabled: true },
    { key: 'order_confirmed', label: 'Order confirmed', body: 'Your order {ref} is confirmed and being prepared. — {business}', enabled: true },
    { key: 'payment_received', label: 'Payment received', body: 'Payment of GHS {amount} received for order {ref}. Thank you! — {business}', enabled: true },
  ]),
  'GET /orders': (q) => {
    const status = q.get('status');
    return ok(status ? orders.filter((o) => o.status === status) : orders);
  },
  'GET /orders/stats': () => ok({ totalOrders: 6, byStatus: { PENDING: 2, CONFIRMED: 1, PROCESSING: 1, FULFILLED: 2, CANCELLED: 0 }, totalRevenue: 4886, totalPaid: 2110, pendingAmount: 1372 }),
  'GET /customers': () => ok(customers),
  'GET /customers/stats': () => ok({ totalCustomers: 4, withBalance: 3, totalOutstanding: 2202 }),
  'GET /products': () => ok(products),
  'GET /products/low-stock': () => ok(products.filter((p) => p.stockQuantity <= p.reorderThreshold)),
  'GET /payments': (q) => {
    const attested = q.get('attested');
    let list = payments;
    if (attested === 'false') list = payments.filter((p) => !p.attestedAt);
    if (attested === 'true') list = payments.filter((p) => p.attestedAt);
    return ok(list);
  },
  'GET /payments/stats': () => ok({ totalRevenue: 2070, today: 132, thisWeek: 1560, thisMonth: 2070, byMethod: { MOMO_MTN: 1160, CASH: 910 } }),
  'GET /messages': (q) => {
    const review = q.get('requiresReview');
    return ok(review === 'true' ? messages.filter((m) => m.requiresReview) : messages);
  },
  'GET /staff': () => ok(staff),
  'GET /dashboard/badges': () => ok({ messagesNeedingReview: 2, paymentsToVerify: 1, pendingOrders: 2, lowStock: 2 }),
  'GET /dashboard/summary': () => ok({
    orders: { today: 2, pending: 2, pendingValue: 1372 },
    revenue: { today: 132, week: 1560, month: 2070 },
    outstanding: { total: 2202, topCustomers: customers.filter((c) => c.outstandingBalance > 0).slice(0, 5) },
    lowStock: products.filter((p) => p.stockQuantity <= p.reorderThreshold),
    review: { count: 2 },
    awaitingReply: [{ id: 'po1', customerName: 'Kwesi Boateng', lastQuestion: 'Which rice — the 50kg or the 25kg?', askedAt: ago(35) }],
  }),
  'GET /whatsapp/config': () => ok({ appId: '982706000000000', configId: '1313670000000000', apiVersion: 'v25.0' }),
  'GET /whatsapp/status': () => ok({ connected: true, waDisplayNumber: '+233 20 546 4182', waVerifiedName: "Ama's Provisions", state: 'CONNECTED', checkedAt: ago(3), error: null }),
  'GET /billing/plans': () => ok([
    { key: 'STARTER', name: 'Starter', amount: 15000, currency: 'GHS' },
    { key: 'BUSINESS', name: 'Business', amount: 35000, currency: 'GHS' },
    { key: 'GROWTH', name: 'Growth', amount: 70000, currency: 'GHS' },
  ]),
  'GET /billing/subscription': () => ok({ plan: 'BUSINESS', status: 'trialing', trialEndsAt: business.trialEndsAt, renewsAt: null, subscriptionCode: null }),
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, 'http://localhost');
  const path = url.pathname.replace(/^\/api\/v1/, '');
  const key = `${req.method} ${path}`;

  res.setHeader('Content-Type', 'application/json');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'authorization,content-type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,PATCH,PUT,DELETE,OPTIONS');
  if (req.method === 'OPTIONS') { res.statusCode = 204; return res.end(); }

  // SSE: hold the socket open so the dashboard shows "live" rather than retrying.
  if (path === '/sse/connect') {
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' });
    res.write('event: connected\ndata: {}\n\n');
    return;
  }
  if (path === '/sse/ticket') return res.end(JSON.stringify(ok({ ticket: 'mock-ticket' })));

  const handler = ROUTES[key];
  if (handler) return res.end(JSON.stringify(handler(url.searchParams)));

  // Detail routes.
  let m;
  if ((m = path.match(/^\/orders\/(\w+)$/))) {
    const order = orders.find((o) => o.id === m[1]);
    if (order) return res.end(JSON.stringify(ok(order)));
  }
  if ((m = path.match(/^\/customers\/(\w+)$/))) {
    const customer = customers.find((c) => c.id === m[1]);
    if (customer) return res.end(JSON.stringify(ok({ ...customer, orders: orders.filter((o) => o.customer.id === customer.id), payments: payments.filter((p) => p.customer.id === customer.id) })));
  }

  // Mutations succeed so the UI can be driven end to end.
  if (req.method !== 'GET') {
    let body = '';
    req.on('data', (c) => { body += c; });
    return req.on('end', () => {
      let parsed = {};
      try { parsed = JSON.parse(body || '{}'); } catch { /* form-less request */ }
      if ((m = path.match(/^\/orders\/(\w+)\/status$/))) {
        const order = orders.find((o) => o.id === m[1]);
        if (order) {
          order.status = parsed.status ?? order.status;
          if (parsed.status === 'CANCELLED') order.cancelReason = parsed.note ?? null;
          return res.end(JSON.stringify(ok(order)));
        }
      }
      res.end(JSON.stringify(ok({ id: 'new', ...parsed })));
    });
  }

  res.statusCode = 404;
  res.end(JSON.stringify({ success: false, error: `No mock for ${key}`, code: 'NOT_FOUND' }));
});

server.listen(PORT, '127.0.0.1', () => console.log(`mock api on ${PORT}`));
