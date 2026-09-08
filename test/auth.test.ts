import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { hashPassword, verifyPassword } from '../src/auth.ts';
import { AppError } from '../src/errors.ts';
import { IDS, PASSWORDS, makeService } from './helpers.ts';

const isAppError = (code: string, status: number) => (err: unknown) =>
  err instanceof AppError && err.code === code && err.status === status;

describe('passwords', () => {
  it('hashes with a random salt and verifies the right password only', () => {
    const a = hashPassword('parent123');
    const b = hashPassword('parent123');
    assert.notEqual(a, b, 'different salts');
    assert.ok(a.startsWith('scrypt$'));
    assert.equal(verifyPassword('parent123', a), true);
    assert.equal(verifyPassword('parent124', a), false);
    assert.equal(verifyPassword('parent123', 'garbage'), false);
  });
});

describe('login and sessions', () => {
  it('logs a parent in and exposes their children', () => {
    const { auth } = makeService();
    const { session, principal } = auth.login('maria', PASSWORDS.parent);
    assert.equal(principal.role, 'parent');
    assert.equal(principal.parent?.name, 'Maria Santos');
    assert.deepEqual(principal.students.map((s) => s.id), [IDS.sofia]);
    assert.equal(auth.principalForSession(session.id)?.username, 'maria');
  });

  it('is case-insensitive on the username and rejects wrong passwords with one generic error', () => {
    const { auth } = makeService();
    assert.equal(auth.login('  MARIA ', PASSWORDS.parent).principal.username, 'maria');
    assert.throws(() => auth.login('maria', 'nope'), isAppError('INVALID_CREDENTIALS', 401));
    assert.throws(() => auth.login('nobody', 'nope'), isAppError('INVALID_CREDENTIALS', 401));
  });

  it('expires sessions after the TTL and forgets them on logout', () => {
    const { auth, clock } = makeService();
    const { session } = auth.login('daniel', PASSWORDS.parent);
    clock.now = new Date(clock.now.getTime() + 6 * 24 * 60 * 60_000);
    assert.ok(auth.principalForSession(session.id), 'still valid on day 6');
    clock.now = new Date(clock.now.getTime() + 2 * 24 * 60 * 60_000);
    assert.equal(auth.principalForSession(session.id), null, 'expired on day 8');

    const fresh = auth.login('daniel', PASSWORDS.parent).session;
    auth.logout(fresh.id);
    assert.equal(auth.principalForSession(fresh.id), null);
    assert.equal(auth.principalForSession(undefined), null);
    assert.equal(auth.principalForSession('not-a-session'), null);
  });

  it('separates parent and admin roles', () => {
    const { auth } = makeService();
    const parent = auth.login('maria', PASSWORDS.parent).session.id;
    const admin = auth.login('admin', PASSWORDS.admin).session.id;
    assert.equal(auth.requireAdmin(admin).role, 'admin');
    assert.throws(() => auth.requireAdmin(parent), isAppError('FORBIDDEN', 403));
    assert.equal(auth.requireParent(parent).parent_id, IDS.maria);
    assert.throws(() => auth.requireParent(admin), isAppError('FORBIDDEN', 403));
    assert.throws(() => auth.requireUser(undefined), isAppError('UNAUTHENTICATED', 401));
  });
});

describe('ownership checks', () => {
  it('a parent may act on their own children and bookings only; admins on any', () => {
    const { auth } = makeService();
    const maria = auth.login('maria', PASSWORDS.parent).principal;
    const daniel = auth.login('daniel', PASSWORDS.parent).principal;
    const admin = auth.login('admin', PASSWORDS.admin).principal;

    auth.assertCanActOnStudent(maria, IDS.sofia);
    assert.throws(() => auth.assertCanActOnStudent(maria, IDS.ethan), isAppError('FORBIDDEN', 403));
    assert.throws(() => auth.assertCanActOnStudent(maria, 'nope'), isAppError('NOT_FOUND', 404));
    auth.assertCanActOnStudent(admin, IDS.ethan);

    auth.assertCanActOnBooking(daniel, 'bk_lucas_forces_failed');
    assert.throws(() => auth.assertCanActOnBooking(maria, 'bk_lucas_forces_failed'), isAppError('FORBIDDEN', 403));
    assert.throws(() => auth.assertCanActOnBooking(maria, 'nope'), isAppError('NOT_FOUND', 404));
    auth.assertCanActOnBooking(admin, 'bk_lucas_forces_failed');
  });
});
