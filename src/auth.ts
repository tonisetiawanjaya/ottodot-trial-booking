import { randomBytes, randomUUID, scryptSync, timingSafeEqual } from 'node:crypto';
import type { DB } from './db.ts';
import { AppError, notFound } from './errors.ts';
import type { Parent, Student } from './booking-service.ts';

/**
 * Username/password login with server-side sessions. No dependencies:
 * scrypt from node:crypto for password hashing, an HttpOnly cookie carrying an
 * opaque session id, and two ownership checks the HTTP layer calls before it
 * lets a parent touch a child or a booking.
 */

export type Role = 'parent' | 'admin';

export interface Account {
  id: string;
  username: string;
  password_hash: string;
  role: Role;
  parent_id: string | null;
  created_at: string;
}

export interface Session {
  id: string;
  account_id: string;
  created_at: string;
  expires_at: string;
}

/** Who is making the request. Sent to the browser by GET /api/auth/me (minus nothing secret: no hash, no session id). */
export interface Principal {
  account_id: string;
  username: string;
  role: Role;
  parent_id: string | null;
  parent: Parent | null;
  students: Student[];
}

const KEYLEN = 64;

/** scrypt with a random per-user salt, stored as `scrypt$<salt>$<hash>`. */
export function hashPassword(password: string, salt: string = randomBytes(16).toString('hex')): string {
  return `scrypt$${salt}$${scryptSync(password, salt, KEYLEN).toString('hex')}`;
}

export function verifyPassword(password: string, stored: string): boolean {
  const [algo, salt, hex] = stored.split('$');
  if (algo !== 'scrypt' || !salt || !hex) return false;
  const expected = Buffer.from(hex, 'hex');
  const actual = scryptSync(password, salt, KEYLEN);
  return expected.length === actual.length && timingSafeEqual(actual, expected);
}

// Verified against when the username does not exist, so "unknown user" and
// "wrong password" take the same time and return the same error.
const DUMMY_HASH = hashPassword('not-a-real-password');

export interface AuthOptions {
  now?: () => Date;
  sessionTtlDays?: number;
}

export class AuthService {
  private readonly db: DB;
  private readonly now: () => Date;
  private readonly ttlMs: number;

  constructor(db: DB, opts: AuthOptions = {}) {
    this.db = db;
    this.now = opts.now ?? (() => new Date());
    this.ttlMs = (opts.sessionTtlDays ?? 7) * 24 * 60 * 60_000;
  }

  login(username: string, password: string): { session: Session; principal: Principal } {
    const account = this.db
      .prepare('SELECT * FROM accounts WHERE username = ?')
      .get(username.trim().toLowerCase()) as unknown as Account | undefined;
    const ok = verifyPassword(password, account?.password_hash ?? DUMMY_HASH);
    if (!account || !ok) throw new AppError(401, 'INVALID_CREDENTIALS', 'Wrong username or password');

    const now = this.now();
    const session: Session = {
      id: randomUUID(),
      account_id: account.id,
      created_at: now.toISOString(),
      expires_at: new Date(now.getTime() + this.ttlMs).toISOString(),
    };
    this.db
      .prepare('INSERT INTO sessions (id, account_id, created_at, expires_at) VALUES (?, ?, ?, ?)')
      .run(session.id, session.account_id, session.created_at, session.expires_at);
    return { session, principal: this.principalFor(account) };
  }

  logout(sessionId: string): void {
    this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
  }

  /** Resolve a session id to a principal; null when missing, unknown, or expired. */
  principalForSession(sessionId: string | undefined): Principal | null {
    if (!sessionId) return null;
    const row = this.db
      .prepare('SELECT a.*, s.expires_at AS session_expires_at FROM sessions s JOIN accounts a ON a.id = s.account_id WHERE s.id = ?')
      .get(sessionId) as unknown as (Account & { session_expires_at: string }) | undefined;
    if (!row) return null;
    if (row.session_expires_at <= this.now().toISOString()) {
      this.logout(sessionId);
      return null;
    }
    return this.principalFor(row);
  }

  requireUser(sessionId: string | undefined): Principal {
    const principal = this.principalForSession(sessionId);
    if (!principal) throw new AppError(401, 'UNAUTHENTICATED', 'Please log in');
    return principal;
  }

  requireParent(sessionId: string | undefined): Principal & { parent_id: string } {
    const principal = this.requireUser(sessionId);
    if (principal.role !== 'parent' || !principal.parent_id) throw new AppError(403, 'FORBIDDEN', 'This action is for parent accounts');
    return principal as Principal & { parent_id: string };
  }

  requireAdmin(sessionId: string | undefined): Principal {
    const principal = this.requireUser(sessionId);
    if (principal.role !== 'admin') throw new AppError(403, 'FORBIDDEN', 'Admin access only');
    return principal;
  }

  /** Parents may only act on their own children; admins on any. */
  assertCanActOnStudent(principal: Principal, studentId: string): void {
    if (principal.role === 'admin') return;
    const student = this.db.prepare('SELECT parent_id FROM students WHERE id = ?').get(studentId) as { parent_id: string } | undefined;
    if (!student) throw notFound('Student', studentId);
    if (student.parent_id !== principal.parent_id) throw new AppError(403, 'FORBIDDEN', 'That child is not on your account');
  }

  /** Parents may only see/pay/cancel bookings for their own children; admins any. */
  assertCanActOnBooking(principal: Principal, bookingId: string): void {
    if (principal.role === 'admin') return;
    const row = this.db
      .prepare('SELECT s.parent_id FROM bookings b JOIN students s ON s.id = b.student_id WHERE b.id = ?')
      .get(bookingId) as { parent_id: string } | undefined;
    if (!row) throw notFound('Booking', bookingId);
    if (row.parent_id !== principal.parent_id) throw new AppError(403, 'FORBIDDEN', 'That booking is not on your account');
  }

  private principalFor(account: Account): Principal {
    const parent = account.parent_id
      ? (this.db.prepare('SELECT * FROM parents WHERE id = ?').get(account.parent_id) as unknown as Parent)
      : null;
    const students = account.parent_id
      ? (this.db.prepare('SELECT * FROM students WHERE parent_id = ? ORDER BY name').all(account.parent_id) as unknown as Student[])
      : [];
    return {
      account_id: account.id,
      username: account.username,
      role: account.role,
      parent_id: account.parent_id,
      parent,
      students,
    };
  }
}
