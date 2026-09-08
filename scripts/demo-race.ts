/**
 * Narrated, self-contained demo of the required "last-seat race" scenario plus
 * the other edge cases, against an in-memory copy of the seed data.
 *
 *   npm run demo:race
 */
import { openDb } from '../src/db.ts';
import { seed } from '../src/seed.ts';
import { MockPaymentProvider } from '../src/payments.ts';
import { BookingService } from '../src/booking-service.ts';
import { AppError } from '../src/errors.ts';

const db = openDb(':memory:');
seed(db);
const provider = new MockPaymentProvider();
const service = new BookingService(db, provider);

const CARD_OK = '4242424242424242';
const CARD_DECLINED = '4000000000000002';
const CLASS = 'cls_math_p4_fractions';
const t0 = Date.now();
const log = (msg: string) => console.log(`  [t+${String(Date.now() - t0).padStart(4, ' ')} ms] ${msg}`);
const money = (cents: number) => `S$${(cents / 100).toFixed(2)}`;
const seats = () => {
  const c = service.getTrialClass(CLASS)!;
  return `${c.confirmed_count}/${c.capacity} confirmed, ${c.seats_available} seat(s) left`;
};
const names = () => service.getRoster(CLASS).confirmed.map((r) => r.student_name).join(', ');

console.log('\n=== Ottodot trial booking: last-seat race ===\n');
console.log(`Class: ${service.getTrialClass(CLASS)!.title}`);
console.log(`Now:   ${seats()} (${names()})\n`);

// 1. User A selects the last seat and moves to payment.
const a = service.createBooking({ studentId: 'stu_sofia', trialClassId: CLASS }).booking;
log(`User A (Maria, for Sofia) selects the last seat  -> booking ${a.id.slice(0, 8)} ${a.status}`);
const payA = service.pay({ bookingId: a.id, card: CARD_OK, delayMs: 400 });
log('User A goes to payment (slow network, ~400 ms)');

// 2. User B selects the same seat.
const b = service.createBooking({ studentId: 'stu_lucas', trialClassId: CLASS }).booking;
log(`User B (Daniel, for Lucas) selects the same seat -> booking ${b.id.slice(0, 8)} ${b.status}`);
const payB = service.pay({ bookingId: b.id, card: CARD_OK, delayMs: 50 });
log('User B goes to payment (fast network, ~50 ms)');
log(`Both charges in flight. Roster unchanged: ${seats()}`);

// 3. User B completes payment first.
const resB = await payB;
log(`User B: payment ${resB.attempt?.status} -> seat claimed -> booking ${resB.booking.status.toUpperCase()}  (${seats()})`);

// 4. User A then completes payment.
const resA = await payA;
log(
  `User A: payment succeeded -> seat claim FAILED (${resA.booking.status_reason}) -> ${money(resA.attempt!.amount_cents)} refunded (${resA.attempt!.refund_ref}) -> booking ${resA.booking.status.toUpperCase()}`,
);

console.log(`\nRoster: ${names()}  [${seats()}]`);
console.log(`Sofia:  ${resA.booking.status} (${resA.booking.status_reason}); charges=${provider.charges.length}, refunds=${provider.refunds.length}`);
const cls = service.getTrialClass(CLASS)!;
console.log(`Invariant: confirmed (${cls.confirmed_count}) <= capacity (${cls.capacity})  ${cls.confirmed_count <= cls.capacity ? 'OK' : 'VIOLATED'}\n`);

// --- Other edge cases ------------------------------------------------------
console.log('=== Other edge cases ===\n');

try {
  service.createBooking({ studentId: 'stu_ethan', trialClassId: CLASS });
} catch (err) {
  if (err instanceof AppError) console.log(`Duplicate:      Ethan again in P4 Math -> ${err.status} ${err.code}: ${err.message}`);
}

try {
  service.createBooking({ studentId: 'stu_hana', trialClassId: 'cls_sci_p5_forces' });
  const full = service.createBooking({ studentId: 'stu_sofia', trialClassId: CLASS });
  console.log(`unexpected: ${full.booking.status}`);
} catch (err) {
  if (err instanceof AppError) console.log(`Overbooking:    Sofia into the now-full P4 Math -> ${err.status} ${err.code}: ${err.message}`);
}

const declined = service.createBooking({ studentId: 'stu_ben', trialClassId: 'cls_sci_p5_forces' }).booking;
const resDeclined = await service.pay({ bookingId: declined.id, card: CARD_DECLINED });
console.log(
  `Payment failed: Ben into P5 Science with a declined card -> booking ${resDeclined.booking.status} (${resDeclined.booking.status_reason}); roster size ${service.getRoster('cls_sci_p5_forces').confirmed.length}`,
);

const again = await service.pay({ bookingId: b.id, card: CARD_OK });
console.log(`Idempotent pay: paying Lucas's confirmed booking again -> ${again.outcome}; charges unchanged (${provider.charges.length})`);
console.log();
