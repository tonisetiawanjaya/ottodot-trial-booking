import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { DB } from './db.ts';
import { openDb } from './db.ts';

/**
 * Small synthetic dataset. Everything the take-home asks to demonstrate is
 * reachable from here:
 *
 *   cls_sci_p5_forces      0/4 confirmed  -> "a class with available seats"
 *                                            (+ Lucas Lim's declined payment -> "a payment failure case")
 *   cls_math_p4_fractions  3/4 confirmed  -> "exactly 3 confirmed students": the last-seat class
 *   cls_sci_p6_electricity 4/4 confirmed  -> a full class (UI shows Full; API returns CLASS_FULL)
 *
 *   Duplicate attempt: book Ethan Tan into P4 Math again -> 409 DUPLICATE_BOOKING.
 */
export const SEED = {
  parents: [
    { id: 'par_aisha', name: 'Aisha Tan', email: 'aisha.tan@example.com' },
    { id: 'par_daniel', name: 'Daniel Lim', email: 'daniel.lim@example.com' },
    { id: 'par_priya', name: 'Priya Nair', email: 'priya.nair@example.com' },
    { id: 'par_wei', name: 'Wei Chen', email: 'wei.chen@example.com' },
    { id: 'par_maria', name: 'Maria Santos', email: 'maria.santos@example.com' },
  ],
  students: [
    { id: 'stu_ethan', parent_id: 'par_aisha', name: 'Ethan Tan', grade: 'P4' },
    { id: 'stu_chloe', parent_id: 'par_aisha', name: 'Chloe Tan', grade: 'P6' },
    { id: 'stu_lucas', parent_id: 'par_daniel', name: 'Lucas Lim', grade: 'P5' },
    { id: 'stu_ben', parent_id: 'par_daniel', name: 'Ben Lim', grade: 'P6' },
    { id: 'stu_ravi', parent_id: 'par_priya', name: 'Ravi Nair', grade: 'P4' },
    { id: 'stu_arjun', parent_id: 'par_priya', name: 'Arjun Nair', grade: 'P6' },
    { id: 'stu_mei', parent_id: 'par_wei', name: 'Mei Chen', grade: 'P4' },
    { id: 'stu_hana', parent_id: 'par_wei', name: 'Hana Chen', grade: 'P6' },
    { id: 'stu_sofia', parent_id: 'par_maria', name: 'Sofia Santos', grade: 'P4' },
  ],
  classes: [
    { id: 'cls_sci_p5_forces', subject: 'Science', title: 'P5 Science: Forces & Motion', teacher: 'Ms. Rachel Goh', daysFromNow: 2, hour: 16, price_cents: 2000 },
    { id: 'cls_math_p4_fractions', subject: 'Math', title: 'P4 Math: Fractions Made Simple', teacher: 'Mr. Jason Koh', daysFromNow: 3, hour: 10, price_cents: 2000 },
    { id: 'cls_sci_p6_electricity', subject: 'Science', title: 'P6 Science: Electricity & Circuits', teacher: 'Ms. Rachel Goh', daysFromNow: 4, hour: 14, price_cents: 2500 },
  ],
  /** confirmed bookings (each with a succeeded payment attempt) */
  confirmed: [
    { id: 'bk_ethan_math', student_id: 'stu_ethan', trial_class_id: 'cls_math_p4_fractions' },
    { id: 'bk_ravi_math', student_id: 'stu_ravi', trial_class_id: 'cls_math_p4_fractions' },
    { id: 'bk_mei_math', student_id: 'stu_mei', trial_class_id: 'cls_math_p4_fractions' },
    { id: 'bk_chloe_elec', student_id: 'stu_chloe', trial_class_id: 'cls_sci_p6_electricity' },
    { id: 'bk_arjun_elec', student_id: 'stu_arjun', trial_class_id: 'cls_sci_p6_electricity' },
    { id: 'bk_hana_elec', student_id: 'stu_hana', trial_class_id: 'cls_sci_p6_electricity' },
    { id: 'bk_ben_elec', student_id: 'stu_ben', trial_class_id: 'cls_sci_p6_electricity' },
  ],
  /** a booking whose card was declined: never reached the roster */
  paymentFailed: [
    { id: 'bk_lucas_forces_failed', student_id: 'stu_lucas', trial_class_id: 'cls_sci_p5_forces', failure_code: 'card_declined' },
  ],
};

export function seed(db: DB, now: Date = new Date()): void {
  db.exec('BEGIN IMMEDIATE');
  try {
    db.exec('DELETE FROM payment_attempts; DELETE FROM bookings; DELETE FROM students; DELETE FROM parents; DELETE FROM trial_classes;');

    const insParent = db.prepare('INSERT INTO parents (id, name, email) VALUES (?, ?, ?)');
    for (const p of SEED.parents) insParent.run(p.id, p.name, p.email);

    const insStudent = db.prepare('INSERT INTO students (id, parent_id, name, grade) VALUES (?, ?, ?, ?)');
    for (const s of SEED.students) insStudent.run(s.id, s.parent_id, s.name, s.grade);

    const insClass = db.prepare(
      'INSERT INTO trial_classes (id, subject, title, teacher, starts_at, capacity, price_cents) VALUES (?, ?, ?, ?, ?, 4, ?)',
    );
    const priceOf = new Map<string, number>();
    for (const c of SEED.classes) {
      const startsAt = new Date(now);
      startsAt.setUTCDate(startsAt.getUTCDate() + c.daysFromNow);
      startsAt.setUTCHours(c.hour - 8, 0, 0, 0); // classes are scheduled in Singapore time (UTC+8)
      insClass.run(c.id, c.subject, c.title, c.teacher, startsAt.toISOString(), c.price_cents);
      priceOf.set(c.id, c.price_cents);
    }

    const insBooking = db.prepare(
      `INSERT INTO bookings (id, student_id, trial_class_id, status, status_reason, created_at, updated_at, expires_at, confirmed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const insAttempt = db.prepare(
      `INSERT INTO payment_attempts (id, booking_id, amount_cents, currency, status, provider_ref, failure_code, refund_ref, created_at, updated_at)
       VALUES (?, ?, ?, 'SGD', ?, ?, ?, NULL, ?, ?)`,
    );

    // Confirmed bookings were made yesterday, a minute apart, so the roster has a stable order.
    const yesterday = new Date(now.getTime() - 24 * 60 * 60 * 1000);
    SEED.confirmed.forEach((b, i) => {
      const at = new Date(yesterday.getTime() + i * 60_000).toISOString();
      insBooking.run(b.id, b.student_id, b.trial_class_id, 'confirmed', null, at, at, null, at);
      insAttempt.run(`pay_${b.id}`, b.id, priceOf.get(b.trial_class_id)!, 'succeeded', `ch_seed_${i + 1}`, null, at, at);
    });

    SEED.paymentFailed.forEach((b, i) => {
      const at = new Date(yesterday.getTime() + (SEED.confirmed.length + i) * 60_000).toISOString();
      insBooking.run(b.id, b.student_id, b.trial_class_id, 'payment_failed', b.failure_code, at, at, null, null);
      insAttempt.run(`pay_${b.id}`, b.id, priceOf.get(b.trial_class_id)!, 'failed', null, b.failure_code, at, at);
    });

    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function isSeeded(db: DB): boolean {
  const row = db.prepare('SELECT COUNT(*) AS n FROM parents').get() as { n: number };
  return row.n > 0;
}

// CLI: `npm run seed` resets the on-disk database to the seed state.
const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const path = process.env.DATA_PATH ?? resolve(process.cwd(), 'data', 'ottodot.sqlite');
  const db = openDb(path);
  seed(db);
  console.log(`Seeded ${path}`);
  console.log('  cls_sci_p5_forces       0/4 confirmed (available; Lucas Lim has a declined payment)');
  console.log('  cls_math_p4_fractions   3/4 confirmed (one seat left: the last-seat class)');
  console.log('  cls_sci_p6_electricity  4/4 confirmed (full)');
  db.close();
}
