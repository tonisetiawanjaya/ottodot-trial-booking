import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';
import { isSeeded, seed } from './seed.ts';
import { MockPaymentProvider, TEST_CARDS } from './payments.ts';
import { BookingService } from './booking-service.ts';
import { AppError } from './errors.ts';

/**
 * Dependency-free HTTP layer: a tiny router over node:http plus static files.
 * All business rules live in BookingService; this file only maps HTTP <-> calls.
 */

type Ctx = { params: Record<string, string>; body: Record<string, unknown>; url: URL };
type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
type Route = { method: string; pattern: RegExp; keys: string[]; handler: Handler };

class Reply {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown) {
    this.status = status;
    this.body = body;
  }
}

const ROOT = resolve(fileURLToPath(import.meta.url), '..', '..');
const PUBLIC_DIR = join(ROOT, 'public');
const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
};

export function createApp(service: BookingService): http.Server {
  const routes: Route[] = [];
  const route = (method: string, path: string, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' +
        path.replace(/:([A-Za-z_]+)/g, (_m, key: string) => {
          keys.push(key);
          return '([^/]+)';
        }) +
        '/?$',
    );
    routes.push({ method, pattern, keys, handler });
  };

  // ----- Parent-facing --------------------------------------------------------
  route('GET', '/api/parents', () => service.listParents());
  route('GET', '/api/parents/:id/bookings', ({ params }) => service.listBookingsForParent(params.id));
  route('GET', '/api/trial-classes', () => service.listTrialClasses());
  route('GET', '/api/test-cards', () => Object.entries(TEST_CARDS).map(([number, c]) => ({ number, ...c })));

  route('POST', '/api/bookings', ({ body }) => {
    const result = service.createBooking({
      studentId: requireString(body, 'student_id'),
      trialClassId: requireString(body, 'trial_class_id'),
    });
    return new Reply(result.reused ? 200 : 201, result);
  });
  route('GET', '/api/bookings/:id', ({ params }) => service.getBookingDetail(params.id));
  route('POST', '/api/bookings/:id/pay', ({ params, body }) =>
    service.pay({
      bookingId: params.id,
      card: requireString(body, 'card'),
      delayMs: optionalNumber(body, 'delay_ms'),
    }),
  );
  route('POST', '/api/bookings/:id/cancel', ({ params, body }) =>
    service.cancelBooking(params.id, typeof body.reason === 'string' ? body.reason : 'cancelled_by_user'),
  );

  // ----- Admin / teacher ------------------------------------------------------
  route('GET', '/api/admin/roster', () => service.listRosters());
  route('GET', '/api/admin/trial-classes/:id/roster', ({ params }) => service.getRoster(params.id));
  route('POST', '/api/admin/jobs/expire-pending', () => service.expirePendingBookings());

  return http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        const body = req.method === 'POST' ? await readJson(req) : {};
        const out = await r.handler({ params, body, url });
        if (out instanceof Reply) return sendJson(res, out.status, out.body);
        return sendJson(res, 200, out);
      }
      if (req.method === 'GET' || req.method === 'HEAD') return await serveStatic(url.pathname, res);
      return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `No route for ${req.method} ${url.pathname}` } });
    } catch (err) {
      if (err instanceof AppError) {
        return sendJson(res, err.status, { error: { code: err.code, message: err.message, details: err.details } });
      }
      console.error(err);
      return sendJson(res, 500, { error: { code: 'INTERNAL', message: 'Unexpected server error' } });
    }
  });
}

// ----- helpers ----------------------------------------------------------------

function requireString(body: Record<string, unknown>, key: string): string {
  const v = body[key];
  if (typeof v !== 'string' || v.trim() === '') throw new AppError(400, 'VALIDATION', `'${key}' is required`);
  return v;
}

function optionalNumber(body: Record<string, unknown>, key: string): number | undefined {
  const v = body[key];
  if (v === undefined || v === null || v === '') return undefined;
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new AppError(400, 'VALIDATION', `'${key}' must be a non-negative number`);
  return n;
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 64 * 1024) throw new AppError(413, 'PAYLOAD_TOO_LARGE', 'Request body too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    const parsed = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
  } catch {
    throw new AppError(400, 'VALIDATION', 'Body must be valid JSON');
  }
}

function sendJson(res: http.ServerResponse, status: number, body: unknown): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' });
  res.end(payload);
}

async function serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
  const clean = pathname === '/' ? '/index.html' : pathname === '/admin' ? '/admin.html' : pathname;
  const file = normalize(join(PUBLIC_DIR, clean));
  if (!file.startsWith(PUBLIC_DIR + sep)) return sendJson(res, 404, { error: { code: 'NOT_FOUND', message: 'Not found' } });
  try {
    const data = await readFile(file);
    res.writeHead(200, { 'content-type': MIME[extname(file)] ?? 'application/octet-stream', 'cache-control': 'no-store' });
    res.end(data);
  } catch {
    sendJson(res, 404, { error: { code: 'NOT_FOUND', message: `Not found: ${pathname}` } });
  }
}

// ----- main -------------------------------------------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const dataPath = process.env.DATA_PATH ?? join(ROOT, 'data', 'ottodot.sqlite');
  const db = openDb(dataPath);
  if (process.argv.includes('--reset') || !isSeeded(db)) {
    seed(db);
    console.log(`Seeded database at ${dataPath}`);
  }
  const service = new BookingService(db, new MockPaymentProvider());

  // Background job: release abandoned checkouts once a minute.
  setInterval(() => {
    const { expired } = service.expirePendingBookings();
    if (expired > 0) console.log(`[job] expired ${expired} stale pending booking(s)`);
  }, 60_000).unref();

  const port = Number(process.env.PORT ?? 3000);
  createApp(service).listen(port, () => {
    console.log('Ottodot trial booking');
    console.log(`  Parent UI : http://localhost:${port}/`);
    console.log(`  Roster    : http://localhost:${port}/admin`);
    console.log(`  API       : http://localhost:${port}/api/trial-classes`);
  });
}
