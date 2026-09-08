import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { MockPaymentProvider } from '../src/payments.ts';
import { CARD_OK, ControlledProvider, IDS, addStudents, confirmedCount, makeService } from './helpers.ts';

/**
 * Required scenario from the brief:
 *
 *   1. User A selects the last available slot and moves to payment.
 *   2. User B selects the same slot.
 *   3. User B completes payment first and confirms the booking.
 *   4. User A then tries to complete payment.
 *
 * Expected: at most one confirmed booking for the last seat.
 */
describe('last-seat race', () => {
  it('B pays first and wins; A is charged then refunded; exactly one confirmed booking for the last seat', async () => {
    const provider = new ControlledProvider();
    const { service, db } = makeService(provider);

    // P4 Math has exactly 3 confirmed students: one seat left.
    assert.equal(service.getTrialClass(IDS.fractions)!.seats_available, 1);

    // (1) User A (Maria, for Sofia) selects the last seat and moves to payment.
    const a = service.createBooking({ studentId: IDS.sofia, trialClassId: IDS.fractions }).booking;
    const payA = service.pay({ bookingId: a.id, card: CARD_OK });

    // (2) User B (Daniel, for Lucas) selects the same seat and moves to payment.
    const b = service.createBooking({ studentId: IDS.lucas, trialClassId: IDS.fractions }).booking;
    const payB = service.pay({ bookingId: b.id, card: CARD_OK });

    // Both charges are now in flight at the provider; neither has a seat.
    assert.deepEqual(provider.inFlight().sort(), [a.id, b.id].sort());
    assert.equal(confirmedCount(db, IDS.fractions), 3);

    // (3) User B completes payment first and is confirmed.
    provider.settle(b.id);
    const resB = await payB;
    assert.equal(resB.outcome, 'confirmed');
    assert.equal(resB.booking.status, 'confirmed');
    assert.equal(confirmedCount(db, IDS.fractions), 4);

    // (4) User A's payment then completes. The seat is gone: refund, no roster change.
    provider.settle(a.id);
    const resA = await payA;
    assert.equal(resA.outcome, 'refunded');
    assert.equal(resA.booking.status, 'refunded');
    assert.equal(resA.booking.status_reason, 'seat_taken');
    assert.equal(resA.attempt?.status, 'refunded');
    assert.ok(resA.attempt?.refund_ref);
    assert.deepEqual(provider.refunds, [{ providerRef: `ch_${a.id}`, amountCents: 2000 }]);

    // Invariants: capacity respected, roster shows the winner only, nobody left pending.
    assert.equal(confirmedCount(db, IDS.fractions), 4);
    const roster = service.getRoster(IDS.fractions);
    assert.deepEqual(
      roster.confirmed.map((r) => r.student_id).sort(),
      [IDS.ethan, IDS.ravi, IDS.mei, IDS.lucas].sort(),
    );
    assert.equal(roster.pending.length, 0);
  });

  it('is symmetric: if A settles first, A wins and B is refunded', async () => {
    const provider = new ControlledProvider();
    const { service, db } = makeService(provider);
    const a = service.createBooking({ studentId: IDS.sofia, trialClassId: IDS.fractions }).booking;
    const b = service.createBooking({ studentId: IDS.lucas, trialClassId: IDS.fractions }).booking;
    const payA = service.pay({ bookingId: a.id, card: CARD_OK });
    const payB = service.pay({ bookingId: b.id, card: CARD_OK });

    provider.settle(a.id);
    provider.settle(b.id);
    const [resA, resB] = await Promise.all([payA, payB]);

    assert.equal(resA.outcome, 'confirmed');
    assert.equal(resB.outcome, 'refunded');
    assert.equal(confirmedCount(db, IDS.fractions), 4);
    assert.equal(provider.refunds.length, 1);
  });

  it('if B had already confirmed before A pressed Pay, A is not charged at all', async () => {
    const provider = new ControlledProvider();
    const { service, db } = makeService(provider);
    const a = service.createBooking({ studentId: IDS.sofia, trialClassId: IDS.fractions }).booking;
    const b = service.createBooking({ studentId: IDS.lucas, trialClassId: IDS.fractions }).booking;

    const payB = service.pay({ bookingId: b.id, card: CARD_OK });
    provider.settle(b.id);
    assert.equal((await payB).outcome, 'confirmed');

    const resA = await service.pay({ bookingId: a.id, card: CARD_OK });
    assert.equal(resA.outcome, 'class_full');
    assert.equal(resA.booking.status, 'cancelled');
    assert.equal(provider.charges.length, 1, 'only B was ever charged');
    assert.equal(provider.refunds.length, 0);
    assert.equal(confirmedCount(db, IDS.fractions), 4);
  });

  it('a declined card on the winner side does not block the other user', async () => {
    const provider = new ControlledProvider();
    const { service, db } = makeService(provider);
    const a = service.createBooking({ studentId: IDS.sofia, trialClassId: IDS.fractions }).booking;
    const b = service.createBooking({ studentId: IDS.lucas, trialClassId: IDS.fractions }).booking;
    const payA = service.pay({ bookingId: a.id, card: CARD_OK });
    const payB = service.pay({ bookingId: b.id, card: CARD_OK });

    provider.settle(b.id, { ok: false, failureCode: 'card_declined' });
    assert.equal((await payB).outcome, 'payment_failed');
    assert.equal(confirmedCount(db, IDS.fractions), 3, 'seat still free');

    provider.settle(a.id);
    assert.equal((await payA).outcome, 'confirmed');
    assert.equal(confirmedCount(db, IDS.fractions), 4);
  });

  it('holds under a burst: 12 families race for the last seat, exactly one wins, every loser is refunded or unpaid', async () => {
    const { service, db, provider } = makeService(new MockPaymentProvider());
    const kids = addStudents(db, 12);
    const bookings = kids.map((studentId) => service.createBooking({ studentId, trialClassId: IDS.fractions }).booking);

    // Random provider latency so the completion order is arbitrary.
    const results = await Promise.all(
      bookings.map((b) => service.pay({ bookingId: b.id, card: CARD_OK, delayMs: Math.floor(Math.random() * 30) })),
    );

    const outcomes = results.map((r) => r.outcome);
    assert.equal(outcomes.filter((o) => o === 'confirmed').length, 1);
    assert.equal(outcomes.filter((o) => o === 'refunded').length + outcomes.filter((o) => o === 'class_full').length, 11);
    assert.equal(confirmedCount(db, IDS.fractions), 4);

    // Money is conserved: every successful charge that lost was refunded.
    const charged = provider.charges.filter((c) => c.result.ok).length;
    assert.equal(provider.refunds.length, charged - 1);
    assert.equal(service.getRoster(IDS.fractions).pending.length, 0);
  });
});
