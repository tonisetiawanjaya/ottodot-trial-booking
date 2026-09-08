import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type DB = DatabaseSync;

/**
 * Schema. Two invariants are enforced *by the database itself*, independent of
 * application code:
 *
 *   1. ux_bookings_one_active_per_student_class: a child can have at most one
 *      ACTIVE (pending_payment or confirmed) booking per trial class.
 *      => no duplicate confirmed bookings, ever.
 *
 *   2. trg_capacity_*: a booking can only become `confirmed` while the class
 *      has fewer confirmed bookings than its capacity.
 *      => never more than `capacity` confirmed students, even if the app has a bug.
 *
 * Application code checks the same conditions first so users get a friendly
 * error instead of a constraint violation; the database is the backstop.
 */
export const SCHEMA = `
CREATE TABLE IF NOT EXISTS parents (
  id    TEXT PRIMARY KEY,
  name  TEXT NOT NULL,
  email TEXT NOT NULL UNIQUE
);

CREATE TABLE IF NOT EXISTS students (
  id        TEXT PRIMARY KEY,
  parent_id TEXT NOT NULL REFERENCES parents(id),
  name      TEXT NOT NULL,
  grade     TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS trial_classes (
  id          TEXT PRIMARY KEY,
  subject     TEXT NOT NULL,
  title       TEXT NOT NULL,
  teacher     TEXT NOT NULL,
  starts_at   TEXT NOT NULL,
  capacity    INTEGER NOT NULL DEFAULT 4 CHECK (capacity > 0),
  price_cents INTEGER NOT NULL CHECK (price_cents >= 0)
);

CREATE TABLE IF NOT EXISTS bookings (
  id             TEXT PRIMARY KEY,
  student_id     TEXT NOT NULL REFERENCES students(id),
  trial_class_id TEXT NOT NULL REFERENCES trial_classes(id),
  status         TEXT NOT NULL CHECK (status IN (
                   'pending_payment', 'confirmed', 'payment_failed',
                   'refunded', 'refund_pending', 'expired', 'cancelled')),
  status_reason  TEXT,
  created_at     TEXT NOT NULL,
  updated_at     TEXT NOT NULL,
  expires_at     TEXT,
  confirmed_at   TEXT
);

-- Invariant 1: one active booking per (child, class).
CREATE UNIQUE INDEX IF NOT EXISTS ux_bookings_one_active_per_student_class
  ON bookings (student_id, trial_class_id)
  WHERE status IN ('pending_payment', 'confirmed');

CREATE INDEX IF NOT EXISTS ix_bookings_class_status
  ON bookings (trial_class_id, status);

CREATE TABLE IF NOT EXISTS payment_attempts (
  id           TEXT PRIMARY KEY,
  booking_id   TEXT NOT NULL REFERENCES bookings(id),
  amount_cents INTEGER NOT NULL,
  currency     TEXT NOT NULL,
  status       TEXT NOT NULL CHECK (status IN ('processing', 'succeeded', 'failed', 'refunded', 'refund_pending')),
  provider_ref TEXT,
  failure_code TEXT,
  refund_ref   TEXT,
  created_at   TEXT NOT NULL,
  updated_at   TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_payment_attempts_booking
  ON payment_attempts (booking_id, created_at);

-- Login accounts. A parent account points at its parents row; the admin account has none.
CREATE TABLE IF NOT EXISTS accounts (
  id            TEXT PRIMARY KEY,
  username      TEXT NOT NULL UNIQUE,
  password_hash TEXT NOT NULL,
  role          TEXT NOT NULL CHECK (role IN ('parent', 'admin')),
  parent_id     TEXT REFERENCES parents(id),
  created_at    TEXT NOT NULL,
  CHECK ((role = 'parent') = (parent_id IS NOT NULL))
);

-- Server-side sessions; the browser only holds the opaque id in an HttpOnly cookie.
CREATE TABLE IF NOT EXISTS sessions (
  id         TEXT PRIMARY KEY,
  account_id TEXT NOT NULL REFERENCES accounts(id),
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS ix_sessions_account ON sessions (account_id);

-- Invariant 2: confirmed bookings never exceed class capacity.
CREATE TRIGGER IF NOT EXISTS trg_capacity_on_insert
BEFORE INSERT ON bookings
WHEN NEW.status = 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'CLASS_FULL')
  WHERE (SELECT COUNT(*) FROM bookings
          WHERE trial_class_id = NEW.trial_class_id AND status = 'confirmed')
        >= (SELECT capacity FROM trial_classes WHERE id = NEW.trial_class_id);
END;

CREATE TRIGGER IF NOT EXISTS trg_capacity_on_update
BEFORE UPDATE OF status ON bookings
WHEN NEW.status = 'confirmed' AND OLD.status <> 'confirmed'
BEGIN
  SELECT RAISE(ABORT, 'CLASS_FULL')
  WHERE (SELECT COUNT(*) FROM bookings
          WHERE trial_class_id = NEW.trial_class_id AND status = 'confirmed')
        >= (SELECT capacity FROM trial_classes WHERE id = NEW.trial_class_id);
END;
`;

/**
 * Bump when the schema changes. The data is synthetic, so an on-disk file
 * from an older version is simply rebuilt (and reseeded by the server) instead
 * of migrated. A real deployment would use migrations here.
 */
export const SCHEMA_VERSION = 2;
const TABLES_NEWEST_FIRST = ['sessions', 'accounts', 'payment_attempts', 'bookings', 'students', 'parents', 'trial_classes'];

/** Open (and create if needed) a SQLite database with the schema applied. */
export function openDb(path: string = ':memory:'): DB {
  if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true });
  const db = new DatabaseSync(path);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('PRAGMA busy_timeout = 5000');
  if (path !== ':memory:') db.exec('PRAGMA journal_mode = WAL');

  const { user_version } = db.prepare('PRAGMA user_version').get() as { user_version: number };
  const hasTables = db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'bookings'").get();
  if (hasTables && user_version !== SCHEMA_VERSION) {
    console.warn(`[db] schema v${user_version} -> v${SCHEMA_VERSION}: rebuilding tables (synthetic data, will be reseeded)`);
    db.exec('PRAGMA foreign_keys = OFF');
    for (const table of TABLES_NEWEST_FIRST) db.exec(`DROP TABLE IF EXISTS ${table}`);
    db.exec('PRAGMA foreign_keys = ON');
  }
  db.exec(SCHEMA);
  db.exec(`PRAGMA user_version = ${SCHEMA_VERSION}`);
  return db;
}

/**
 * Run `fn` inside a write transaction.
 *
 * BEGIN IMMEDIATE takes SQLite's single writer lock up front, so a
 * read-then-write sequence (count confirmed seats, then confirm) cannot
 * interleave with another writer, even one in another process. It is the
 * SQLite equivalent of `SELECT ... FOR UPDATE` on the trial_classes row in
 * Postgres (see README, "Last-seat race").
 */
export function transaction<T>(db: DB, fn: () => T): T {
  db.exec('BEGIN IMMEDIATE');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** True when `err` is a SQLite error whose message contains `needle` (if given). */
export function isSqliteError(err: unknown, needle?: string): boolean {
  const e = err as { code?: string; message?: string } | null;
  if (!e || e.code !== 'ERR_SQLITE_ERROR') return false;
  return needle ? String(e.message).includes(needle) : true;
}
