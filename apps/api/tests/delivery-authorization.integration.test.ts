import { randomUUID } from 'node:crypto';
import { Readable } from 'node:stream';
import type { OrderStatus, PrismaClient, StaffRole } from '@prisma/client';
import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { ZodError } from 'zod';
import type { OrderActor } from '../src/modules/orders/orders.authorization.js';

const databaseUrl = process.env.G1_02_TEST_DATABASE_URL;
const redisUrl = process.env.G1_02_TEST_REDIS_URL;
const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aAh8AAAAASUVORK5CYII=', 'base64');

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

const storage = vi.hoisted(() => ({
  objects: new Map<string, Buffer>(),
  upload: vi.fn(async (buffer: Buffer, key: string) => { storage.objects.set(key, buffer); }),
  get: vi.fn(async (key: string) => {
    const buffer = storage.objects.get(key);
    return buffer ? { contentType: 'image/png', body: Readable.from([buffer]) } : null;
  }),
  delete: vi.fn(async (key: string) => { storage.objects.delete(key); }),
}));

vi.mock('../src/services/s3/media.js', async (importOriginal) => ({
  ...await importOriginal<typeof import('../src/services/s3/media.js')>(),
  uploadBufferToS3: storage.upload,
  getArchivedMedia: storage.get,
  deleteObject: storage.delete,
}));

const fixtureOnly = databaseUrl || redisUrl ? describe : describe.skip;
fixtureOnly('G1-02 delivery authorization with real PostgreSQL', () => {
  let prisma: PrismaClient;
  let app: FastifyInstance;
  let sign: typeof import('../src/services/auth/tokens.js').signAccessToken;
  let services: typeof import('../src/modules/shipments/shipments.service.js');
  let closeConnections: (() => Promise<unknown>) | undefined;
  let owner: OrderActor;
  let manager: OrderActor;
  let rider: OrderActor;
  let otherRider: OrderActor;
  let foreignOwner: OrderActor;
  let foreignRider: OrderActor;
  const customers = new Map<string, string>();

  beforeAll(async () => {
    for (const url of [databaseUrl, redisUrl]) {
      if (!url || new URL(url).hostname !== '127.0.0.1') {
        throw new Error('Set both G1-02 fixture URLs to disposable IPv4 loopback services');
      }
    }
    process.env.DATABASE_URL = databaseUrl!;
    process.env.REDIS_URL = redisUrl!;
    ({ prisma } = await import('../src/config/database.js'));
    await prisma.$connect();
    ({ signAccessToken: sign } = await import('../src/services/auth/tokens.js'));
    services = await import('../src/modules/shipments/shipments.service.js');
    const { disconnectRedis } = await import('../src/config/redis.js');
    const { outboundMessagesQueue } = await import('../src/queues/outbound.queue.js');
    closeConnections = async () => {
      await outboundMessagesQueue.close();
      await disconnectRedis();
    };
    const { requireAuth } = await import('../src/middleware/auth.middleware.js');
    const { attachBusinessContext } = await import('../src/middleware/business-context.middleware.js');
    const { isAppError } = await import('../src/utils/errors.js');
    const { default: orderRoutes } = await import('../src/modules/orders/orders.route.js');
    const { default: shipmentRoutes } = await import('../src/modules/shipments/shipments.route.js');
    const { default: dashboardRoutes } = await import('../src/modules/dashboard/dashboard.route.js');
    app = Fastify();
    app.setErrorHandler((error, _request, reply) => {
      if (isAppError(error)) {
        return reply.status(error.statusCode).send({ success: false, error: error.message, code: error.code });
      }
      if (error instanceof ZodError) return reply.status(400).send({ success: false, error: error.message });
      return reply.send(error);
    });
    await app.register(async (protectedApp) => {
      protectedApp.addHook('preHandler', requireAuth);
      protectedApp.addHook('preHandler', attachBusinessContext);
      await protectedApp.register(orderRoutes);
      await protectedApp.register(shipmentRoutes);
      await protectedApp.register(dashboardRoutes);
    }, { prefix: '/api/v1' });
    await app.ready();
    owner = await tenant();
    foreignOwner = await tenant();
    manager = await staff(owner, 'MANAGER', '233201000001');
    rider = await staff(owner, 'DELIVERY', '233201000002');
    otherRider = await staff(owner, 'DELIVERY', '233201000003');
    foreignRider = await staff(foreignOwner, 'DELIVERY', '233201000005');
  }, 90_000);

  beforeEach(() => {
    storage.objects.clear();
    vi.clearAllMocks();
  });

  afterAll(async () => {
    await app?.close();
    await closeConnections?.();
    await prisma?.$disconnect();
  });

  async function tenant(): Promise<OrderActor> {
    const business = await prisma.business.create({
      data: { name: 'Synthetic business', ownerName: 'Synthetic owner', plan: 'BUSINESS' },
    });
    const customer = await prisma.customer.create({
      data: { businessId: business.id, waNumber: '233201234567' },
    });
    customers.set(business.id, customer.id);
    return { businessId: business.id, staffId: null };
  }

  async function staff(owner: OrderActor, role: StaffRole, phone: string): Promise<OrderActor> {
    const { id } = await prisma.staff.create({
      data: { businessId: owner.businessId, role, phone, name: role },
    });
    return { businessId: owner.businessId, staffId: id, role };
  }

  function order(tenant: OrderActor, assignee: OrderActor | null, status: OrderStatus = 'PROCESSING') {
    return prisma.order.create({
      data: {
        businessId: tenant.businessId,
        customerId: customers.get(tenant.businessId)!,
        referenceNumber: randomUUID(),
        rawMessage: 'Private receipt for GHS 123.45',
        status,
        assignedStaffId: assignee?.staffId ?? null,
        totalAmount: 123.45,
        amountPaid: 24.56,
        deliveryAddress: 'Synthetic delivery address',
        items: { create: { description: 'Parcel', quantity: 1, unitPrice: 123.45, subtotal: 123.45 } },
      },
    });
  }

  function request(actor: OrderActor | null, method: 'GET' | 'POST' | 'PATCH', path: string, payload?: object) {
    const headers = actor ? {
      authorization: `Bearer ${sign({
        businessId: actor.businessId,
        plan: 'BUSINESS',
        ...(actor.staffId ? { staffId: actor.staffId } : {}),
        ...(actor.role ? { role: actor.role } : {}),
      }, '15m')}`,
    } : {};
    return app.inject({ method, url: `/api/v1${path}`, headers, ...(payload ? { payload } : {}) });
  }

  const proofInput = { image: png.toString('base64') };

  async function addLegacyProof(orderId: string, businessId: string) {
    const key = `dispatch/${businessId}/${orderId}-12345.png`;
    storage.objects.set(key, png);
    return prisma.shipment.create({
      data: {
        orderId, businessId, courier: 'Fixture courier', dispatchedAt: new Date(),
        proofKey: key, proofMimeType: 'image/png', proofUploadedAt: new Date(),
      },
    });
  }

  it('preserves owner, manager and assigned-rider shipment workflows', async () => {
    const target = await order(owner, rider);
    const path = `/orders/${target.id}`;
    expect((await request(owner, 'GET', `${path}/shipment`)).json().data).toEqual({ shipment: null });

    const dispatch = await request(manager, 'POST', `${path}/dispatch`, { courier: 'Bike', trackingNumber: 'T01' });
    expect(dispatch.statusCode, dispatch.body).toBe(200);
    expect(dispatch.json().data.shipment).toMatchObject({ courier: 'Bike', trackingNumber: 'T01', hasProof: false });
    expect(await prisma.order.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      status: 'DISPATCHED', assignedStaffId: rider.staffId,
    });

    const added = await request(rider, 'POST', `${path}/dispatch/proof`, proofInput);
    expect(added.statusCode, added.body).toBe(200);
    expect(added.json().data.shipment).toMatchObject({ hasProof: true });
    expect(added.json().data.shipment).not.toHaveProperty('proofKey');

    for (const actor of [owner, manager, rider]) {
      expect((await request(actor, 'GET', `${path}/shipment`)).json().data.shipment.hasProof).toBe(true);
      const proof = await request(actor, 'GET', `${path}/dispatch/proof`);
      expect(proof.statusCode, proof.body).toBe(200);
      expect(proof.rawPayload).toEqual(png);
      expect(proof.headers['cache-control']).toBe('private, no-store');
    }

    const done = await request(rider, 'POST', `${path}/dispatch/delivered`);
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json().data.shipment.deliveredAt).toBeTruthy();
    const retry = await request(owner, 'POST', `${path}/dispatch/delivered`);
    expect(retry.statusCode, retry.body).toBe(200);
    expect(retry.json().data.shipment.deliveredAt).toBe(done.json().data.shipment.deliveredAt);
    expect(await prisma.orderStatusHistory.findMany({ where: { orderId: target.id }, orderBy: { createdAt: 'asc' } }))
      .toMatchObject([{ toStatus: 'DISPATCHED', changedBy: manager.staffId }, { toStatus: 'FULFILLED', changedBy: rider.staffId }]);
  });

  it.each(['owner', 'rider'] as const)('lets the %s dispatch an eligible order', async (who) => {
    const target = await order(owner, rider);
    const response = await request(who === 'owner' ? owner : rider, 'POST', `/orders/${target.id}/dispatch`, {});
    expect(response.statusCode, response.body).toBe(200);
  });

  it('returns the same 404 for guessed, unassigned and cross-tenant IDs with zero effects', async () => {
    const target = await order(owner, rider, 'DISPATCHED');
    const pending = await order(owner, rider);
    const unassigned = await order(owner, null);
    const foreign = await order(foreignOwner, foreignRider, 'DISPATCHED');
    const evidence = await addLegacyProof(target.id, owner.businessId);
    await addLegacyProof(foreign.id, foreignOwner.businessId);
    const guessed = randomUUID();
    const attempts = [
      [otherRider, target.id], [otherRider, pending.id], [rider, unassigned.id], [foreignOwner, target.id],
      [foreignRider, target.id], [owner, foreign.id], [manager, foreign.id], [rider, foreign.id], [rider, guessed],
    ] as const;

    const endpoints = [
      ['GET', '', undefined],
      ['GET', '/shipment', undefined],
      ['GET', '/dispatch/proof', undefined],
      ['POST', '/dispatch', { courier: 'Unauthorized' }],
      ['POST', '/dispatch/proof', proofInput],
      ['POST', '/dispatch/delivered', undefined],
      ['PATCH', '/status', { status: 'FULFILLED' }],
    ] as const;
    const expected = (await request(rider, 'GET', `/orders/${guessed}`)).json();
    for (const [actor, id] of attempts) {
      for (const [method, suffix, body] of endpoints) {
        const response = await request(actor, method, `/orders/${id}${suffix}`, body);
        expect(response.statusCode, `${method} ${suffix} ${response.body}`).toBe(404);
        expect(response.json()).toEqual(expected);
      }
    }

    expect((await request(owner, 'PATCH', `/orders/${pending.id}/assign`, { staffId: foreignRider.staffId })).statusCode).toBe(404);
    expect((await request(rider, 'PATCH', `/orders/${pending.id}/status`, { status: 'CONFIRMED' })).statusCode).toBe(403);
    expect((await request(null, 'GET', `/orders/${target.id}/dispatch/proof`)).statusCode).toBe(401);
    expect(await prisma.shipment.findUniqueOrThrow({ where: { orderId: target.id } })).toEqual(evidence);
    for (const unchanged of [target, pending, unassigned, foreign]) {
      expect(await prisma.order.findUnique({ where: { id: unchanged.id } })).toEqual(unchanged);
    }
    expect(await prisma.shipment.count({ where: { orderId: { in: [pending.id, unassigned.id] } } })).toBe(0);
    expect(await prisma.orderStatusHistory.count({ where: { orderId: { in: [target.id, pending.id, unassigned.id, foreign.id] } } })).toBe(0);
    expect(storage.get).not.toHaveBeenCalled();
    expect(storage.upload).not.toHaveBeenCalled();
    expect(storage.delete).not.toHaveBeenCalled();
  });

  it('rejects direct service calls outside the assignment or tenant', async () => {
    const target = await order(owner, rider, 'DISPATCHED');
    await addLegacyProof(target.id, owner.businessId);
    for (const actor of [otherRider, foreignOwner]) {
      await expect(services.getShipmentForOrder(target.id, actor)).rejects.toMatchObject({ statusCode: 404 });
      await expect(services.getProofKey(target.id, actor)).rejects.toMatchObject({ statusCode: 404 });
      await expect(services.dispatchOrder(target.id, actor, {})).rejects.toMatchObject({ statusCode: 404 });
      await expect(services.attachProofOfDispatch(target.id, actor, proofInput.image)).rejects.toMatchObject({ statusCode: 404 });
      await expect(services.markShipmentDelivered(target.id, actor)).rejects.toMatchObject({ statusCode: 404 });
    }
    const forgedManager = { ...manager, staffId: foreignRider.staffId };
    await expect(services.markShipmentDelivered(target.id, forgedManager)).rejects.toMatchObject({ statusCode: 403 });
    expect(storage.upload).not.toHaveBeenCalled();
  });

  it('streams legacy proof but refuses an object key belonging to another tenant', async () => {
    const target = await order(owner, rider, 'DISPATCHED');
    const foreign = await order(foreignOwner, foreignRider, 'DISPATCHED');
    await addLegacyProof(target.id, owner.businessId);
    const external = await addLegacyProof(foreign.id, foreignOwner.businessId);
    const url = `/orders/${target.id}/dispatch/proof`;
    expect((await request(rider, 'GET', url)).rawPayload).toEqual(png);
    storage.get.mockClear();
    await prisma.shipment.update({ where: { orderId: target.id }, data: { proofKey: external.proofKey } });
    expect((await request(rider, 'GET', url)).statusCode).toBe(404);
    expect(storage.get).not.toHaveBeenCalled();
    expect((await request(rider, 'POST', url, proofInput)).statusCode).toBe(200);
    expect(storage.delete).not.toHaveBeenCalled();
    expect(storage.objects.has(external.proofKey!)).toBe(true);
  });

  it('scopes lists, counts and badges and omits rider financial data', async () => {
    // This test owns independent tenants so aggregate expectations do not depend on test order.
    const shop = await tenant();
    const assigned = await staff(shop, 'DELIVERY', '233202000002');
    const other = await staff(shop, 'DELIVERY', '233202000003');
    const lead = await staff(shop, 'MANAGER', '233202000004');
    const counter = await staff(shop, 'OPERATIONS', '233202000005');
    const own = await order(shop, assigned, 'PENDING');
    await order(shop, other, 'PENDING');
    await order(shop, null, 'PENDING');
    await order(foreignOwner, foreignRider, 'PENDING');
    await prisma.payment.create({
      data: {
        businessId: shop.businessId, customerId: own.customerId, orderId: own.id,
        method: 'CASH', confidence: 'GATEWAY_CONFIRMED', amount: 24.56,
      },
    });
    await prisma.payment.create({
      data: {
        businessId: foreignOwner.businessId, customerId: customers.get(foreignOwner.businessId)!, orderId: own.id,
        method: 'CASH', confidence: 'GATEWAY_CONFIRMED', amount: 999.99,
      },
    });

    const scope = `?staffId=${other.staffId}`;
    const list = await request(assigned, 'GET', `/orders${scope}`);
    expect(list.statusCode, list.body).toBe(200);
    expect(list.json().data.map((row: { id: string }) => row.id)).toEqual([own.id]);
    expect(list.json().meta.pagination.total).toBe(1);
    expect((await request(assigned, 'GET', `/orders/counts${scope}`)).json().data).toMatchObject({ ALL: 1, PENDING: 1 });
    expect((await request(assigned, 'GET', '/dashboard/badges')).json().data.pendingOrders).toBe(1);
    for (const row of [list.json().data[0], (await request(assigned, 'GET', `/orders/${own.id}`)).json().data]) {
      expect(row.deliveryAddress).toBe('Synthetic delivery address');
      for (const key of ['totalAmount', 'amountPaid', 'payments', 'rawMessage']) expect(row).not.toHaveProperty(key);
      expect(row.items[0]).not.toHaveProperty('unitPrice');
      expect(row.items[0]).not.toHaveProperty('subtotal');
    }

    const stats = '/orders/stats?period=week';
    expect((await request(assigned, 'GET', stats)).json().data).toEqual({ totalOrders: 1, byStatus: { PENDING: 1 } });
    expect((await request(counter, 'GET', stats)).json().data).toEqual({ totalOrders: 3, byStatus: { PENDING: 3 } });
    for (const actor of [shop, lead]) {
      const result = (await request(actor, 'GET', stats)).json().data;
      expect(result).toMatchObject({ totalOrders: 3, totalPaid: 24.56 });
      expect(result.totalRevenue).toBeCloseTo(370.35);
      expect(result.pendingAmount).toBeCloseTo(345.79);
      expect((await request(actor, 'GET', `/orders/${own.id}`)).json().data.payments).toHaveLength(1);
      const shopList = (await request(actor, 'GET', '/orders')).json().data;
      expect(shopList.find((row: { id: string }) => row.id === own.id).payments).toHaveLength(1);
    }
    expect((await request(assigned, 'GET', '/reports')).statusCode).toBe(403);
  });

  it.each([
    ['POST', '/dispatch', 'PROCESSING', {}],
    ['POST', '/dispatch/delivered', 'DISPATCHED', undefined],
    ['PATCH', '/status', 'DISPATCHED', { status: 'FULFILLED' }],
  ] as const)('rechecks a rider waiting on reassignment before %s %s', async (method, suffix, status, body) => {
    const target = await order(owner, rider, status);
    if (status === 'DISPATCHED') await addLegacyProof(target.id, owner.businessId);
    const { promise: reassigned, resolve: signalReassignment } = deferred<number>();
    const { promise: commit, resolve: release } = deferred<void>();
    const managerTransaction = prisma.$transaction(async (tx) => {
      const [{ pid }] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      await tx.order.update({ where: { id: target.id }, data: { assignedStaffId: otherRider.staffId } });
      signalReassignment(pid);
      await commit;
    }, { timeout: 10_000 });

    const pid = await reassigned;
    const pending = request(rider, method, `/orders/${target.id}${suffix}`, body);
    try {
      await vi.waitFor(async () => {
        const [{ blocked }] = await prisma.$queryRaw<Array<{ blocked: boolean }>>`
          SELECT EXISTS (SELECT 1 FROM pg_stat_activity WHERE ${pid} = ANY(pg_blocking_pids(pid))
            AND query LIKE '%SELECT id FROM orders%') AS blocked
        `;
        expect(blocked).toBe(true);
      }, { timeout: 3000 });
    } finally {
      release();
      await managerTransaction;
      await pending;
    }

    const denied = await pending;
    expect(denied.statusCode, denied.body).toBe(404);
    expect(await prisma.order.findUniqueOrThrow({ where: { id: target.id } })).toMatchObject({
      assignedStaffId: otherRider.staffId, status,
    });
    expect(await prisma.orderStatusHistory.count({ where: { orderId: target.id } })).toBe(0);
    const shipment = await prisma.shipment.findUnique({ where: { orderId: target.id } });
    expect(shipment?.deliveredAt ?? null).toBeNull();
    if (status === 'PROCESSING') expect(shipment).toBeNull();
  });

  it('discards a staged proof if the order is reassigned during the upload', async () => {
    const target = await order(owner, rider, 'DISPATCHED');
    const existing = await addLegacyProof(target.id, owner.businessId);
    const { promise: staged, resolve: signalStage } = deferred<string>();
    const { promise: resume, resolve: release } = deferred<void>();
    storage.upload.mockImplementationOnce(async (buffer, key) => {
      storage.objects.set(key, buffer);
      signalStage(key);
      await resume;
    });

    const path = `/orders/${target.id}`;
    const pending = request(rider, 'POST', `${path}/dispatch/proof`, proofInput);
    const stagedKey = await Promise.race([
      staged,
      pending.then((response) => { throw new Error(`Upload ended before staging: ${response.body}`); }),
    ]);
    try {
      const assignment = await request(manager, 'PATCH', `${path}/assign`, { staffId: otherRider.staffId });
      expect(assignment.statusCode, assignment.body).toBe(200);
    } finally {
      release();
      await pending;
    }
    expect((await pending).statusCode).toBe(404);
    expect(await prisma.shipment.findUniqueOrThrow({ where: { orderId: target.id } })).toEqual(existing);
    expect(storage.delete).toHaveBeenCalledTimes(1);
    expect(storage.delete).toHaveBeenCalledWith(stagedKey);
    expect(storage.objects.has(stagedKey)).toBe(false);
    expect((await request(rider, 'GET', `${path}/dispatch/proof`)).statusCode).toBe(404);
    expect((await request(otherRider, 'GET', `${path}/dispatch/proof`)).rawPayload).toEqual(png);
  });

  it('keeps the status unchanged when a shipment cannot be written', async () => {
    const target = await order(owner, rider);
    const wrongShipment = await addLegacyProof(target.id, foreignOwner.businessId);
    const response = await request(rider, 'POST', `/orders/${target.id}/dispatch`, {});
    expect(response.statusCode, response.body).toBe(404);
    expect(await prisma.order.findUnique({ where: { id: target.id } })).toEqual(target);
    expect(await prisma.shipment.findUnique({ where: { orderId: target.id } })).toEqual(wrongShipment);
    expect(await prisma.orderStatusHistory.count({ where: { orderId: target.id } })).toBe(0);
  });
});
