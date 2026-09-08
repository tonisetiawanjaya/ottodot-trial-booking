# Ottodot Trial Booking

A small, correct slice of a trial-class booking system: a parent picks a child and a trial class, pays (mock), and sees the booking status; a teacher/admin sees the roster. Trial classes are capped at 4 confirmed students.

The interesting part is not the UI but the invariants:

| Invariant | Enforced by |
|---|---|
| A child never has two confirmed bookings for the same class | partial unique index + service check |
| A class never has more than 4 confirmed students | capacity trigger + serialized seat claim |
| A failed payment never puts a child on the roster | seat is only claimed *after* a successful charge |
| Two users racing for the last seat: at most one wins, the other is refunded | one write transaction per confirmation, loser refunded |

**Stack:** Node.js (≥ 22.18, tested on 24) + TypeScript, SQLite via the built-in `node:sqlite`, a ~150-line HTTP layer over `node:http`, vanilla HTML/JS. **Zero runtime dependencies**, so `npm start` works without `npm install`.

---

## Run it

```bash
npm start            # seeds data/ottodot.sqlite on first run, serves http://localhost:3000
npm test             # 37 tests (node:test), ~1 s
npm run demo:race    # narrated CLI walkthrough of the last-seat race + other edge cases
npm run seed         # reset the on-disk database to the seed state
npm install && npm run typecheck   # optional: dev-only deps (typescript, @types/node)
```

- Parent UI: <http://localhost:3000/>
- Admin/teacher roster: <http://localhost:3000/admin>
- Raw API: <http://localhost:3000/api/trial-classes>

### 90-second reviewer path

1. `npm run demo:race` — prints the race step by step and checks the invariant.
2. `npm start`, open **two browser tabs** on `/`.
   - Tab A: parent *Maria Santos* → Sofia → **P4 Math** (1 seat left) → Book trial → tick *Simulate a slow payment network* → Pay.
   - Tab B (within 4 s): parent *Daniel Lim* → Lucas → **P4 Math** → Book trial → Pay (not slow).
   - Tab B shows **Confirmed**. Tab A then shows **Refunded — the last seat was taken while you were paying**.
   - `/admin` shows P4 Math at 4/4 with Lucas, not Sofia.
3. Other seeded cases: *Aisha Tan → Ethan → P4 Math* gives **409 duplicate** (Ethan is already confirmed); P6 Science is **Full**; Daniel Lim's list shows Lucas's earlier **payment failed** booking; pay with the *declined* test card to reproduce it.

---

## What I built

- **Parent flow**: choose a child → pick an available class → submit booking (`pending_payment`) → mock payment → status page. A family's bookings and statuses are listed, and an unpaid booking can be resumed.
- **Mock payment**: Stripe-style test cards (`…4242` succeeds, `…0002` declined, `…9995` insufficient funds). Every attempt is recorded in `payment_attempts`, including refunds. A "slow network" toggle exists purely to make the race reproducible by hand.
- **Roster**: `/admin` page and `GET /api/admin/roster` — confirmed students per class, plus who is mid-checkout (explicitly *not* on the roster). Admin can cancel a booking (frees the seat, refunds) and run the expiry job.
- **Background job**: pending bookings older than 15 minutes are expired once a minute (also callable via API).
- **Tests**: 37 tests over the service, the raw database constraints, and real HTTP.

### Time spent

<!-- TODO: fill in your actual number before submitting -->
~3.5 hours, in line with the 3–4 hour timebox.

### Assumptions

- **No authentication.** The UI has a "signed in as" parent picker. In production, the parent id would come from the session and `student_id` would be validated against it.
- **The payment provider is synchronous and in-process.** `charge()` resolves with success/decline; `refund()` always succeeds. A real provider is asynchronous (webhooks); see *Tradeoffs* for how the design carries over.
- **A pending booking does not hold a seat.** Availability = `capacity − confirmed`. The 15-minute window only bounds how long a pending row lives before cleanup.
- **Terminal statuses are terminal.** After `payment_failed`, `refunded`, `expired`, or `cancelled`, a parent books again with a *new* booking; the old row stays as history. This keeps the state machine tiny.
- **Losing the race is refunded automatically and in full.** No waitlist.
- **One app process, one SQLite file** is the deployment target for this exercise; the SQL is written so the same invariants hold on Postgres (noted inline below).
- Prices are per class in SGD cents; a trial costs S$20–25. Only trial booking exists; no regular enrollment.

---

## Backend design

### Data model

```
parents (id, name, email UNIQUE)
students (id, parent_id → parents, name, grade)
trial_classes (id, subject, title, teacher, starts_at, capacity = 4, price_cents)
bookings (id, student_id → students, trial_class_id → trial_classes,
          status CHECK IN (pending_payment | confirmed | payment_failed | refunded | expired | cancelled),
          status_reason, created_at, updated_at, expires_at, confirmed_at)
payment_attempts (id, booking_id → bookings, amount_cents, currency,
          status CHECK IN (processing | succeeded | failed | refunded),
          provider_ref, failure_code, refund_ref, created_at, updated_at)
```

Two schema-level guards do the real work ([src/db.ts](src/db.ts)):

```sql
-- Invariant 1: one ACTIVE booking per (child, class). Terminal rows are history and don't count.
CREATE UNIQUE INDEX ux_bookings_one_active_per_student_class
  ON bookings (student_id, trial_class_id)
  WHERE status IN ('pending_payment', 'confirmed');

-- Invariant 2: a row can only become `confirmed` while confirmed < capacity.
CREATE TRIGGER trg_capacity_on_update BEFORE UPDATE OF status ON bookings
WHEN NEW.status = 'confirmed' AND OLD.status <> 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'CLASS_FULL')
  WHERE (SELECT COUNT(*) FROM bookings WHERE trial_class_id = NEW.trial_class_id AND status = 'confirmed')
        >= (SELECT capacity FROM trial_classes WHERE id = NEW.trial_class_id);
END;  -- (same trigger on INSERT)
```

[test/db-invariants.test.ts](test/db-invariants.test.ts) bypasses the service and proves that raw SQL cannot violate either one.

### Booking statuses

| Status | Meaning | Occupies a seat? |
|---|---|---|
| `pending_payment` | Submitted, not yet paid. Expires after 15 min. | No |
| `confirmed` | Charge succeeded **and** the seat was claimed in the same transaction. | **Yes** |
| `payment_failed` | Provider declined (`status_reason` = failure code). | No |
| `refunded` | Charge succeeded but the seat was gone (`seat_taken`) or the booking was no longer pending; refund issued. | No |
| `expired` | Left unpaid past the checkout window (background job). | No |
| `cancelled` | Cancelled by parent/admin, or the class filled before we charged (`class_full_before_payment`). | No |

```
pending_payment ──pay ok + seat claimed──▶ confirmed ──cancel──▶ cancelled (seat released, refunded)
      │
      ├──provider declined─────────────────▶ payment_failed
      ├──pay ok but seat gone → refund─────▶ refunded
      ├──class full before charge──────────▶ cancelled
      ├──cancelled by parent───────────────▶ cancelled
      └──15 min elapsed (job)──────────────▶ expired
```

### API

| Method & path | Purpose |
|---|---|
| `GET /api/parents` | Parents with their children (demo "sign-in"). |
| `GET /api/parents/:id/bookings` | A family's bookings and statuses. |
| `GET /api/trial-classes` | Classes with `confirmed_count`, `pending_count`, `seats_available`. |
| `POST /api/bookings` `{student_id, trial_class_id}` | Create a `pending_payment` booking. `201`; `200 {reused:true}` if that child already has an unpaid booking for the class; `409 DUPLICATE_BOOKING` / `409 CLASS_FULL`. |
| `POST /api/bookings/:id/pay` `{card, delay_ms?}` | Charge, then claim the seat. Returns `{outcome, booking, attempt}` with outcome ∈ `confirmed`, `payment_failed`, `refunded`, `class_full`, `already_confirmed`. Idempotent. |
| `GET /api/bookings/:id` | Booking + child + class + payment history (status page). |
| `POST /api/bookings/:id/cancel` | Cancel pending/confirmed; refunds if paid. |
| `GET /api/admin/roster` · `GET /api/admin/trial-classes/:id/roster` | Confirmed roster (+ mid-checkout list) per class. |
| `POST /api/admin/jobs/expire-pending` | Run the expiry job now. |

The service layer ([src/booking-service.ts](src/booking-service.ts)) is the API; the HTTP file only maps requests to `createBooking`, `pay`, `cancelBooking`, `expirePendingBookings`, `getRoster`.

### How duplicate bookings are prevented

1. **Service**: `createBooking` runs in a write transaction; if the child already has an *active* booking for the class it either returns the existing pending one (double-submit → resume checkout) or throws `409 DUPLICATE_BOOKING` (already confirmed).
2. **Database**: the partial unique index makes a second active row impossible, whatever the code does; the constraint error is mapped to the same 409.
3. **Confirmation time**: `claimSeat` runs `UPDATE … SET status='confirmed'` — if that ever hit the unique index, the booking is refunded instead of confirmed.

### How payment failure is handled

`pay()` creates a `payment_attempts` row (`processing`), calls the provider, and only *after* a successful charge attempts to claim the seat. On decline: attempt → `failed` with the code, booking → `payment_failed`, nothing else changes. The roster query only reads `status = 'confirmed'`, so a failed booking is invisible to the teacher by construction. The parent books again with a fresh booking; the failed row remains as audit history.

### The last-seat race

> A selects the last seat and moves to payment. B selects the same seat. B pays first and confirms. A then tries to pay.

**Approach: claim the seat at confirmation time, inside one serialized write transaction, and refund the loser.**

```
A: createBooking ─▶ pending          A: charge (in flight) ─────────────▶ claimSeat: confirmed=4 ≥ 4 → seat_taken → refund → refunded
B: createBooking ─▶ pending          B: charge ─▶ ok ─▶ claimSeat: 3 < 4 → UPDATE → confirmed ✔
                                       ^ interleaving happens here      ^ BEGIN IMMEDIATE: count + update are atomic
```

Concretely, in [src/booking-service.ts](src/booking-service.ts) `pay()`:

1. **Fail fast** — if the class is already full before we charge, the booking is cancelled (`class_full_before_payment`) and the card is never touched. This closes the common case (B finished well before A pressed Pay) at zero cost.
2. **Charge** — awaits the provider. This is the only place two competing requests interleave.
3. **Claim** — `claimSeat()` opens `BEGIN IMMEDIATE` (SQLite's writer lock), re-reads the booking, counts confirmed seats, and flips the row to `confirmed`. Because the transaction holds the write lock and the block is synchronous, no other confirmation can slip between the count and the update. If the count is already at capacity, it returns `seat_taken` without writing.
4. **Refund** — the loser's charge is refunded, the attempt is marked `refunded`, the booking becomes `refunded` with `status_reason = seat_taken`. The roster never saw it.

Even if step 3's application logic were wrong, the capacity trigger would abort the `UPDATE` and the code treats that abort as `seat_taken`. [test/last-seat-race.test.ts](test/last-seat-race.test.ts) scripts the exact interleaving from the brief with a controllable provider (B settles first, then A), the symmetric case, the fail-fast case, a declined winner, and a 12-way burst for one seat; [test/api.test.ts](test/api.test.ts) repeats it over real HTTP with two concurrent requests.

**Why this approach**

- The seat is granted at the only moment that matters — when money has actually moved — so `confirmed` is always backed by a successful charge, and a pending or failed booking can never occupy a seat.
- The critical section is one short transaction on one row group; it needs no distributed lock, queue, or counter column that can drift.
- The hard invariants live in the schema, so a second process, a hotfix script, or a future bug cannot exceed capacity or double-book.

**Tradeoffs I accepted**

- **A user can be charged and then refunded.** The fail-fast check makes this rare (only when B confirms *during* A's provider round-trip), but it can happen. The alternative — holding a seat while the user pays — was deliberately not chosen: with only 4 seats, abandoned checkouts would block real parents for the length of the hold, and a hold *still* needs the same atomic claim at the end. If refunds turned out to be frequent, I would add a short hold (5 min, counted in `seats_available`) on top of this design rather than instead of it.
- **Pending bookings are not reflected in availability**, so two parents can both start paying for one seat. The UI says so ("a seat is only taken once payment succeeds").
- **SQLite serializes all writers**, which makes the transaction trivially correct but means one writer at a time. On Postgres the same code needs one line more: `SELECT … FROM trial_classes WHERE id = ? FOR UPDATE` at the top of `claimSeat` (a per-class row lock), or `SERIALIZABLE` with a retry. The partial unique index is identical; the trigger becomes a `plpgsql` trigger or a `confirmed_count` column updated with `UPDATE … WHERE confirmed_count < capacity` as a compare-and-swap.
- **Synchronous provider.** With webhooks, `pay()` splits in two: the HTTP handler creates the attempt and the provider intent; the webhook handler (idempotent on `provider_ref`) runs steps 3–4. The seat claim and refund logic do not change.

### Which checks live where

| Layer | Checks | Role |
|---|---|---|
| **UI** | "Book" disabled when `seats_available = 0` or no child selected; Pay button disabled while a request is in flight; friendly copy per outcome | Convenience only. Never trusted. |
| **Backend (service)** | Duplicate/active-booking check, class-full pre-check, `pay` idempotency (`already_confirmed`, `PAYMENT_IN_PROGRESS`), state-transition rules, refund on lost race, `expires_at` | Turns invariants into good errors and correct money movement. |
| **Database** | Partial unique index (one active booking per child+class), capacity trigger (confirmed ≤ capacity), status `CHECK`s, FKs, `BEGIN IMMEDIATE` serialization | The guarantees. Hold even under bugs or multiple processes. |
| **Background job** | Expire `pending_payment` past `expires_at` (skipping ones with a charge in flight). Next: reconcile attempts stuck in `processing` against the provider; alert if any class has confirmed > capacity | Cleanup and self-healing; never the primary guard. |

---

## Tests and verification

```bash
npm test
```

| File | Covers |
|---|---|
| [test/booking.test.ts](test/booking.test.ts) | Seed scenarios, happy path, payment failure + retry, duplicates, overbooking, expiry job, cancellation, idempotency, validation |
| [test/last-seat-race.test.ts](test/last-seat-race.test.ts) | The required scenario with a step-controlled provider, symmetry, fail-fast, declined winner, 12-way burst |
| [test/db-invariants.test.ts](test/db-invariants.test.ts) | Raw SQL cannot insert a 5th confirmed row or a duplicate active row; rollback |
| [test/api.test.ts](test/api.test.ts) | Full flow over HTTP, 409s, declined card, concurrent race with two real requests, validation |

Tests use an in-memory SQLite database, the real seed, and an injected clock. `ControlledProvider` in [test/helpers.ts](test/helpers.ts) lets a test decide exactly when each user's payment completes, which is what makes the race deterministic.

Manual verification: the two-tab flow under *90-second reviewer path*, and `npm run demo:race`.

---

## What I deliberately cut

- Authentication/authorization (parent picker instead), and any admin login for `/admin`.
- A real payment provider, webhooks, and 3-D Secure; partial refunds; payment retries on the *same* booking.
- Seat holds / waitlist, email or WhatsApp notifications, class reminders.
- Regular enrollment, pricing rules, discounts.
- A frontend framework, build step, CSS framework; migrations tooling (schema is `CREATE IF NOT EXISTS`).
- Multi-process deployment (SQLite in WAL mode is fine for one server; see the Postgres notes above).

## What I would monitor after release

- **Invariant canaries** (should always be zero): classes with `confirmed > capacity`; children with two active bookings for one class; `confirmed` bookings without a `succeeded` attempt.
- **Race rate**: bookings ending `refunded/seat_taken` per day. If it is more than a handful, add seat holds.
- **Payment funnel**: `pending_payment → confirmed` conversion, decline rate by failure code, `expired` count (abandoned checkouts).
- **Money safety**: attempts stuck in `processing` for more than a few minutes (server died mid-charge → reconcile with the provider), refund failures.
- **Ops**: p95 latency of `/pay`, 5xx rate, SQLite `busy` errors, job run frequency.

## What I would do next with more time

1. Postgres + row lock (`FOR UPDATE`) and a proper migration tool; run two app instances against it and re-run the burst test across processes.
2. Real provider integration with webhooks and an idempotent webhook handler keyed on `provider_ref`; a reconcile job for `processing` attempts.
3. Optional short seat hold reflected in `seats_available`, with a waitlist when the last seat is contested.
4. Auth (parent session, admin role), rate limiting on `/pay`, structured logging with booking ids.
5. Notifications on `confirmed` / `refunded`, and a teacher view that exports the roster.

---

## Project layout

```
src/
  db.ts                schema (index + triggers), openDb, transaction()
  booking-service.ts   all business rules: createBooking, pay, claimSeat, cancel, expire, roster
  payments.ts          PaymentProvider port + MockPaymentProvider (test cards, optional delay)
  seed.ts              synthetic dataset + `npm run seed`
  server.ts            tiny router over node:http, static files, background job, main()
  errors.ts            AppError (HTTP status + code)
public/                parent UI (index.html, app.js), admin roster (admin.html, admin.js), style.css
test/                  node:test suites + helpers (ControlledProvider, fixed clock)
scripts/demo-race.ts   narrated CLI demo
AI_USAGE.md            how AI tools were used
```
