import type { WhatsAppConnectionState } from '@prisma/client';

/**
 * Interpretation of Meta Cloud API failures.
 *
 * Every failure previously collapsed into a generic thrown Error, so a revoked
 * token, a temporary throttle and a permanently unreachable customer were
 * indistinguishable — and therefore all handled wrongly. Classifying them is
 * what lets the platform retry the transient ones, stop hammering Meta on the
 * permanent ones, and tell the right owner to reconnect.
 *
 * Reference: developers.facebook.com/docs/whatsapp/cloud-api/support/error-codes
 */

export type MetaFailureKind =
  /** Token expired or revoked. Owner must reconnect; retrying cannot help. */
  | 'TOKEN_INVALID'
  /** Number deleted, banned, or not registered. Owner action required. */
  | 'NUMBER_UNAVAILABLE'
  /** Throttled. Retry later with backoff. */
  | 'RATE_LIMITED'
  /** Outside the 24h window — a free-form message is not permitted. */
  | 'REENGAGEMENT_REQUIRED'
  /** This recipient cannot be reached (not on WhatsApp, blocked us). */
  | 'RECIPIENT_UNAVAILABLE'
  /**
   * The approved template this send needed is missing, paused or does not match
   * what was sent. Permanent until an operator fixes it in Meta Business
   * Manager — a template does not appear part-way through a retry budget.
   */
  | 'TEMPLATE_UNAVAILABLE'
  /** Meta-side fault or network problem. Retry. */
  | 'TRANSIENT'
  /** Anything unrecognised. Treated as transient but surfaced for review. */
  | 'UNKNOWN';

export interface MetaFailure {
  kind: MetaFailureKind;
  /** Meta's numeric code, when present. */
  code: number | null;
  message: string;
  httpStatus: number;
  /** Whether retrying the same request could plausibly succeed. */
  retryable: boolean;
  /** Connection state this failure implies, if it is a connection problem. */
  connectionState: WhatsAppConnectionState | null;
}

/** Auth failures — the token no longer represents the business. */
const TOKEN_CODES = new Set([190, 102, 463, 467, 2500]);
/** The number itself is unusable. */
const NUMBER_CODES = new Set([133000, 133004, 133005, 133006, 133008, 133009, 133010, 133016]);
const RATE_LIMIT_CODES = new Set([4, 80007, 130429, 131048, 131056]);
/** Outside the customer service window. */
const REENGAGEMENT_CODES = new Set([131047, 131051]);
const RECIPIENT_CODES = new Set([131026, 131052, 131053]);
/**
 * Template problems. 132001 — "template does not exist in this language or has
 * not been approved" — is the one that matters in practice: templates are
 * created and approved per WhatsApp Business Account, so every newly onboarded
 * tenant hits it until an operator creates them. Retrying cannot help, and the
 * old classification (UNKNOWN, therefore retryable) spent five attempts and
 * fifteen minutes of backoff before admitting it.
 */
const TEMPLATE_CODES = new Set([132001, 132005, 132007, 132012, 132015, 132016]);
/** Meta-side faults. */
const TRANSIENT_CODES = new Set([1, 2, 131000, 131016, 131021, 132000]);

interface MetaErrorBody {
  error?: {
    code?: number;
    message?: string;
    error_subcode?: number;
    error_data?: { details?: string };
  };
}

function parseBody(raw: string): MetaErrorBody | null {
  try {
    return JSON.parse(raw) as MetaErrorBody;
  } catch {
    return null;
  }
}

function classifyCode(code: number | null, httpStatus: number): MetaFailureKind {
  if (code !== null) {
    if (TOKEN_CODES.has(code)) return 'TOKEN_INVALID';
    if (NUMBER_CODES.has(code)) return 'NUMBER_UNAVAILABLE';
    if (RATE_LIMIT_CODES.has(code)) return 'RATE_LIMITED';
    if (REENGAGEMENT_CODES.has(code)) return 'REENGAGEMENT_REQUIRED';
    if (RECIPIENT_CODES.has(code)) return 'RECIPIENT_UNAVAILABLE';
    if (TEMPLATE_CODES.has(code)) return 'TEMPLATE_UNAVAILABLE';
    if (TRANSIENT_CODES.has(code)) return 'TRANSIENT';
  }

  // Fall back to HTTP semantics when the code is absent or unrecognised.
  if (httpStatus === 401 || httpStatus === 403) return 'TOKEN_INVALID';
  if (httpStatus === 429) return 'RATE_LIMITED';
  if (httpStatus >= 500) return 'TRANSIENT';

  return 'UNKNOWN';
}

const RETRYABLE: ReadonlySet<MetaFailureKind> = new Set<MetaFailureKind>([
  'RATE_LIMITED',
  'TRANSIENT',
  'UNKNOWN',
]);

const CONNECTION_STATE: Partial<Record<MetaFailureKind, WhatsAppConnectionState>> = {
  TOKEN_INVALID: 'TOKEN_INVALID',
  NUMBER_UNAVAILABLE: 'NUMBER_UNAVAILABLE',
  RATE_LIMITED: 'RATE_LIMITED',
};

export function classifyMetaError(httpStatus: number, rawBody: string): MetaFailure {
  const parsed = parseBody(rawBody);
  const code = parsed?.error?.code ?? null;
  const kind = classifyCode(code, httpStatus);

  return {
    kind,
    code,
    message: parsed?.error?.message ?? rawBody.slice(0, 300),
    httpStatus,
    retryable: RETRYABLE.has(kind),
    connectionState: CONNECTION_STATE[kind] ?? null,
  };
}

/** Error thrown by the WhatsApp client, carrying the classification. */
export class WhatsAppSendError extends Error {
  readonly failure: MetaFailure;
  readonly businessId: string;

  constructor(businessId: string, failure: MetaFailure) {
    super(`WhatsApp send failed (${failure.kind}): ${failure.message}`);
    this.name = 'WhatsAppSendError';
    this.businessId = businessId;
    this.failure = failure;
  }
}

/** Owner-facing explanation of why their WhatsApp is not working. */
export function describeForOwner(kind: MetaFailureKind): string {
  switch (kind) {
    case 'TOKEN_INVALID':
      return 'Your WhatsApp connection has expired. Reconnect your number in Settings to resume automatic replies.';
    case 'NUMBER_UNAVAILABLE':
      return 'Your WhatsApp number is no longer available. Check its status in Meta Business Manager.';
    case 'RATE_LIMITED':
      return 'WhatsApp is temporarily limiting messages from your number. Sending will resume automatically.';
    case 'REENGAGEMENT_REQUIRED':
      return 'This customer last messaged over 24 hours ago, so WhatsApp only allows an approved template message.';
    case 'RECIPIENT_UNAVAILABLE':
      return 'This customer could not be reached on WhatsApp.';
    case 'TEMPLATE_UNAVAILABLE':
      return 'This message needed an approved WhatsApp template, because the customer last messaged over 24 hours ago, and that template is not approved on your WhatsApp account yet. It has to be created and approved in Meta Business Manager before these messages can go out.';
    default:
      return 'WhatsApp reported a temporary problem. We will keep retrying.';
  }
}
