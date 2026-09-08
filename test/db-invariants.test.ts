import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { isSqliteError, transaction } from '../src/db.ts';
import { IDS, T0, confirmedCount, makeService } from './helpers.ts';

/**
 * These tests bypass BookingService on purpose. They prove the two invariants
 * are enforced by the schema itself, so a bug (or a second service, or a
 * hand-written SQL fix) cannot corrupt the roster.
 */
describe('database-level backstops', () => {
  const now = T0.toISOString();
  const insert = `INSERT INTO bookings (id, student_id, trial_class_id, status, status_reason, created_at, updated_at, expires_at, confirmed_at)
                  VALUES (?, ?, ?, ?, NULL, ?, ?, NULL, ?)`;

  it('rejects a 5th confirmed booking inserted directly (capacity trigger)', () => {
    const { db } = makeService();
    assert.equal(confirmedCount(db, IDS.electricity), 4);
    assert.throws(
      () => db.prepare(insert).run('bk_x', IDS.sofia, IDS.electricity, 'confirmed', now, now, now),
      (err) => isSqliteError(err, 'CLASS_FULL'),
    );
    assert.equal(confirmedCount(db, IDS.electricity), 4);
  });

  it('rejects flipping a pending booking to confirmed when the class is full (capacity trigger)', () => {
    const { db } = makeService();
    db.prepare(insert).run('bk_x', IDS.sofia, IDS.electricity, 'pending_payment', now, now, null);
    assert.throws(
      () => db.prepare(`UPDATE bookings SET status = 'confirmed' WHERE id = 'bk_x'`).run(),
      (err) => isSqliteError(err, 'CLASS_FULL'),
    );
    assert.equal(db.prepare(`SELECT status FROM bookings WHERE id = 'bk_x'`).get()?.status, 'pending_payment');
  });

  it('rejects a second active booking for the same child and class (partial unique index)', () => {
    const { db } = makeService();
    // Ethan is confirmed in P4 Math; a pending duplicate must be rejected...
    assert.throws(
      () => db.prepare(insert).run('bk_dup', IDS.ethan, IDS.fractions, 'pending_payment', now, now, null),
      (err) => isSqliteError(err, 'UNIQUE constraint failed'),
    );
    // ...but terminal rows (history) for the same pair are fine.
    db.prepare(insert).run('bk_hist', IDS.ethan, IDS.fractions, 'payment_failed', now, now, null);
    assert.equal(confirmedCount(db, IDS.fractions), 3);
  });

  it('allows a new confirmation once a seat is released', () => {
    const { db } = makeService();
    db.prepare(`UPDATE bookings SET status = 'cancelled' WHERE id = 'bk_chloe_elec'`).run();
    db.prepare(insert).run('bk_x', IDS.sofia, IDS.electricity, 'confirmed', now, now, now);
    assert.equal(confirmedCount(db, IDS.electricity), 4);
  });

  it('transaction() rolls back everything when the callback throws', () => {
    const { db } = makeService();
    assert.throws(() =>
      transaction(db, () => {
        db.prepare(insert).run('bk_x', IDS.sofia, IDS.forces, 'confirmed', now, now, now);
        throw new Error('boom');
      }),
    );
    assert.equal(db.prepare(`SELECT COUNT(*) AS n FROM bookings WHERE id = 'bk_x'`).get()?.n, 0);
  });
});
