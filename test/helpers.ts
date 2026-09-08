import { openDb, type DB } from '../src/db.ts';
import { seed } from '../src/seed.ts';
import { MockPaymentProvider, type ChargeRequest, type ChargeResult, type PaymentProvider } from '../src/payments.ts';
import { BookingService } from '../src/booking-service.ts';

export const CARD_OK = '4242424242424242';
export const CARD_DECLINED = '4000000000000002';

/** Fixed "now" so seeded timestamps and TTLs are deterministic. */
export const T0 = new Date('2026-09-08T09:00:00.000Z');

/** Ids from src/seed.ts */
export const IDS = {
  forces: 'cls_sci_p5_forces', // 0/4 confirmed
  fractions: 'cls_math_p4_fractions', // 3/4 confirmed: the last-seat class
  electricity: 'cls_sci_p6_electricity', // 4/4 confirmed: full
  ethan: 'stu_ethan', // confirmed in fractions
  chloe: 'stu_chloe', // confirmed in electricity
  lucas: 'stu_lucas', // payment_failed in forces
  ben: 'stu_ben',
  ravi: 'stu_ravi',
  arjun: 'stu_arjun',
  mei: 'stu_mei',
  hana: 'stu_hana',
  sofia: 'stu_sofia', // no bookings
  aisha: 'par_aisha',
  daniel: 'par_daniel',
  priya: 'par_priya',
  wei: 'par_wei',
  maria: 'par_maria',
};

export function makeService<P extends PaymentProvider = MockPaymentProvider>(provider?: P) {
  const db = openDb(':memory:');
  const clock = { now: new Date(T0) };
  seed(db, clock.now);
  const p = (provider ?? new MockPaymentProvider()) as P;
  const service = new BookingService(db, p, { now: () => clock.now, pendingTtlMinutes: 15 });
  return { db, clock, provider: p, service };
}

/**
 * A payment provider whose charges complete only when the test says so.
 * Lets a test script the exact interleaving of the last-seat race.
 */
export class ControlledProvider implements PaymentProvider {
  private pending = new Map<string, (r: ChargeResult) => void>();
  charges: ChargeRequest[] = [];
  refunds: Array<{ providerRef: string; amountCents: number }> = [];

  charge(req: ChargeRequest): Promise<ChargeResult> {
    this.charges.push(req);
    return new Promise((resolve) => this.pending.set(req.metadata.bookingId, resolve));
  }

  async refund(providerRef: string, amountCents: number): Promise<{ refundRef: string }> {
    this.refunds.push({ providerRef, amountCents });
    return { refundRef: `re_${this.refunds.length}` };
  }

  /** Complete the in-flight charge for a booking (succeeds unless told otherwise). */
  settle(bookingId: string, result: ChargeResult = { ok: true, providerRef: `ch_${bookingId}` }): void {
    const resolve = this.pending.get(bookingId);
    if (!resolve) throw new Error(`no in-flight charge for booking ${bookingId}`);
    this.pending.delete(bookingId);
    resolve(result);
  }

  inFlight(): string[] {
    return [...this.pending.keys()];
  }
}

export function confirmedCount(db: DB, classId: string): number {
  const row = db
    .prepare(`SELECT COUNT(*) AS n FROM bookings WHERE trial_class_id = ? AND status = 'confirmed'`)
    .get(classId) as { n: number };
  return row.n;
}

/** Add N extra students (each with their own parent) so burst tests have enough distinct children. */
export function addStudents(db: DB, n: number, prefix = 'extra'): string[] {
  const ids: string[] = [];
  for (let i = 0; i < n; i++) {
    const pid = `par_${prefix}_${i}`;
    const sid = `stu_${prefix}_${i}`;
    db.prepare('INSERT INTO parents (id, name, email) VALUES (?, ?, ?)').run(pid, `Parent ${prefix} ${i}`, `${prefix}${i}@example.com`);
    db.prepare('INSERT INTO students (id, parent_id, name, grade) VALUES (?, ?, ?, ?)').run(sid, pid, `Kid ${prefix} ${i}`, 'P4');
    ids.push(sid);
  }
  return ids;
}
