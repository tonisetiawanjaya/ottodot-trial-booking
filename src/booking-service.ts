import { randomUUID } from 'node:crypto';
import type { DB } from './db.ts';
import { isSqliteError, transaction } from './db.ts';
import type { PaymentProvider } from './payments.ts';
import { AppError, notFound } from './errors.ts';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/**
 * Booking lifecycle. Only `confirmed` occupies a seat.
 *
 *   pending_payment --pay ok + seat claimed--> confirmed --cancel--> cancelled
 *        |                                                     (seat released)
 *        |--provider declined---------------> payment_failed
 *        |--pay ok, but seat gone (refund)---> refunded
 *        |     '--provider refund call failed--> refund_pending --job retries--> refunded
 *        |--class filled before we charged---> cancelled
 *        |--cancelled by parent/admin--------> cancelled
 *        '--TTL elapsed (background job)-----> expired
 *
 * payment_failed / refunded / expired / cancelled are terminal. A parent who
 * wants to try again creates a *new* booking, which gives every attempt a
 * fresh id and keeps the state machine small. refund_pending is terminal for
 * the seat (it is gone) but not for the money: the reconcile job finishes it.
 */
export const BOOKING_STATUSES = [
  'pending_payment',
  'confirmed',
  'payment_failed',
  'refunded',
  'refund_pending',
  'expired',
  'cancelled',
] as const;
export type BookingStatus = (typeof BOOKING_STATUSES)[number];

export interface Parent {
  id: string;
  name: string;
  email: string;
}

export interface Student {
  id: string;
  parent_id: string;
  name: string;
  grade: string;
}

export interface TrialClass {
  id: string;
  subject: string;
  title: string;
  teacher: string;
  starts_at: string;
  capacity: number;
  price_cents: number;
}

export interface TrialClassWithSeats extends TrialClass {
  confirmed_count: number;
  pending_count: number;
  seats_available: number;
}

export interface Booking {
  id: string;
  student_id: string;
  trial_class_id: string;
  status: BookingStatus;
  status_reason: string | null;
  created_at: string;
  updated_at: string;
  expires_at: string | null;
  confirmed_at: string | null;
}

/** Money state, separate from the seat state on the booking. */
export type PaymentAttemptStatus = 'processing' | 'succeeded' | 'failed' | 'refunded' | 'refund_pending';

export interface PaymentAttempt {
  id: string;
  booking_id: string;
  amount_cents: number;
  currency: string;
  status: PaymentAttemptStatus;
  provider_ref: string | null;
  failure_code: string | null;
  refund_ref: string | null;
  created_at: string;
  updated_at: string;
}

export type PayOutcome =
  | 'confirmed' // charged and seat claimed
  | 'payment_failed' // provider declined; nothing charged
  | 'refunded' // charged, seat was gone, refund issued
  | 'refund_pending' // charged, seat was gone, refund call failed; the job will retry
  | 'class_full' // class filled before we charged; nothing charged
  | 'already_confirmed'; // idempotent replay of a paid booking

export interface PayResult {
  outcome: PayOutcome;
  booking: Booking;
  attempt: PaymentAttempt | null;
}

export interface RosterEntry {
  booking_id: string;
  status: BookingStatus;
  confirmed_at: string | null;
  expires_at: string | null;
  student_id: string;
  student_name: string;
  grade: string;
  parent_name: string;
  parent_email: string;
}

export interface Roster {
  trial_class: TrialClassWithSeats;
  confirmed: RosterEntry[];
  pending: RosterEntry[];
}

export interface BookingDetail {
  booking: Booking;
  student: Student;
  parent: Parent;
  trial_class: TrialClassWithSeats;
  payment_attempts: PaymentAttempt[];
}

export type ParentBookingRow = Booking & {
  student_name: string;
  class_title: string;
  starts_at: string;
  price_cents: number;
  /** Status of the latest payment attempt, so the UI can say "refund in progress". */
  payment_status: PaymentAttemptStatus | null;
};

/** Emitted after every committed write, so the HTTP layer can push live updates to open pages. */
export interface BookingChange {
  type: 'booking_created' | 'booking_updated' | 'bookings_expired';
  booking_id?: string;
  trial_class_id?: string;
  status?: BookingStatus;
  count?: number;
}

export interface ServiceOptions {
  /** Injectable clock (tests use it to fast-forward past the pending TTL). */
  now?: () => Date;
  /** How long a pending_payment booking may sit unpaid before the job expires it. */
  pendingTtlMinutes?: number;
  currency?: string;
  /** Called after each committed change (never inside a transaction). */
  onChange?: (change: BookingChange) => void;
  /** Where operational warnings go (refund failures). Defaults to console.warn. */
  log?: (message: string) => void;
}

type SeatClaim =
  | { claimed: true; booking: Booking }
  | { claimed: false; reason: string; booking: Booking };

type ClassCountsRow = TrialClass & { confirmed_count: number; pending_count: number };

// ---------------------------------------------------------------------------
// Service
// ---------------------------------------------------------------------------

export class BookingService {
  private readonly db: DB;
  private readonly provider: PaymentProvider;
  private readonly now: () => Date;
  private readonly pendingTtlMs: number;
  private readonly currency: string;
  private readonly onChange: ((change: BookingChange) => void) | undefined;
  private readonly log: (message: string) => void;

  constructor(db: DB, provider: PaymentProvider, opts: ServiceOptions = {}) {
    this.db = db;
    this.provider = provider;
    this.now = opts.now ?? (() => new Date());
    this.pendingTtlMs = (opts.pendingTtlMinutes ?? 15) * 60_000;
    this.currency = opts.currency ?? 'SGD';
    this.onChange = opts.onChange;
    this.log = opts.log ?? ((message) => console.warn(message));
  }

  // ----- Reads -------------------------------------------------------------

  listParents(): Array<Parent & { students: Student[] }> {
    const parents = this.db.prepare('SELECT * FROM parents ORDER BY name').all() as unknown as Parent[];
    const students = this.db.prepare('SELECT * FROM students ORDER BY name').all() as unknown as Student[];
    return parents.map((p) => ({ ...p, students: students.filter((s) => s.parent_id === p.id) }));
  }

  listTrialClasses(): TrialClassWithSeats[] {
    const rows = this.db.prepare(`${CLASS_WITH_COUNTS_SQL} ORDER BY c.starts_at`).all() as unknown as ClassCountsRow[];
    return rows.map(withSeats);
  }

  getTrialClass(id: string): TrialClassWithSeats | undefined {
    const row = this.db.prepare(`${CLASS_WITH_COUNTS_SQL} WHERE c.id = ?`).get(id) as unknown as ClassCountsRow | undefined;
    return row ? withSeats(row) : undefined;
  }

  getBooking(id: string): Booking | undefined {
    return this.db.prepare('SELECT * FROM bookings WHERE id = ?').get(id) as unknown as Booking | undefined;
  }

  /** Everything the status page needs: booking, who, which class, payment history. */
  getBookingDetail(id: string): BookingDetail {
    const booking = this.getBooking(id);
    if (!booking) throw notFound('Booking', id);
    const student = this.db.prepare('SELECT * FROM students WHERE id = ?').get(booking.student_id) as unknown as Student;
    const parent = this.db.prepare('SELECT * FROM parents WHERE id = ?').get(student.parent_id) as unknown as Parent;
    const trial_class = this.getTrialClass(booking.trial_class_id)!;
    const payment_attempts = this.db
      .prepare('SELECT * FROM payment_attempts WHERE booking_id = ? ORDER BY created_at')
      .all(id) as unknown as PaymentAttempt[];
    return { booking, student, parent, trial_class, payment_attempts };
  }

  listBookingsForParent(parentId: string): ParentBookingRow[] {
    return this.db
      .prepare(
        `SELECT b.*, s.name AS student_name, c.title AS class_title, c.starts_at, c.price_cents,
                (SELECT pa.status FROM payment_attempts pa
                  WHERE pa.booking_id = b.id ORDER BY pa.created_at DESC LIMIT 1) AS payment_status
           FROM bookings b
           JOIN students s ON s.id = b.student_id
           JOIN trial_classes c ON c.id = b.trial_class_id
          WHERE s.parent_id = ?
          ORDER BY b.created_at DESC`,
      )
      .all(parentId) as unknown as ParentBookingRow[];
  }

  /** Roster for the teacher/admin: who is confirmed, plus who is mid-checkout. */
  getRoster(trialClassId: string): Roster {
    const trial_class = this.getTrialClass(trialClassId);
    if (!trial_class) throw notFound('Trial class', trialClassId);
    const rows = this.db
      .prepare(
        `SELECT b.id AS booking_id, b.status, b.confirmed_at, b.expires_at,
                s.id AS student_id, s.name AS student_name, s.grade,
                p.name AS parent_name, p.email AS parent_email
           FROM bookings b
           JOIN students s ON s.id = b.student_id
           JOIN parents p ON p.id = s.parent_id
          WHERE b.trial_class_id = ? AND b.status IN ('confirmed', 'pending_payment')
          ORDER BY b.confirmed_at, b.created_at`,
      )
      .all(trialClassId) as unknown as RosterEntry[];
    return {
      trial_class,
      confirmed: rows.filter((r) => r.status === 'confirmed'),
      pending: rows.filter((r) => r.status === 'pending_payment'),
    };
  }

  listRosters(): Roster[] {
    return this.listTrialClasses().map((c) => this.getRoster(c.id));
  }

  // ----- Writes ------------------------------------------------------------

  /**
   * Step 1 of the flow: the parent picks a child and a class and submits.
   * Creates a `pending_payment` booking. It does NOT hold a seat (see README
   * for why); it just gives the payment step something to attach to.
   *
   * Runs in a write transaction so "check duplicate + check capacity + insert"
   * is atomic even with a second app process on the same database.
   */
  createBooking(input: { studentId: string; trialClassId: string }): { booking: Booking; reused: boolean } {
    const result = transaction(this.db, () => {
      const student = this.db.prepare('SELECT * FROM students WHERE id = ?').get(input.studentId) as unknown as
        | Student
        | undefined;
      if (!student) throw notFound('Student', input.studentId);
      const cls = this.getTrialClass(input.trialClassId);
      if (!cls) throw notFound('Trial class', input.trialClassId);

      // Duplicate check (friendly version; the partial unique index is the hard one).
      const existing = this.db
        .prepare(
          `SELECT * FROM bookings
            WHERE student_id = ? AND trial_class_id = ? AND status IN ('pending_payment', 'confirmed')`,
        )
        .get(student.id, cls.id) as unknown as Booking | undefined;
      if (existing?.status === 'confirmed') {
        throw new AppError(409, 'DUPLICATE_BOOKING', `${student.name} already has a confirmed seat in "${cls.title}"`, {
          booking_id: existing.id,
        });
      }
      if (existing) {
        // Same child, same class, still unpaid: resume that checkout instead of
        // creating a second pending booking (handles double-submit / refresh).
        return { booking: existing, reused: true };
      }

      // Capacity check (early feedback only; the seat is claimed at payment time).
      if (cls.confirmed_count >= cls.capacity) {
        throw new AppError(409, 'CLASS_FULL', `"${cls.title}" is full (${cls.confirmed_count}/${cls.capacity} confirmed)`);
      }

      const nowIso = this.nowIso();
      const booking: Booking = {
        id: randomUUID(),
        student_id: student.id,
        trial_class_id: cls.id,
        status: 'pending_payment',
        status_reason: null,
        created_at: nowIso,
        updated_at: nowIso,
        expires_at: new Date(this.now().getTime() + this.pendingTtlMs).toISOString(),
        confirmed_at: null,
      };
      try {
        this.db
          .prepare(
            `INSERT INTO bookings (id, student_id, trial_class_id, status, status_reason, created_at, updated_at, expires_at, confirmed_at)
             VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            booking.id,
            booking.student_id,
            booking.trial_class_id,
            booking.status,
            booking.status_reason,
            booking.created_at,
            booking.updated_at,
            booking.expires_at,
            booking.confirmed_at,
          );
      } catch (err) {
        if (isSqliteError(err, 'UNIQUE constraint failed')) {
          throw new AppError(409, 'DUPLICATE_BOOKING', `${student.name} already has an active booking for "${cls.title}"`);
        }
        throw err;
      }
      return { booking, reused: false };
    });
    if (!result.reused) {
      this.emit({
        type: 'booking_created',
        booking_id: result.booking.id,
        trial_class_id: result.booking.trial_class_id,
        status: result.booking.status,
      });
    }
    return result;
  }

  /**
   * Step 2 of the flow: take payment, then claim the seat.
   *
   *   1. Fail fast if the class is already full (do not charge the card).
   *   2. Charge the card. This awaits the provider, so two parents paying for
   *      the same last seat interleave *here*.
   *   3. Claim the seat in one write transaction (re-check capacity, flip to
   *      confirmed). Exactly one of the competing bookings wins.
   *   4. The loser is refunded and marked `refunded`; the roster never saw it.
   *
   * Idempotent: paying an already-confirmed booking is a no-op that returns
   * the confirmed booking (safe for retried requests / duplicate webhooks).
   */
  async pay(input: { bookingId: string; card: string; delayMs?: number }): Promise<PayResult> {
    const result = await this.payInner(input);
    if (result.outcome !== 'already_confirmed') {
      this.emit({
        type: 'booking_updated',
        booking_id: result.booking.id,
        trial_class_id: result.booking.trial_class_id,
        status: result.booking.status,
      });
    }
    return result;
  }

  private async payInner(input: { bookingId: string; card: string; delayMs?: number }): Promise<PayResult> {
    const booking = this.getBooking(input.bookingId);
    if (!booking) throw notFound('Booking', input.bookingId);
    if (booking.status === 'confirmed') {
      return { outcome: 'already_confirmed', booking, attempt: this.latestAttempt(booking.id) };
    }
    if (booking.status !== 'pending_payment') {
      throw new AppError(409, 'BOOKING_NOT_PAYABLE', `Booking is ${booking.status}; only pending_payment bookings can be paid`, {
        status: booking.status,
        status_reason: booking.status_reason,
      });
    }
    const cls = this.getTrialClass(booking.trial_class_id)!;

    // (1) Fail fast: never charge for a seat that is already gone.
    if (cls.confirmed_count >= cls.capacity) {
      const cancelled = this.setStatus(booking.id, 'cancelled', 'class_full_before_payment');
      return { outcome: 'class_full', booking: cancelled, attempt: null };
    }

    // (2) Charge. Creating the attempt row and checking for an in-flight one is
    // atomic, so a double-click cannot charge twice.
    const attempt = transaction(this.db, () => {
      const inFlight = this.db
        .prepare(`SELECT id FROM payment_attempts WHERE booking_id = ? AND status = 'processing'`)
        .get(booking.id);
      if (inFlight) throw new AppError(409, 'PAYMENT_IN_PROGRESS', 'A payment for this booking is already being processed');
      return this.insertAttempt(booking.id, cls.price_cents);
    });

    const result = await this.provider.charge({
      amountCents: cls.price_cents,
      currency: this.currency,
      card: input.card,
      idempotencyKey: attempt.id,
      metadata: { bookingId: booking.id },
      delayMs: input.delayMs,
    });

    if (!result.ok) {
      const failed = this.updateAttempt(attempt.id, { status: 'failed', failure_code: result.failureCode });
      const updated = this.setStatus(booking.id, 'payment_failed', result.failureCode);
      return { outcome: 'payment_failed', booking: updated, attempt: failed };
    }
    const paid = this.updateAttempt(attempt.id, { status: 'succeeded', provider_ref: result.providerRef });

    // (3) Claim the seat atomically.
    const claim = this.claimSeat(booking.id);
    if (claim.claimed) {
      return { outcome: 'confirmed', booking: claim.booking, attempt: paid };
    }

    // (4) Lost the race (or the booking stopped being pending while we were
    // charging). Money goes back; the roster is never touched. If the refund
    // call itself fails, the attempt is parked as refund_pending and the
    // reconcile job retries it; the seat outcome is the same either way.
    const refund = await this.tryRefund(attempt.id, result.providerRef, cls.price_cents);
    if (claim.reason === 'already_confirmed') {
      // Defensive: a second successful charge for an already-confirmed booking.
      return { outcome: 'already_confirmed', booking: claim.booking, attempt: refund.attempt };
    }
    const status = refund.ok ? 'refunded' : 'refund_pending';
    const updated = this.setStatus(booking.id, status, claim.reason);
    return { outcome: status, booking: updated, attempt: refund.attempt };
  }

  /** Cancel a pending or confirmed booking. A confirmed cancellation frees the seat and refunds. */
  async cancelBooking(bookingId: string, reason: string = 'cancelled_by_user'): Promise<Booking> {
    const booking = this.getBooking(bookingId);
    if (!booking) throw notFound('Booking', bookingId);
    if (booking.status !== 'pending_payment' && booking.status !== 'confirmed') {
      throw new AppError(409, 'BOOKING_NOT_CANCELLABLE', `Booking is already ${booking.status}`, { status: booking.status });
    }
    // The seat is released no matter what; the money follows, retried by the job if needed.
    const paid = this.latestAttempt(bookingId);
    if (paid?.status === 'succeeded' && paid.provider_ref) {
      await this.tryRefund(paid.id, paid.provider_ref, paid.amount_cents);
    }
    const updated = this.setStatus(bookingId, 'cancelled', reason);
    this.emit({ type: 'booking_updated', booking_id: updated.id, trial_class_id: updated.trial_class_id, status: updated.status });
    return updated;
  }

  /**
   * Background job: release pending bookings whose checkout window has passed.
   * Skips bookings with a charge in flight so we never expire something that
   * is about to be confirmed.
   */
  expirePendingBookings(): { expired: number } {
    const nowIso = this.nowIso();
    const res = this.db
      .prepare(
        `UPDATE bookings
            SET status = 'expired', status_reason = 'checkout_window_elapsed', updated_at = ?
          WHERE status = 'pending_payment'
            AND expires_at <= ?
            AND NOT EXISTS (SELECT 1 FROM payment_attempts pa
                             WHERE pa.booking_id = bookings.id AND pa.status = 'processing')`,
      )
      .run(nowIso, nowIso);
    const expired = Number(res.changes);
    if (expired > 0) this.emit({ type: 'bookings_expired', count: expired });
    return { expired };
  }

  /**
   * Background job: retry refunds the provider failed to process. Safe to run
   * often. A refund that goes through moves the attempt to `refunded` and, for
   * a booking that lost the last seat, the booking from refund_pending to
   * refunded. Cancelled bookings stay cancelled; only their money state changes.
   */
  async retryPendingRefunds(): Promise<{ retried: number; refunded: number; still_pending: number }> {
    const pending = this.db
      .prepare(`SELECT * FROM payment_attempts WHERE status = 'refund_pending' ORDER BY created_at`)
      .all() as unknown as PaymentAttempt[];
    let refunded = 0;
    for (const attempt of pending) {
      if (!attempt.provider_ref) continue;
      const res = await this.tryRefund(attempt.id, attempt.provider_ref, attempt.amount_cents);
      if (!res.ok) continue;
      refunded++;
      const booking = this.getBooking(attempt.booking_id)!;
      const updated =
        booking.status === 'refund_pending' ? this.setStatus(booking.id, 'refunded', booking.status_reason) : booking;
      this.emit({ type: 'booking_updated', booking_id: updated.id, trial_class_id: updated.trial_class_id, status: updated.status });
    }
    return { retried: pending.length, refunded, still_pending: pending.length - refunded };
  }

  // ----- Internals ---------------------------------------------------------

  /**
   * The critical section. Everything inside runs under SQLite's writer lock
   * (BEGIN IMMEDIATE) and is synchronous, so no other confirmation can slip
   * between the count and the update. If application logic ever got this
   * wrong, the trg_capacity_* trigger and the partial unique index would still
   * reject the write; both are translated into a "not claimed" result.
   */
  private claimSeat(bookingId: string): SeatClaim {
    return transaction(this.db, () => {
      const fresh = this.getBooking(bookingId)!;
      if (fresh.status === 'confirmed') return { claimed: false, reason: 'already_confirmed', booking: fresh };
      if (fresh.status !== 'pending_payment') return { claimed: false, reason: `booking_${fresh.status}`, booking: fresh };

      const cls = this.getTrialClass(fresh.trial_class_id)!;
      if (cls.confirmed_count >= cls.capacity) return { claimed: false, reason: 'seat_taken', booking: fresh };

      const nowIso = this.nowIso();
      try {
        this.db
          .prepare(
            `UPDATE bookings
                SET status = 'confirmed', status_reason = NULL, confirmed_at = ?, updated_at = ?
              WHERE id = ? AND status = 'pending_payment'`,
          )
          .run(nowIso, nowIso, bookingId);
      } catch (err) {
        if (isSqliteError(err, 'CLASS_FULL')) return { claimed: false, reason: 'seat_taken', booking: fresh };
        if (isSqliteError(err, 'UNIQUE constraint failed')) return { claimed: false, reason: 'duplicate_booking', booking: fresh };
        throw err;
      }
      return { claimed: true, booking: this.getBooking(bookingId)! };
    });
  }

  /**
   * Refund a successful charge. Never throws: a provider outage parks the
   * attempt as refund_pending (with failure_code = refund_failed) for the
   * reconcile job, so a refund can be delayed but never forgotten.
   */
  private async tryRefund(
    attemptId: string,
    providerRef: string,
    amountCents: number,
  ): Promise<{ ok: boolean; attempt: PaymentAttempt }> {
    try {
      const { refundRef } = await this.provider.refund(providerRef, amountCents);
      return { ok: true, attempt: this.updateAttempt(attemptId, { status: 'refunded', refund_ref: refundRef }) };
    } catch (err) {
      this.log(`[payments] refund of ${providerRef} failed (${err instanceof Error ? err.message : String(err)}); parked for retry`);
      return { ok: false, attempt: this.updateAttempt(attemptId, { status: 'refund_pending', failure_code: 'refund_failed' }) };
    }
  }

  private setStatus(bookingId: string, status: BookingStatus, reason: string | null): Booking {
    this.db
      .prepare('UPDATE bookings SET status = ?, status_reason = ?, updated_at = ? WHERE id = ?')
      .run(status, reason, this.nowIso(), bookingId);
    return this.getBooking(bookingId)!;
  }

  private insertAttempt(bookingId: string, amountCents: number): PaymentAttempt {
    const nowIso = this.nowIso();
    const attempt: PaymentAttempt = {
      id: randomUUID(),
      booking_id: bookingId,
      amount_cents: amountCents,
      currency: this.currency,
      status: 'processing',
      provider_ref: null,
      failure_code: null,
      refund_ref: null,
      created_at: nowIso,
      updated_at: nowIso,
    };
    this.db
      .prepare(
        `INSERT INTO payment_attempts (id, booking_id, amount_cents, currency, status, provider_ref, failure_code, refund_ref, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        attempt.id,
        attempt.booking_id,
        attempt.amount_cents,
        attempt.currency,
        attempt.status,
        attempt.provider_ref,
        attempt.failure_code,
        attempt.refund_ref,
        attempt.created_at,
        attempt.updated_at,
      );
    return attempt;
  }

  private updateAttempt(
    attemptId: string,
    patch: { status: PaymentAttemptStatus; provider_ref?: string; failure_code?: string; refund_ref?: string },
  ): PaymentAttempt {
    this.db
      .prepare(
        `UPDATE payment_attempts
            SET status = ?,
                provider_ref = COALESCE(?, provider_ref),
                failure_code = COALESCE(?, failure_code),
                refund_ref   = COALESCE(?, refund_ref),
                updated_at   = ?
          WHERE id = ?`,
      )
      .run(
        patch.status,
        patch.provider_ref ?? null,
        patch.failure_code ?? null,
        patch.refund_ref ?? null,
        this.nowIso(),
        attemptId,
      );
    return this.db.prepare('SELECT * FROM payment_attempts WHERE id = ?').get(attemptId) as unknown as PaymentAttempt;
  }

  private latestAttempt(bookingId: string): PaymentAttempt | null {
    const row = this.db
      .prepare('SELECT * FROM payment_attempts WHERE booking_id = ? ORDER BY created_at DESC LIMIT 1')
      .get(bookingId) as unknown as PaymentAttempt | undefined;
    return row ?? null;
  }

  private nowIso(): string {
    return this.now().toISOString();
  }

  private emit(change: BookingChange): void {
    if (!this.onChange) return;
    try {
      this.onChange(change);
    } catch (err) {
      console.error('onChange listener failed', err);
    }
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const CLASS_WITH_COUNTS_SQL = `
  SELECT c.*,
         (SELECT COUNT(*) FROM bookings b WHERE b.trial_class_id = c.id AND b.status = 'confirmed')       AS confirmed_count,
         (SELECT COUNT(*) FROM bookings b WHERE b.trial_class_id = c.id AND b.status = 'pending_payment') AS pending_count
    FROM trial_classes c`;

function withSeats(row: ClassCountsRow): TrialClassWithSeats {
  return { ...row, seats_available: Math.max(0, row.capacity - row.confirmed_count) };
}
