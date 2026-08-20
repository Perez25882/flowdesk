import jwt from 'jsonwebtoken';
import type { FastifyRequest } from 'fastify';
import { env } from '../../config/env.js';
import type { BusinessPlan, StaffRole } from '../../types/prisma-enums.js';

/**
 * Token minting and verification.
 *
 * Access and refresh tokens used to be structurally identical: neither carried
 * a type, an issuer or an audience, and `requireAuth` verified with no options
 * at all. `role.middleware.ts` reads the ABSENCE of a staff id as "this is the
 * owner", and a refresh token's payload has no staff id — so if JWT_SECRET and
 * JWT_REFRESH_SECRET were ever set to the same value (a copy-paste away in a
 * deployment config), any staff member could present their own refresh token as
 * a bearer token and be served as the business owner.
 *
 * Every token now carries `typ`, `iss` and `aud`, and each side asserts them.
 * That makes the two kinds non-interchangeable regardless of what the secrets
 * are set to.
 */

export const JWT_ISSUER = 'flowdesk';
export const JWT_AUDIENCE = 'flowdesk-api';

export const ACCESS_TOKEN_TYPE = 'access';
export const REFRESH_TOKEN_TYPE = 'refresh';

const SIGN_ALGORITHM = 'HS256' as const;
const VERIFY_ALGORITHMS = [SIGN_ALGORITHM];

/**
 * Whatever `jsonwebtoken` currently accepts for `expiresIn`.
 *
 * @types/jsonwebtoken v9 narrowed this from `string` to a template-literal type
 * from `ms` ("15m", "30d", a number of seconds). Deriving it from SignOptions
 * rather than restating it means a future bump to that type cannot silently
 * turn a valid lifetime into a compile error here.
 */
type TokenLifetime = NonNullable<jwt.SignOptions['expiresIn']>;

export interface AccessTokenClaims {
  businessId: string;
  plan: BusinessPlan;
  staffId?: string;
  role?: StaffRole;
  /** Issued-at, epoch seconds. Set by jwt.sign; compared against the revocation epoch. */
  iat?: number;
}

export interface RefreshTokenClaims {
  businessId: string;
  jti: string;
  iat?: number;
}

interface RawClaims extends Record<string, unknown> {
  typ?: unknown;
  businessId?: unknown;
  plan?: unknown;
  staffId?: unknown;
  role?: unknown;
  jti?: unknown;
  iat?: unknown;
}

/**
 * Verifies signature, algorithm and — for tokens minted after the rollover —
 * issuer and audience.
 *
 * Rollover: tokens issued before this change carry no `typ`, `iss` or `aud`.
 * Verifying with the `issuer`/`audience` options rejects a token that lacks
 * those claims, so applying them unconditionally would invalidate every live
 * session at deploy — including refresh tokens, which live thirty days. So the
 * strict options are applied only to tokens that actually carry a `typ`, and a
 * typ-less token falls through to `isLegacy*` below, which discriminates the
 * two kinds structurally instead. The unverified peek at `typ` can only make
 * verification STRICTER (omitting `typ` buys an attacker the structural check,
 * not a free pass), so reading it before the signature check is safe.
 *
 * The legacy branch can be deleted thirty days after this ships, once every
 * pre-rollover refresh token has expired. Access tokens live fifteen minutes,
 * so their legacy window closes almost immediately.
 */
function verify(token: string, secret: string): RawClaims | null {
  let carriesType = false;

  try {
    const peeked = jwt.decode(token) as RawClaims | null;
    carriesType = typeof peeked?.typ === 'string';
  } catch {
    return null;
  }

  const options: jwt.VerifyOptions = carriesType
    ? { algorithms: VERIFY_ALGORITHMS, issuer: JWT_ISSUER, audience: JWT_AUDIENCE }
    : { algorithms: VERIFY_ALGORITHMS };

  try {
    return jwt.verify(token, secret, options) as RawClaims;
  } catch {
    return null;
  }
}

/**
 * A pre-rollover access token: it carries the plan the token was minted with
 * and no `jti`. A refresh token is the mirror image — `jti` and no plan — so
 * this rejects one presented as the other even while `typ` is still absent.
 */
function isLegacyAccessShape(claims: RawClaims): boolean {
  return typeof claims.plan === 'string' && claims.jti === undefined;
}

function isLegacyRefreshShape(claims: RawClaims): boolean {
  return typeof claims.jti === 'string' && claims.plan === undefined;
}

export function signAccessToken(
  claims: Omit<AccessTokenClaims, 'iat'>,
  expiresIn: TokenLifetime,
): string {
  return jwt.sign({ ...claims, typ: ACCESS_TOKEN_TYPE }, env.JWT_SECRET, {
    algorithm: SIGN_ALGORITHM,
    expiresIn,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

export function signRefreshToken(
  claims: Omit<RefreshTokenClaims, 'iat'>,
  expiresIn: TokenLifetime,
): string {
  return jwt.sign({ ...claims, typ: REFRESH_TOKEN_TYPE }, env.JWT_REFRESH_SECRET, {
    algorithm: SIGN_ALGORITHM,
    expiresIn,
    issuer: JWT_ISSUER,
    audience: JWT_AUDIENCE,
  });
}

/** Returns the claims of a valid access token, or null for anything else. */
export function verifyAccessToken(token: string): AccessTokenClaims | null {
  const claims = verify(token, env.JWT_SECRET);

  if (!claims || typeof claims.businessId !== 'string') {
    return null;
  }

  if (claims.typ === undefined ? !isLegacyAccessShape(claims) : claims.typ !== ACCESS_TOKEN_TYPE) {
    return null;
  }

  const result: AccessTokenClaims = {
    businessId: claims.businessId,
    plan: claims.plan as BusinessPlan,
  };
  if (typeof claims.staffId === 'string') result.staffId = claims.staffId;
  if (typeof claims.role === 'string') result.role = claims.role as StaffRole;
  if (typeof claims.iat === 'number') result.iat = claims.iat;

  return result;
}

export function extractBearerToken(header: string | undefined): string | null {
  if (!header || !header.startsWith('Bearer ')) {
    return null;
  }
  return header.slice(7).trim();
}

/**
 * Per-request memo of the verified access-token claims.
 *
 * The rate limiter runs at `onRequest` and `requireAuth` at `preHandler`, so
 * both need the caller's identity and neither can hand it to the other through
 * `request.user`. A WeakMap rather than a property on the request keeps the
 * memo out of the public `FastifyRequest` type (which is declared in
 * `types/fastify.d.ts`) and lets it be collected with the request object.
 */
const claimsCache = new WeakMap<FastifyRequest, AccessTokenClaims | null>();

/**
 * The verified claims of the request's bearer token, or null when there is no
 * token or it does not verify. Verifies at most once per request.
 */
export function readAccessTokenClaims(request: FastifyRequest): AccessTokenClaims | null {
  const cached = claimsCache.get(request);
  if (cached !== undefined) {
    return cached;
  }

  const token = extractBearerToken(request.headers.authorization);
  const claims = token ? verifyAccessToken(token) : null;

  claimsCache.set(request, claims);
  return claims;
}

/** Returns the claims of a valid refresh token, or null for anything else. */
export function verifyRefreshToken(token: string): RefreshTokenClaims | null {
  const claims = verify(token, env.JWT_REFRESH_SECRET);

  if (!claims || typeof claims.businessId !== 'string') {
    return null;
  }

  if (
    claims.typ === undefined ? !isLegacyRefreshShape(claims) : claims.typ !== REFRESH_TOKEN_TYPE
  ) {
    return null;
  }

  const result: RefreshTokenClaims = {
    businessId: claims.businessId,
    jti: typeof claims.jti === 'string' ? claims.jti : '',
  };
  if (typeof claims.iat === 'number') result.iat = claims.iat;

  return result;
}
