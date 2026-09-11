# Ottodot Trial Booking

> **Video walkthrough (6 min 38 s):** https://youtu.be/s2BQIimzGPc

[![CI](https://github.com/tonisetiawanjaya/ottodot-trial-booking/actions/workflows/ci.yml/badge.svg)](https://github.com/tonisetiawanjaya/ottodot-trial-booking/actions/workflows/ci.yml)

A small, correct slice of a trial-class booking system: a parent logs in, picks a child and a trial class, pays (mock), and sees the booking status; a teacher/admin logs in and sees the roster update live. Trial classes are capped at 4 confirmed students.

The interesting part is not the UI but the invariants:

| Invariant | Enforced by |
|---|---|
| A child never has two confirmed bookings for the same class | partial unique index + service check |
| A class never has more than 4 confirmed students | capacity trigger + serialized seat claim |
| A failed payment never puts a child on the roster | seat is only claimed *after* a successful charge |
| Two users racing for the last seat: at most one wins, the other is refunded | one write transaction per confirmation, loser refunded |
| A refund the provider fails to process is never forgotten | attempt parked as `refund_pending`, retried by a job |
| A parent can only act on their own children and bookings | session + ownership checks in the HTTP layer |

**Stack:** Node.js (≥ 22.13, tested on 24) + TypeScript, SQLite via the built-in `node:sqlite`, a ~250-line HTTP layer over `node:http` (router, cookie sessions, Server-Sent Events, static files), vanilla HTML/JS. **Zero runtime dependencies**, so `npm start` works without `npm install`.

---

## Run it

**Requirements: Node.js 22.13 or newer (24 recommended; an `.nvmrc` is included).** Two built-in features do the work that dependencies usually do: `node:sqlite` (built in since 22.13) and TypeScript type stripping (22.6+ behind `--experimental-strip-types`, which every script passes; default since 22.18). Each `npm` script checks the version first and prints exactly what to do if it is too old. No `npm install` is needed to run or test.

```bash
npm start            # seeds data/ottodot.sqlite on first run, serves http://localhost:3000
npm test             # 49 tests (node:test), ~1.5 s
npm run demo:race    # narrated CLI walkthrough of the last-seat race + other edge cases
npm run seed         # reset the on-disk database to the seed state
npm install && npm run typecheck   # optional: dev-only deps (typescript, @types/node)
```

Two zero-install routes if the host has no suitable Node. Open the repo in **GitHub Codespaces** (green *Code* button, *Codespaces* tab, *Create codespace on main*): Node is pinned to 24, the test suite runs once while the container builds, and port 3000 is forwarded, so `npm start` gives you the app in a browser tab. Or build the included image: `docker build -t ottodot . && docker run -p 3000:3000 ottodot`.

- Log in: <http://localhost:3000/login>
- Parent UI: <http://localhost:3000/> · Admin/teacher roster: <http://localhost:3000/admin>
- Raw API: <http://localhost:3000/api/trial-classes>

### Demo accounts

| Username | Password | Who |
|---|---|---|
| `maria` | `parent123` | Maria Santos: Sofia (P4) |
| `daniel` | `parent123` | Daniel Lim: Lucas (P5), Ben (P6) |
| `aisha` | `parent123` | Aisha Tan: Ethan (P4, already confirmed in P4 Math), Chloe (P6) |
| `priya` | `parent123` | Priya Nair: Ravi (P4), Arjun (P6) |
| `wei` | `parent123` | Wei Chen: Mei (P4), Hana (P6) |
| `admin` | `admin123` | Ottodot staff: rosters, cancellations, background jobs |

The same list is under "Demo accounts" on the login page. Sessions are cookies, so **two different parents need two different browsers** (or a normal and a private window).

### 90-second reviewer path

1. `npm run demo:race` prints the race step by step and checks the invariant.
2. `npm start`. Browser 1: log in as **maria** → Sofia → **P4 Math** (1 seat left) → Book trial → tick *Simulate a slow payment network* → Pay. Browser 2 (within 8 s): log in as **daniel** → Lucas → **P4 Math** → Book trial → Pay.
   - Browser 2 shows **Confirmed**; browser 1's page flips to "the last seat was just taken" the same instant (live update), then shows **Refunded** when its payment completes.
   - A third window logged in as **admin** shows P4 Math go to 4/4 with Lucas, not Sofia, without a refresh.
3. Other seeded cases: **aisha** → Ethan → P4 Math gives a duplicate error (Ethan is already confirmed); P6 Science is **Full**; **daniel**'s list shows Lucas's earlier **payment failed** booking; pay with the *declined* test card to reproduce it.

---

## What I built

- **Parent flow**: pick a child → pick an available class → submit booking (`pending_payment`) → mock payment → status page. One screen per step. Your bookings and statuses are listed and an unpaid booking can be resumed. Times are shown in SGT; API error codes are mapped to parent-friendly copy.
- **Mock payment**: Stripe-style test cards (`…4242` succeeds, `…0002` declined, `…9995` insufficient funds). Every attempt is recorded in `payment_attempts`, including refunds and refunds that are still owed. A "slow network" toggle exists purely to make the race reproducible by hand.
- **Roster**: `/admin` page and `GET /api/admin/roster`: confirmed students per class, plus who is mid-checkout (explicitly *not* on the roster). Admin can cancel a booking (frees the seat, refunds) and run the background jobs by hand.
- **Login**: username/password accounts for parents and one admin, scrypt password hashes, server-side sessions in an HttpOnly cookie. A parent can only book, pay for, view and cancel bookings for their own children.
- **Live updates**: every committed booking change is pushed to every open page over Server-Sent Events, so seat counts, the roster and the payment step's "seat just taken" notice change the moment another family books, pays, or is refunded. A slow poll (15 s) backs it up.
- **Background jobs** (once a minute, also callable via API): expire pending bookings older than 15 minutes; retry refunds the provider failed to process.
- **Tests**: 49 tests over the service, auth and ownership, refund reconciliation, the raw database constraints, and real HTTP with real cookies and an SSE stream.

### Time spent

About **1 h 45 min of wall-clock time** for the build, in one sitting on 8 September 2026, working with Claude Code (see [AI_USAGE.md](AI_USAGE.md)). The figure comes from file and commit timestamps. Recording and editing the walkthrough video happened separately, on 11 September. The build is well inside the 4-hour cap. Here is where the time went:

| Pass | What | ≈ |
|---|---|---|
| 1. Core | data model, booking service, tests, API, plain UI, README | 35 min |
| 2. UI | one screen per step, live seat counts, friendly copy, SGT times | 15 min |
| 3. Login + live updates | accounts, sessions, ownership checks, SSE | 25 min |
| 4. Hardening + docs | refund reconciliation job, README and AI_USAGE, end-to-end verification | 30 min |

The brief asks for pass 1 only. Passes 2–4 were done *after* the core was complete, tested and committed, so that the race can be shown across two genuinely separate sessions; they are not a substitute for the correctness work. The first commit (`fd111e2`) is exactly the pass-1 scope if you prefer to evaluate that.

### Assumptions

- **Accounts are pre-provisioned.** There is no sign-up, password reset, or email verification; the seed creates one account per parent and one admin. Demo credentials are shown on the login page on purpose.
- **The payment provider is synchronous and in-process.** `charge()` resolves with success/decline; `refund()` succeeds unless the provider is down, in which case the refund is retried later. A real provider is asynchronous (webhooks); see *Tradeoffs* for how the design carries over.
- **A pending booking does not hold a seat.** Availability = `capacity − confirmed`. The 15-minute window only bounds how long a pending row lives before cleanup.
- **Terminal statuses are terminal.** After `payment_failed`, `refunded`, `expired`, or `cancelled`, a parent books again with a *new* booking; the old row stays as history. This keeps the state machine tiny.
- **Losing the race is refunded automatically and in full.** No waitlist.
- **One app process, one SQLite file** is the deployment target for this exercise; the SQL is written so the same invariants hold on Postgres (noted inline below). Live updates fan out in-process for the same reason. The schema has a version number and an old file is rebuilt, not migrated, because the data is synthetic.
- Prices are per class in SGD cents; a trial costs S$20–25. Only trial booking exists; no regular enrollment.

---

## Backend design

### Data model

```
parents (id, name, email UNIQUE)
students (id, parent_id → parents, name, grade)
accounts (id, username UNIQUE, password_hash, role CHECK IN (parent | admin), parent_id → parents, created_at)
sessions (id, account_id → accounts, created_at, expires_at)
trial_classes (id, subject, title, teacher, starts_at, capacity = 4, price_cents)
bookings (id, student_id → students, trial_class_id → trial_classes,
          status CHECK IN (pending_payment | confirmed | payment_failed | refunded | refund_pending | expired | cancelled),
          status_reason, created_at, updated_at, expires_at, confirmed_at)
payment_attempts (id, booking_id → bookings, amount_cents, currency,
          status CHECK IN (processing | succeeded | failed | refunded | refund_pending),
          provider_ref, failure_code, refund_ref, created_at, updated_at)
```

`bookings.status` is the **seat** outcome; `payment_attempts.status` is the **money** outcome. They are separate on purpose: a cancelled booking can still have a refund in flight, and the UI shows both.

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
| `refund_pending` | Same as `refunded`, but the refund call failed; the reconcile job retries until it goes through, then flips to `refunded`. | No |
| `expired` | Left unpaid past the checkout window (background job). | No |
| `cancelled` | Cancelled by parent/admin, or the class filled before we charged (`class_full_before_payment`). | No |

```
pending_payment ──pay ok + seat claimed──▶ confirmed ──cancel──▶ cancelled (seat released, refund issued or retried)
      │
      ├──provider declined─────────────────▶ payment_failed
      ├──pay ok but seat gone → refund─────▶ refunded
      │       └──refund call failed────────▶ refund_pending ──job──▶ refunded
      ├──class full before charge──────────▶ cancelled
      ├──cancelled by parent───────────────▶ cancelled
      └──15 min elapsed (job)──────────────▶ expired
```

### API

| Method & path | Who | Purpose |
|---|---|---|
| `POST /api/auth/login` `{username, password}` | anyone | Sets the `sid` session cookie; returns the principal (role, parent, children). |
| `POST /api/auth/logout` · `GET /api/auth/me` | signed in | End the session / who am I. |
| `GET /api/trial-classes` | anyone | Classes with `confirmed_count`, `pending_count`, `seats_available`. |
| `GET /api/me/bookings` | parent | This family's bookings, statuses, and latest payment status. |
| `POST /api/bookings` `{student_id, trial_class_id}` | parent (own child) | Create a `pending_payment` booking. `201`; `200 {reused:true}` if that child already has an unpaid booking for the class; `409 DUPLICATE_BOOKING` / `409 CLASS_FULL`; `403` for someone else's child. |
| `POST /api/bookings/:id/pay` `{card, delay_ms?}` | owner or admin | Charge, then claim the seat. Returns `{outcome, booking, attempt}` with outcome ∈ `confirmed`, `payment_failed`, `refunded`, `refund_pending`, `class_full`, `already_confirmed`. Idempotent. |
| `GET /api/bookings/:id` | owner or admin | Booking + child + class + payment history (status page). |
| `POST /api/bookings/:id/cancel` | owner or admin | Cancel pending/confirmed; refunds if paid. |
| `GET /api/events` | signed in | Server-Sent Events stream; one `change` event per committed booking change. |
| `GET /api/admin/roster` · `GET /api/admin/trial-classes/:id/roster` | admin | Confirmed roster (+ mid-checkout list) per class. |
| `POST /api/admin/jobs/expire-pending` · `POST /api/admin/jobs/retry-refunds` | admin | Run a background job now. |

The service layer ([src/booking-service.ts](src/booking-service.ts)) is the API; [src/auth.ts](src/auth.ts) owns login, sessions and the two ownership checks; [src/server.ts](src/server.ts) only maps requests to them.

### How duplicate bookings are prevented

1. **Service**: `createBooking` runs in a write transaction; if the child already has an *active* booking for the class it either returns the existing pending one (double-submit → resume checkout) or throws `409 DUPLICATE_BOOKING` (already confirmed).
2. **Database**: the partial unique index makes a second active row impossible, whatever the code does; the constraint error is mapped to the same 409.
3. **Confirmation time**: `claimSeat` runs `UPDATE … SET status='confirmed'`. If that ever hit the unique index, the booking is refunded instead of confirmed.

### How payment failure is handled

`pay()` creates a `payment_attempts` row (`processing`), calls the provider, and only *after* a successful charge attempts to claim the seat. On decline: attempt → `failed` with the code, booking → `payment_failed`, nothing else changes. The roster query only reads `status = 'confirmed'`, so a failed booking is invisible to the teacher by construction. The parent books again with a fresh booking; the failed row remains as audit history.

**Refunds that fail.** Every refund goes through one helper that never throws: if the provider call fails, the attempt is parked as `refund_pending` with `failure_code = refund_failed`, the seat outcome is recorded exactly as if the refund had worked (the booking becomes `refund_pending` instead of `refunded`; a cancellation stays `cancelled`), and the parent's page says "refund in progress". The reconcile job (`retryPendingRefunds`, every minute or on demand) retries each parked refund; success moves the attempt to `refunded` and a `refund_pending` booking to `refunded`. Money can be late, never lost. [test/booking.test.ts](test/booking.test.ts) covers both the lost-race and the cancellation variant with a provider that is down for the first call(s).

### The last-seat race

> A selects the last seat and moves to payment. B selects the same seat. B pays first and confirms. A then tries to pay.

**Approach: claim the seat at confirmation time, inside one serialized write transaction, and refund the loser.**

```
A: createBooking ─▶ pending          A: charge (in flight) ─────────────▶ claimSeat: confirmed=4 ≥ 4 → seat_taken → refund → refunded
B: createBooking ─▶ pending          B: charge ─▶ ok ─▶ claimSeat: 3 < 4 → UPDATE → confirmed ✔
                                       ^ interleaving happens here      ^ BEGIN IMMEDIATE: count + update are atomic
```

Concretely, in [src/booking-service.ts](src/booking-service.ts) `pay()`:

1. **Fail fast.** If the class is already full before we charge, the booking is cancelled (`class_full_before_payment`) and the card is never touched. This closes the common case (B finished well before A pressed Pay) at zero cost. The live update makes it even more common: A's page shows "the last seat was just taken" before A presses Pay.
2. **Charge.** This awaits the provider, and is the only place two competing requests interleave.
3. **Claim.** `claimSeat()` opens `BEGIN IMMEDIATE` (SQLite's writer lock), re-reads the booking, counts confirmed seats, and flips the row to `confirmed`. Because the transaction holds the write lock and the block is synchronous, no other confirmation can slip between the count and the update. If the count is already at capacity, it returns `seat_taken` without writing.
4. **Refund.** The loser's charge is refunded, the attempt is marked `refunded`, the booking becomes `refunded` with `status_reason = seat_taken`. The roster never saw it. If the refund call fails, see *Refunds that fail* above.

Even if step 3's application logic were wrong, the capacity trigger would abort the `UPDATE` and the code treats that abort as `seat_taken`. [test/last-seat-race.test.ts](test/last-seat-race.test.ts) scripts the exact interleaving from the brief with a controllable provider (B settles first, then A), the symmetric case, the fail-fast case, a declined winner, and a 12-way burst for one seat; [test/api.test.ts](test/api.test.ts) repeats it over real HTTP with two logged-in families and two concurrent requests.

**Why this approach**

- The seat is granted at the only moment that matters, when money has actually moved, so `confirmed` is always backed by a successful charge, and a pending or failed booking can never occupy a seat.
- The critical section is one short transaction on one row group; it needs no distributed lock, queue, or counter column that can drift.
- The hard invariants live in the schema, so a second process, a hotfix script, or a future bug cannot exceed capacity or double-book.

**Tradeoffs I accepted**

- **A user can be charged and then refunded.** The fail-fast check and the live "seat just taken" notice make this rare (only when B confirms *during* A's provider round-trip), but it can happen. The alternative, holding a seat while the user pays, was deliberately not chosen: with only 4 seats, abandoned checkouts would block real parents for the length of the hold, and a hold *still* needs the same atomic claim at the end. If refunds turned out to be frequent, I would add a short hold (5 min, counted in `seats_available`) on top of this design rather than instead of it.
- **Pending bookings are not reflected in availability**, so two parents can both start paying for one seat. The UI says so ("a seat is only taken once payment succeeds").
- **SQLite serializes all writers**, which makes the transaction trivially correct but means one writer at a time. On Postgres the same code needs one line more: `SELECT … FROM trial_classes WHERE id = ? FOR UPDATE` at the top of `claimSeat` (a per-class row lock), or `SERIALIZABLE` with a retry. The partial unique index is identical; the trigger becomes a `plpgsql` trigger or a `confirmed_count` column updated with `UPDATE … WHERE confirmed_count < capacity` as a compare-and-swap.
- **Synchronous provider.** With webhooks, `pay()` splits in two: the HTTP handler creates the attempt and the provider intent; the webhook handler (idempotent on `provider_ref`) runs steps 3–4. The seat claim, refund and retry logic do not change.
- **In-process live updates.** `LiveHub` fans out to the SSE clients of one process. With several app instances the change events would go through Postgres `LISTEN/NOTIFY` or Redis pub/sub; the client code is unchanged.

### Authentication and authorization

- Passwords are hashed with `scrypt` (node:crypto) and a random per-user salt; a login against an unknown username still runs the hash so the timing and the error are the same as a wrong password.
- Sessions live in the `sessions` table; the browser holds only the opaque id in an `HttpOnly; SameSite=Lax` cookie (7-day TTL, deleted on logout). `SameSite=Lax` means the cookie is not sent on cross-site POSTs, which covers CSRF for this JSON API without a token. `Secure` would be added behind HTTPS.
- Roles: `parent` (own children only) and `admin`. Ownership is checked in the HTTP layer with two helpers, `assertCanActOnStudent` and `assertCanActOnBooking`, before the booking service is called. The service itself stays role-agnostic and fully testable without HTTP.
- Not implemented on purpose: sign-up, password reset, login rate limiting / lockout, admin audit log.

### Which checks live where

| Layer | Checks | Role |
|---|---|---|
| **UI** | Redirect to `/login` when signed out and to the right home for the role; "Book" disabled when `seats_available = 0`; Pay disabled while a request is in flight; friendly copy per outcome; live "seat just taken" notice; "refund in progress" note | Convenience only. Never trusted. |
| **Backend (HTTP + auth)** | Session validity and expiry, role per route, parent-owns-child and parent-owns-booking checks, input validation | Authorization boundary. |
| **Backend (service)** | Duplicate/active-booking check, class-full pre-check, `pay` idempotency (`already_confirmed`, `PAYMENT_IN_PROGRESS`), state-transition rules, refund on lost race, never-throwing refund helper, `expires_at`, change events | Turns invariants into good errors and correct money movement. |
| **Database** | Partial unique index (one active booking per child+class), capacity trigger (confirmed ≤ capacity), status `CHECK`s, FKs, `BEGIN IMMEDIATE` serialization | The guarantees. Hold even under bugs or multiple processes. |
| **Background jobs** | Expire `pending_payment` past `expires_at` (skipping ones with a charge in flight); retry `refund_pending` attempts. Next: reconcile attempts stuck in `processing` against the provider; alert if any class has confirmed > capacity; purge expired sessions | Cleanup and self-healing; never the primary guard. |

---

## Tests and verification

```bash
npm test
```

| File | Covers |
|---|---|
| [test/booking.test.ts](test/booking.test.ts) | Seed scenarios, happy path, payment failure + retry, duplicates, overbooking, expiry job, cancellation, idempotency, refund reconciliation (lost race and cancellation with the provider down), validation |
| [test/last-seat-race.test.ts](test/last-seat-race.test.ts) | The required scenario with a step-controlled provider, symmetry, fail-fast, declined winner, 12-way burst |
| [test/db-invariants.test.ts](test/db-invariants.test.ts) | Raw SQL cannot insert a 5th confirmed row or a duplicate active row; rollback |
| [test/auth.test.ts](test/auth.test.ts) | Password hashing, login, session expiry and logout, roles, ownership checks |
| [test/api.test.ts](test/api.test.ts) | Pages served, 401/403 boundaries, login/me/logout, full flow with cookies, 409s, declined card, the race with two families and two sessions, SSE change events, validation, admin jobs |

Tests use an in-memory SQLite database, the real seed, and an injected clock. `ControlledProvider` in [test/helpers.ts](test/helpers.ts) lets a test decide exactly when each user's payment completes and whether the provider's refund endpoint is up, which is what makes the race and the outage deterministic.

Manual verification: the two-browser flow under *90-second reviewer path*, and `npm run demo:race`. Every push runs the suite on GitHub Actions against **both** Node 22.13 (the declared floor) and Node 24, with the tests executed before any `npm install` so the zero-dependency claim is checked rather than asserted; the badge at the top is that run. An external audit of an earlier export on Node 22.16 is what prompted the explicit version check and flags above. The suite was also run from a clean `git clone` on Node 24.15, and an external audit of an earlier export on Node 22.16 is what prompted the explicit version check and flags above.

---

## What I deliberately cut

- Sign-up, password reset, email verification, login rate limiting, admin audit log.
- A real payment provider, webhooks, and 3-D Secure; partial refunds; payment retries on the *same* booking.
- Seat holds / waitlist, email or WhatsApp notifications, class reminders.
- Regular enrollment, pricing rules, discounts, grade-eligibility rules (a P6 child may book a P4 class), "class already started" checks.
- A frontend framework, build step, CSS framework; migrations tooling (schema is `CREATE IF NOT EXISTS` plus a version number that rebuilds an old synthetic file).
- Multi-process deployment (SQLite in WAL mode and in-process SSE are fine for one server; see the Postgres notes above).

## What I would monitor after release

- **Invariant canaries** (should always be zero): classes with `confirmed > capacity`; children with two active bookings for one class; `confirmed` bookings without a `succeeded` attempt.
- **Race rate**: bookings ending `refunded/seat_taken` per day. If it is more than a handful, add seat holds.
- **Payment funnel**: `pending_payment → confirmed` conversion, decline rate by failure code, `expired` count (abandoned checkouts).
- **Money safety**: `refund_pending` attempts older than 15 minutes (provider outage that is not clearing), attempts stuck in `processing` for more than a few minutes (server died mid-charge → reconcile with the provider).
- **Auth**: failed logins per account and per IP (credential stuffing), sessions created per hour, 403s (a spike means a bug in the UI or someone probing).
- **Ops**: p95 latency of `/pay`, 5xx rate, SQLite `busy` errors, open SSE connections, job run frequency.

## What I would do next with more time

1. Postgres + row lock (`FOR UPDATE`) and a proper migration tool; run two app instances against it with `LISTEN/NOTIFY` for the live events, and re-run the burst test across processes.
2. Real provider integration with webhooks and an idempotent webhook handler keyed on `provider_ref`; extend the reconcile job to attempts stuck in `processing`, not only failed refunds.
3. Optional short seat hold reflected in `seats_available`, with a waitlist when the last seat is contested.
4. Sign-up and password reset by email, login rate limiting, `Secure` cookies behind HTTPS, an audit log of who cancelled what, structured logging with booking and account ids.
5. Notifications on `confirmed` / `refunded`, and a teacher view that exports the roster.

---

## Project layout

```
src/
  db.ts                schema (index + triggers, accounts, sessions, version), openDb, transaction()
  booking-service.ts   all business rules: createBooking, pay, claimSeat, cancel, jobs (expire, retry refunds), roster, change events
  auth.ts              password hashing, login/logout, sessions, role + ownership checks
  payments.ts          PaymentProvider port + MockPaymentProvider (test cards, optional delay)
  seed.ts              synthetic dataset + demo accounts + `npm run seed`
  server.ts            router over node:http, cookie sessions, SSE LiveHub, static files, background jobs, main()
  errors.ts            AppError (HTTP status + code)
public/                login (login.html/js), parent UI (index.html, app.js), admin roster (admin.html, admin.js), shared.js, style.css
test/                  node:test suites + helpers (ControlledProvider, fixed clock)
scripts/demo-race.ts   narrated CLI demo
AI_USAGE.md            how AI tools were used
.devcontainer/         Codespaces: Node 24, port 3000 forwarded, tests run on first boot
.github/workflows/     CI: tests + typecheck on Node 22.13 and 24
```
