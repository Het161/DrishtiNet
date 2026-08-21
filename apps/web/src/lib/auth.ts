import 'server-only';

import { scryptSync, timingSafeEqual } from 'node:crypto';
import { cookies } from 'next/headers';
import { SignJWT, jwtVerify } from 'jose';

import { prisma } from '@drishtinet/db';
import { ROLE_PERMISSIONS, type Permission, type Role } from '@drishtinet/shared/rbac';

/**
 * Minimal session auth.
 *
 * It exists because of the drag-to-place tool. Setting a camera's position to `verified` writes an
 * `audit_log` row, and an audit row whose actor is "unknown" is worthless — the whole point of the
 * verified tier is that a named person stood behind that coordinate. So placement requires a
 * logged-in user with `camera:write`, and the audit trail records who.
 *
 * Deliberately small: a signed JWT in an httpOnly cookie, no session table, no refresh tokens.
 * This is a single-laptop offline deployment for a hackathon demo, not a multi-tenant service, and
 * a larger auth stack would be surface area without benefit. The RBAC model it enforces
 * (packages/shared/src/rbac.ts) is the part that has to be right.
 */

const COOKIE = 'drishti_session';
const ALG = 'HS256';

function secret(): Uint8Array {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) {
    // Failing loudly beats signing sessions with a weak or default key.
    throw new Error('AUTH_SECRET must be set to at least 32 characters (see .env.example)');
  }
  return new TextEncoder().encode(value);
}

export interface Session {
  userId: string;
  username: string;
  displayName: string;
  role: Role;
  departmentId: string | null;
}

/** Verify a password against a `scrypt$salt$hash` record, in constant time. */
export function verifyPassword(plain: string, stored: string): boolean {
  const [scheme, salt, expected] = stored.split('$');
  if (scheme !== 'scrypt' || !salt || !expected) return false;
  const actual = scryptSync(plain, salt, 64).toString('hex');
  const a = Buffer.from(actual, 'hex');
  const b = Buffer.from(expected, 'hex');
  // timingSafeEqual throws on a length mismatch, which would itself leak information.
  return a.length === b.length && timingSafeEqual(a, b);
}

export async function login(username: string, password: string): Promise<Session | null> {
  const user = await prisma.user.findUnique({ where: { username } });
  // Compare against a dummy hash when the user is absent, so a missing username and a wrong
  // password take the same time.
  const stored = user?.passwordHash ?? `scrypt$${'0'.repeat(32)}$${'0'.repeat(128)}`;
  const ok = verifyPassword(password, stored);
  if (!user || !user.active || !ok) return null;

  const session: Session = {
    userId: user.id,
    username: user.username,
    displayName: user.displayName,
    role: user.role,
    departmentId: user.departmentId,
  };

  const ttlHours = Number(process.env.AUTH_SESSION_TTL_HOURS ?? 12);
  const token = await new SignJWT({ ...session })
    .setProtectedHeader({ alg: ALG })
    .setIssuedAt()
    .setExpirationTime(`${ttlHours}h`)
    .sign(secret());

  (await cookies()).set(COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    // The venue runs over plain HTTP on localhost; requiring Secure would silently drop the cookie.
    secure: process.env.NODE_ENV === 'production' && process.env.HTTPS === 'true',
    path: '/',
    maxAge: ttlHours * 3600,
  });
  return session;
}

export async function logout(): Promise<void> {
  (await cookies()).delete(COOKIE);
}

export async function getSession(): Promise<Session | null> {
  const token = (await cookies()).get(COOKIE)?.value;
  if (!token) return null;
  try {
    const { payload } = await jwtVerify(token, secret(), { algorithms: [ALG] });
    return {
      userId: String(payload.userId),
      username: String(payload.username),
      displayName: String(payload.displayName),
      role: payload.role as Role,
      departmentId: (payload.departmentId as string | null) ?? null,
    };
  } catch {
    // Expired or tampered — treat as logged out rather than erroring.
    return null;
  }
}

export function can(session: Session | null, permission: Permission): boolean {
  if (!session) return false;
  return ROLE_PERMISSIONS[session.role]?.includes(permission) ?? false;
}

/** Throwing guard for server actions. */
export async function requirePermission(permission: Permission): Promise<Session> {
  const session = await getSession();
  if (!can(session, permission)) {
    throw new Error(`not permitted: ${permission}`);
  }
  return session!;
}
