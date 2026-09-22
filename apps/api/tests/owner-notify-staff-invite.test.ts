import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Staff invites were enqueued as free-form WhatsApp text to a number that, by
 * definition, has never messaged the shop. Meta rejects that with 131047,
 * `meta-errors.ts` marks it non-retryable, and the job dead-letters — so the
 * link never arrived and the Staff page showed "Invited" forever.
 *
 * These tests pin the replacement: WhatsApp is attempted only when the window
 * is genuinely open, email is attempted only when it is genuinely configured,
 * the link always comes back, and nothing about delivery can fail the invite.
 *
 * (Named with the `owner-notify-` prefix to match this change's file-ownership
 * convention; the subject is the staff invite path.)
 */

const mocks = vi.hoisted(() => ({
  features: { email: true },
  businessFindUnique: vi.fn(),
  customerFindFirst: vi.fn(),
  enqueueOutboundMessage: vi.fn(),
  sendStaffInviteEmail: vi.fn(),
  findStaffByPhone: vi.fn(),
  listStaff: vi.fn(),
  createStaffInvite: vi.fn(),
  checkStaffLimit: vi.fn(),
}));

vi.mock('../src/config/database.js', () => ({
  prisma: {
    business: { findUnique: mocks.businessFindUnique },
    customer: { findFirst: mocks.customerFindFirst },
  },
}));

vi.mock('../src/config/env.js', () => ({
  env: { FRONTEND_URL: 'https://app.flowdesk.test' },
  features: mocks.features,
}));

vi.mock('../src/config/logger.js', () => ({
  logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
}));

vi.mock('../src/queues/outbound.queue.js', () => ({
  enqueueOutboundMessage: mocks.enqueueOutboundMessage,
}));

vi.mock('../src/services/email/transactional.js', () => ({
  sendStaffInviteEmail: mocks.sendStaffInviteEmail,
}));

vi.mock('../src/modules/staff/staff.repository.js', () => ({
  findStaffByPhone: mocks.findStaffByPhone,
  listStaff: mocks.listStaff,
  createStaffInvite: mocks.createStaffInvite,
}));

vi.mock('../src/services/plan/plan.service.js', () => ({
  checkStaffLimit: mocks.checkStaffLimit,
}));

vi.mock('../src/modules/auth/auth.repository.js', () => ({ findBusinessById: vi.fn() }));
vi.mock('../src/modules/auth/auth.service.js', () => ({ issueTokens: vi.fn() }));
vi.mock('../src/services/auth/revocation.js', () => ({
  revokeTokensFor: vi.fn(),
  staffSubject: vi.fn(),
}));
vi.mock('../src/services/auth/login-throttle.js', () => ({
  clearFailedLogins: vi.fn(),
  isLoginLocked: vi.fn(),
  MAX_FAILED_ATTEMPTS: 5,
  recordFailedLogin: vi.fn(),
}));

const { inviteStaff } = await import('../src/modules/staff/staff.service.js');

const BUSINESS_ID = 'biz_1';
const INPUT = { name: 'Adjoa Baidoo', phone: '0244123456', role: 'OPERATIONS' as const };

/** The token `inviteStaff` minted, as handed to the repository. */
function mintedToken(): string {
  return mocks.createStaffInvite.mock.calls[0]![2] as string;
}

beforeEach(() => {
  vi.clearAllMocks();
  mocks.features.email = true;

  mocks.findStaffByPhone.mockResolvedValue(null);
  mocks.listStaff.mockResolvedValue([]);
  mocks.checkStaffLimit.mockResolvedValue({ allowed: true, limit: 5 });
  mocks.createStaffInvite.mockImplementation(async () => ({
    id: 'staff_1',
    businessId: BUSINESS_ID,
    name: INPUT.name,
    phone: '233244123456',
    role: INPUT.role,
    active: true,
    inviteAcceptedAt: null,
    lastLoginAt: null,
    createdAt: new Date(),
  }));
  mocks.businessFindUnique.mockResolvedValue({ email: 'owner@amaprovisions.test' });
  // No customer row for the new hire's number: the 24-hour window is shut.
  mocks.customerFindFirst.mockResolvedValue(null);
  mocks.sendStaffInviteEmail.mockResolvedValue(true);
  mocks.enqueueOutboundMessage.mockResolvedValue(undefined);
});

describe('the invite link', () => {
  it('always comes back, whatever happened to the other channels', async () => {
    mocks.features.email = false;

    const result = await inviteStaff(INPUT, BUSINESS_ID, 'Ama Provisions');

    expect(result.inviteUrl).toBe(
      `https://app.flowdesk.test/staff/accept?token=${mintedToken()}`,
    );
    expect(result.deliveredVia).toEqual([]);
  });

  it('keeps every field the staff response already carried', async () => {
    const result = await inviteStaff(INPUT, BUSINESS_ID, 'Ama Provisions');

    expect(result.id).toBe('staff_1');
    expect(result.name).toBe(INPUT.name);
    expect(result.role).toBe('OPERATIONS');
    expect(result.inviteAcceptedAt).toBeNull();
  });
});

describe('email delivery', () => {
  it('emails the link to the business address and reports it', async () => {
    const result = await inviteStaff(INPUT, BUSINESS_ID, 'Ama Provisions');

    expect(mocks.sendStaffInviteEmail).toHaveBeenCalledWith(
      'owner@amaprovisions.test',
      'Ama Provisions',
      mintedToken(),
      INPUT.name,
    );
    expect(result.deliveredVia).toContain('email');
  });

  it('does not claim an email when email is unconfigured for the deployment', async () => {
    mocks.features.email = false;

    const result = await inviteStaff(INPUT, BUSINESS_ID, 'Ama Provisions');

    expect(mocks.sendStaffInviteEmail).not.toHaveBeenCalled();
    expect(result.deliveredVia).not.toContain('email');
  });

  it('does not claim an email when the business recorded no address', async () => {
    mocks.businessFindUnique.mockResolvedValue({ email: null });

    const result = await inviteStaff(INPUT, BUSINESS_ID, 'Ama Provisions');

    expect(mocks.sendStaffInviteEmail).not.toHaveBeenCalled();
    expect(result.deliveredVia).not.toContain('email');
  });

  it('does not claim an email the provider rejected', async () => {
    mocks.sendStaffInviteEmail.mockResolvedValue(false);

    const result = await inviteStaff(INPUT, BUSINESS_ID, 'Ama Provisions');

    expect(result.deliveredVia).not.toContain('email');
  });
});

describe('WhatsApp delivery', () => {
  it('does not send free-form into a closed 24-hour window', async () => {
    const result = await inviteStaff(INPUT, BUSINESS_ID, 'Ama Provisions');

    expect(mocks.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(result.deliveredVia).not.toContain('whatsapp');
  });

  it('treats a window that closed over 24 hours ago as closed', async () => {
    mocks.customerFindFirst.mockResolvedValue({
      lastInboundAt: new Date(Date.now() - 25 * 60 * 60 * 1000),
    });

    const result = await inviteStaff(INPUT, BUSINESS_ID, 'Ama Provisions');

    expect(mocks.enqueueOutboundMessage).not.toHaveBeenCalled();
    expect(result.deliveredVia).not.toContain('whatsapp');
  });

  it('sends when the number has messaged the shop inside the window', async () => {
    mocks.customerFindFirst.mockResolvedValue({ lastInboundAt: new Date(Date.now() - 60_000) });

    const result = await inviteStaff(INPUT, BUSINESS_ID, 'Ama Provisions');

    expect(mocks.enqueueOutboundMessage).toHaveBeenCalledTimes(1);
    const job = mocks.enqueueOutboundMessage.mock.calls[0]![0] as { to: string; body: string };
    expect(job.to).toBe('233244123456');
    expect(job.body).toContain(result.inviteUrl);
    expect(result.deliveredVia).toContain('whatsapp');
  });
});

describe('delivery failure is never fatal', () => {
  it('still creates the staff record when the queue is unreachable', async () => {
    mocks.customerFindFirst.mockResolvedValue({ lastInboundAt: new Date() });
    mocks.enqueueOutboundMessage.mockRejectedValue(new Error('redis is down'));

    const result = await inviteStaff(INPUT, BUSINESS_ID, 'Ama Provisions');

    expect(mocks.createStaffInvite).toHaveBeenCalledTimes(1);
    expect(result.id).toBe('staff_1');
    expect(result.deliveredVia).not.toContain('whatsapp');
    expect(result.inviteUrl).toContain(mintedToken());
  });

  it('still creates the staff record when the email lookup throws', async () => {
    mocks.businessFindUnique.mockRejectedValue(new Error('connection terminated'));

    const result = await inviteStaff(INPUT, BUSINESS_ID, 'Ama Provisions');

    expect(result.id).toBe('staff_1');
    expect(result.deliveredVia).toEqual([]);
  });
});
