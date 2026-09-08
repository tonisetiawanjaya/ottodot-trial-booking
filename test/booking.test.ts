import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AppError } from '../src/errors.ts';
import { CARD_DECLINED, CARD_OK, ControlledProvider, IDS, confirmedCount, makeService } from './helpers.ts';

function expectAppError(fn: () => unknown, code: string, status = 409): AppError {
  try {
    fn();
  } catch (err) {
    assert.ok(err instanceof AppError, `expected AppError, got ${String(err)}`);
    assert.equal(err.code, code);
    assert.equal(err.status, status);
    return err;
  }
  assert.fail(`expected ${code} to be thrown`);
}

describe('seed data', () => {
  it('contains every scenario the take-home asks for', () => {
    const { service } = makeService();
    const byId = Object.fromEntries(service.listTrialClasses().map((c) => [c.id, c]));
    assert.equal(byId[IDS.forces].confirmed_count, 0, 'a class with available seats');
    assert.equal(byId[IDS.forces].seats_available, 4);
    assert.equal(byId[IDS.fractions].confirmed_count, 3, 'a class with exactly 3 confirmed students');
    assert.equal(byId[IDS.fractions].seats_available, 1);
    assert.equal(byId[IDS.electricity].confirmed_count, 4, 'a full class');
    assert.equal(byId[IDS.electricity].seats_available, 0);
    const lucas = service.listBookingsForParent(IDS.daniel).find((b) => b.student_id === IDS.lucas);
    assert.equal(lucas?.status, 'payment_failed', 'a payment failure case');
    assert.equal(lucas?.status_reason, 'card_declined');
  });
});

describe('happy path', () => {
  it('creates a pending booking that does not occupy a seat, then confirms it on payment', async () => {
    const { service, db } = makeService();
    const { booking, reused } = service.createBooking({ studentId: IDS.sofia, trialClassId: IDS.forces });
    assert.equal(reused, false);
    assert.equal(booking.status, 'pending_payment');
    assert.ok(booking.expires_at);
    assert.equal(service.getTrialClass(IDS.forces)!.confirmed_count, 0, 'pending must not count as a seat');
    assert.equal(service.getTrialClass(IDS.forces)!.pending_count, 1);
    assert.equal(service.getRoster(IDS.forces).confirmed.length, 0);

    const res = await service.pay({ bookingId: booking.id, card: CARD_OK });
    assert.equal(res.outcome, 'confirmed');
    assert.equal(res.booking.status, 'confirmed');
    assert.ok(res.booking.confirmed_at);
    assert.equal(res.attempt?.status, 'succeeded');
    assert.ok(res.attempt?.provider_ref);
    assert.equal(confirmedCount(db, IDS.forces), 1);
    assert.deepEqual(
      service.getRoster(IDS.forces).confirmed.map((r) => r.student_id),
      [IDS.sofia],
    );
  });

  it('exposes booking status and payment history after submission', async () => {
    const { service } = makeService();
    const { booking } = service.createBooking({ studentId: IDS.sofia, trialClassId: IDS.forces });
    await service.pay({ bookingId: booking.id, card: CARD_OK });
    const detail = service.getBookingDetail(booking.id);
    assert.equal(detail.booking.status, 'confirmed');
    assert.equal(detail.student.id, IDS.sofia);
    assert.equal(detail.parent.id, IDS.maria);
    assert.equal(detail.trial_class.id, IDS.forces);
    assert.equal(detail.payment_attempts.length, 1);
    assert.equal(detail.payment_attempts[0].status, 'succeeded');
    assert.equal(detail.payment_attempts[0].amount_cents, 2000);
  });
});

describe('payment failure', () => {
  it('marks the booking payment_failed and never adds the child to the roster', async () => {
    const { service, provider, db } = makeService();
    const { booking } = service.createBooking({ studentId: IDS.sofia, trialClassId: IDS.forces });
    const res = await service.pay({ bookingId: booking.id, card: CARD_DECLINED });
    assert.equal(res.outcome, 'payment_failed');
    assert.equal(res.booking.status, 'payment_failed');
    assert.equal(res.booking.status_reason, 'card_declined');
    assert.equal(res.attempt?.status, 'failed');
    assert.equal(res.attempt?.failure_code, 'card_declined');
    assert.equal(confirmedCount(db, IDS.forces), 0);
    assert.equal(service.getRoster(IDS.forces).confirmed.length, 0);
    assert.equal(provider.refunds.length, 0, 'nothing to refund: nothing was charged');
  });

  it('lets the parent try again with a fresh booking (the failed one stays as history)', async () => {
    const { service } = makeService();
    const first = service.createBooking({ studentId: IDS.sofia, trialClassId: IDS.forces }).booking;
    await service.pay({ bookingId: first.id, card: CARD_DECLINED });

    const second = service.createBooking({ studentId: IDS.sofia, trialClassId: IDS.forces });
    assert.equal(second.reused, false);
    assert.notEqual(second.booking.id, first.id);
    const res = await service.pay({ bookingId: second.booking.id, card: CARD_OK });
    assert.equal(res.outcome, 'confirmed');
    assert.equal(service.getBooking(first.id)?.status, 'payment_failed');
  });

  it('refuses to take payment for a booking that is not pending', async () => {
    const { service } = makeService();
    const { booking } = service.createBooking({ studentId: IDS.sofia, trialClassId: IDS.forces });
    await service.pay({ bookingId: booking.id, card: CARD_DECLINED });
    await assert.rejects(
      service.pay({ bookingId: booking.id, card: CARD_OK }),
      (err: AppError) => err.code === 'BOOKING_NOT_PAYABLE' && err.status === 409,
    );
  });
});

describe('duplicate bookings', () => {
  it('rejects a second booking for a child who is already confirmed in the class', () => {
    const { service } = makeService();
    // Ethan Tan is already confirmed in P4 Math (seed).
    const err = expectAppError(() => service.createBooking({ studentId: IDS.ethan, trialClassId: IDS.fractions }), 'DUPLICATE_BOOKING');
    assert.equal(err.details?.booking_id, 'bk_ethan_math');
    assert.equal(service.getTrialClass(IDS.fractions)!.confirmed_count, 3, 'roster unchanged');
  });

  it('returns the existing pending booking instead of creating a second one (double submit)', () => {
    const { service } = makeService();
    const first = service.createBooking({ studentId: IDS.sofia, trialClassId: IDS.forces });
    const second = service.createBooking({ studentId: IDS.sofia, trialClassId: IDS.forces });
    assert.equal(second.reused, true);
    assert.equal(second.booking.id, first.booking.id);
    assert.equal(service.getTrialClass(IDS.forces)!.pending_count, 1);
  });

  it('still allows the same child to book a *different* class', () => {
    const { service } = makeService();
    const { booking } = service.createBooking({ studentId: IDS.ethan, trialClassId: IDS.forces });
    assert.equal(booking.status, 'pending_payment');
  });
});

describe('overbooking', () => {
  it('rejects a booking for a full class up front', () => {
    const { service } = makeService();
    expectAppError(() => service.createBooking({ studentId: IDS.sofia, trialClassId: IDS.electricity }), 'CLASS_FULL');
  });

  it('never confirms a 5th student: a pending booking created before the class filled is cancelled at pay time, unpaid', async () => {
    const { service, provider, db } = makeService();
    // P4 Math: 3 confirmed, one seat left. Two families create bookings.
    const a = service.createBooking({ studentId: IDS.sofia, trialClassId: IDS.fractions }).booking;
    const b = service.createBooking({ studentId: IDS.lucas, trialClassId: IDS.fractions }).booking;

    const resB = await service.pay({ bookingId: b.id, card: CARD_OK });
    assert.equal(resB.outcome, 'confirmed');
    assert.equal(confirmedCount(db, IDS.fractions), 4);

    const resA = await service.pay({ bookingId: a.id, card: CARD_OK });
    assert.equal(resA.outcome, 'class_full');
    assert.equal(resA.booking.status, 'cancelled');
    assert.equal(resA.booking.status_reason, 'class_full_before_payment');
    assert.equal(resA.attempt, null);
    assert.equal(provider.charges.length, 1, 'user A was never charged');
    assert.equal(confirmedCount(db, IDS.fractions), 4);
  });
});

describe('pending-booking expiry (background job)', () => {
  it('expires bookings past their checkout window and lets the child book again', () => {
    const { service, clock } = makeService();
    const first = service.createBooking({ studentId: IDS.sofia, trialClassId: IDS.forces }).booking;

    clock.now = new Date(clock.now.getTime() + 14 * 60_000);
    assert.equal(service.expirePendingBookings().expired, 0, 'not yet');

    clock.now = new Date(clock.now.getTime() + 2 * 60_000);
    assert.equal(service.expirePendingBookings().expired, 1);
    assert.equal(service.getBooking(first.id)?.status, 'expired');
    assert.equal(service.getTrialClass(IDS.forces)!.pending_count, 0);

    const again = service.createBooking({ studentId: IDS.sofia, trialClassId: IDS.forces });
    assert.equal(again.reused, false);
    assert.notEqual(again.booking.id, first.id);
  });

  it('does not expire a booking whose charge is in flight', async () => {
    const provider = new ControlledProvider();
    const { service, clock } = makeService(provider);
    const { booking } = service.createBooking({ studentId: IDS.sofia, trialClassId: IDS.forces });
    const paying = service.pay({ bookingId: booking.id, card: CARD_OK });

    clock.now = new Date(clock.now.getTime() + 60 * 60_000);
    assert.equal(service.expirePendingBookings().expired, 0);

    provider.settle(booking.id);
    const res = await paying;
    assert.equal(res.outcome, 'confirmed');
  });

  it('refunds a payment that completes after the booking was expired (no seat, no money kept)', async () => {
    const provider = new ControlledProvider();
    const { service, db } = makeService(provider);
    const { booking } = service.createBooking({ studentId: IDS.sofia, trialClassId: IDS.forces });
    // Simulate an operator/admin action that cancels the pending booking mid-charge.
    const paying = service.pay({ bookingId: booking.id, card: CARD_OK });
    await service.cancelBooking(booking.id, 'cancelled_by_admin');
    provider.settle(booking.id);
    const res = await paying;
    assert.equal(res.outcome, 'refunded');
    assert.equal(res.booking.status, 'refunded');
    assert.equal(res.booking.status_reason, 'booking_cancelled');
    assert.equal(provider.refunds.length, 1);
    assert.equal(confirmedCount(db, IDS.forces), 0);
  });
});

describe('cancellation', () => {
  it('cancelling a confirmed booking frees the seat and refunds the payment', async () => {
    const { service, provider, db } = makeService();
    assert.equal(service.getTrialClass(IDS.electricity)!.seats_available, 0);

    const cancelled = await service.cancelBooking('bk_chloe_elec', 'cancelled_by_admin');
    assert.equal(cancelled.status, 'cancelled');
    assert.equal(provider.refunds.length, 1);
    assert.equal(service.getTrialClass(IDS.electricity)!.seats_available, 1);

    const { booking } = service.createBooking({ studentId: IDS.sofia, trialClassId: IDS.electricity });
    const res = await service.pay({ bookingId: booking.id, card: CARD_OK });
    assert.equal(res.outcome, 'confirmed');
    assert.equal(confirmedCount(db, IDS.electricity), 4);
  });

  it('cannot cancel a booking twice', async () => {
    const { service } = makeService();
    await service.cancelBooking('bk_chloe_elec');
    await assert.rejects(service.cancelBooking('bk_chloe_elec'), (err: AppError) => err.code === 'BOOKING_NOT_CANCELLABLE');
  });
});

describe('idempotency', () => {
  it('paying an already-confirmed booking again is a no-op and does not charge twice', async () => {
    const { service, provider } = makeService();
    const { booking } = service.createBooking({ studentId: IDS.sofia, trialClassId: IDS.forces });
    const first = await service.pay({ bookingId: booking.id, card: CARD_OK });
    const second = await service.pay({ bookingId: booking.id, card: CARD_OK });
    assert.equal(first.outcome, 'confirmed');
    assert.equal(second.outcome, 'already_confirmed');
    assert.equal(second.attempt?.id, first.attempt?.id);
    assert.equal(provider.charges.length, 1);
  });

  it('rejects a second pay call while the first charge is still in flight (double click)', async () => {
    const provider = new ControlledProvider();
    const { service } = makeService(provider);
    const { booking } = service.createBooking({ studentId: IDS.sofia, trialClassId: IDS.forces });
    const first = service.pay({ bookingId: booking.id, card: CARD_OK });
    await assert.rejects(service.pay({ bookingId: booking.id, card: CARD_OK }), (err: AppError) => err.code === 'PAYMENT_IN_PROGRESS');
    provider.settle(booking.id);
    assert.equal((await first).outcome, 'confirmed');
    assert.equal(provider.charges.length, 1);
  });
});

describe('validation', () => {
  it('404s on unknown student, class or booking', async () => {
    const { service } = makeService();
    expectAppError(() => service.createBooking({ studentId: 'nope', trialClassId: IDS.forces }), 'NOT_FOUND', 404);
    expectAppError(() => service.createBooking({ studentId: IDS.sofia, trialClassId: 'nope' }), 'NOT_FOUND', 404);
    await assert.rejects(service.pay({ bookingId: 'nope', card: CARD_OK }), (err: AppError) => err.status === 404);
  });
});
