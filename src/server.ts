import http from 'node:http';
import { readFile } from 'node:fs/promises';
import { extname, join, normalize, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDb } from './db.ts';
import { isSeeded, printSeedSummary, seed } from './seed.ts';
import { MockPaymentProvider, TEST_CARDS } from './payments.ts';
import { BookingService, type BookingChange } from './booking-service.ts';
import { AuthService, type Principal } from './auth.ts';
import { AppError } from './errors.ts';

/**
 * Dependency-free HTTP layer: a tiny router over node:http, cookie sessions,
 * a Server-Sent Events stream for live updates, and static files.
 * All business rules live in BookingService; authorization in AuthService.
 */

type AuthLevel = 'none' | 'user' | 'parent' | 'admin';
type Ctx = {
  params: Record<string, string>;
  body: Record<string, unknown>;
  url: URL;
  sid: string | undefined;
  principal: Principal | null;
};
type Handler = (ctx: Ctx) => unknown | Promise<unknown>;
type Route = { method: string; pattern: RegExp; keys: string[]; auth: AuthLevel; handler: Handler };

class Reply {
  status: number;
  body: unknown;
  headers: Record<string, string>;
  constructor(status: number, body: unknown, headers: Record<string, string> = {}) {
    this.status = status;
    this.body = body;
    this.headers = headers;
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
const PAGES: Record<string, string> = { '/': '/index.html', '/admin': '/admin.html', '/login': '/login.html' };

const SESSION_COOKIE = 'sid';
const SESSION_MAX_AGE_S = 7 * 24 * 60 * 60;

/**
 * Live updates: every booking change is pushed to every open page over SSE.
 * In-process fan-out is enough for one server; with several instances this
 * would sit on Postgres LISTEN/NOTIFY or Redis pub/sub instead.
 */
export class LiveHub {
  private readonly clients = new Set<http.ServerResponse>();
  private heartbeat: NodeJS.Timeout | null = null;

  subscribe(req: http.IncomingMessage, res: http.ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.write('retry: 3000\n\n');
    this.clients.add(res);
    req.on('close', () => this.clients.delete(res));
    if (!this.heartbeat) {
      this.heartbeat = setInterval(() => {
        for (const client of this.clients) client.write(': ping\n\n');
      }, 25_000);
      this.heartbeat.unref();
    }
  }

  broadcast(change: BookingChange): void {
    const payload = `event: change\ndata: ${JSON.stringify(change)}\n\n`;
    for (const client of this.clients) client.write(payload);
  }

  get size(): number {
    return this.clients.size;
  }

  closeAll(): void {
    for (const client of this.clients) client.end();
    this.clients.clear();
    if (this.heartbeat) clearInterval(this.heartbeat);
    this.heartbeat = null;
  }
}

export interface AppDeps {
  service: BookingService;
  auth: AuthService;
  live?: LiveHub;
}

export function createApp({ service, auth, live = new LiveHub() }: AppDeps): http.Server {
  const routes: Route[] = [];
  const route = (method: string, path: string, authLevel: AuthLevel, handler: Handler) => {
    const keys: string[] = [];
    const pattern = new RegExp(
      '^' +
        path.replace(/:([A-Za-z_]+)/g, (_m, key: string) => {
          keys.push(key);
          return '([^/]+)';
        }) +
        '/?$',
    );
    routes.push({ method, pattern, keys, auth: authLevel, handler });
  };

  // ----- Auth -------------------------------------------------------------------
  route('POST', '/api/auth/login', 'none', ({ body }) => {
    const { session, principal } = auth.login(requireString(body, 'username'), requireString(body, 'password'));
    return new Reply(200, { principal }, { 'set-cookie': sessionCookie(session.id, SESSION_MAX_AGE_S) });
  });
  route('POST', '/api/auth/logout', 'user', ({ sid }) => {
    if (sid) auth.logout(sid);
    return new Reply(200, { ok: true }, { 'set-cookie': sessionCookie('', 0) });
  });
  route('GET', '/api/auth/me', 'user', ({ principal }) => principal);

  // ----- Public catalogue ---------------------------------------------------------
  route('GET', '/api/trial-classes', 'none', () => service.listTrialClasses());
  route('GET', '/api/test-cards', 'none', () => Object.entries(TEST_CARDS).map(([number, c]) => ({ number, ...c })));

  // ----- Parent -------------------------------------------------------------------
  route('GET', '/api/me/bookings', 'parent', ({ principal }) => service.listBookingsForParent(principal!.parent_id!));
  route('POST', '/api/bookings', 'parent', ({ body, principal }) => {
    const studentId = requireString(body, 'student_id');
    auth.assertCanActOnStudent(principal!, studentId);
    const result = service.createBooking({ studentId, trialClassId: requireString(body, 'trial_class_id') });
    return new Reply(result.reused ? 200 : 201, result);
  });
  route('GET', '/api/bookings/:id', 'user', ({ params, principal }) => {
    auth.assertCanActOnBooking(principal!, params.id);
    return service.getBookingDetail(params.id);
  });
  route('POST', '/api/bookings/:id/pay', 'user', ({ params, body, principal }) => {
    auth.assertCanActOnBooking(principal!, params.id);
    return service.pay({
      bookingId: params.id,
      card: requireString(body, 'card'),
      delayMs: optionalNumber(body, 'delay_ms'),
    });
  });
  route('POST', '/api/bookings/:id/cancel', 'user', ({ params, principal }) => {
    auth.assertCanActOnBooking(principal!, params.id);
    return service.cancelBooking(params.id, principal!.role === 'admin' ? 'cancelled_by_admin' : 'cancelled_by_parent');
  });

  // ----- Admin / teacher ----------------------------------------------------------
  route('GET', '/api/admin/roster', 'admin', () => service.listRosters());
  route('GET', '/api/admin/trial-classes/:id/roster', 'admin', ({ params }) => service.getRoster(params.id));
  route('POST', '/api/admin/jobs/expire-pending', 'admin', () => service.expirePendingBookings());
  route('POST', '/api/admin/jobs/retry-refunds', 'admin', () => service.retryPendingRefunds());

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost');
    const sid = readCookie(req, SESSION_COOKIE);
    try {
      // Live updates stream (any signed-in user).
      if (req.method === 'GET' && url.pathname === '/api/events') {
        auth.requireUser(sid);
        live.subscribe(req, res);
        return;
      }

      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = r.pattern.exec(url.pathname);
        if (!m) continue;
        const params: Record<string, string> = {};
        r.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1])));
        const principal =
          r.auth === 'admin'
            ? auth.requireAdmin(sid)
            : r.auth === 'parent'
              ? auth.requireParent(sid)
              : r.auth === 'user'
                ? auth.requireUser(sid)
                : auth.principalForSession(sid);
        const body = req.method === 'POST' ? await readJson(req) : {};
        const out = await r.handler({ params, body, url, sid, principal });
        if (out instanceof Reply) return sendJson(res, out.status, out.body, out.headers);
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
  server.on('close', () => live.closeAll());
  return server;
}

// ----- helpers ------------------------------------------------------------------

function sessionCookie(value: string, maxAgeSeconds: number): string {
  // HttpOnly: JS cannot read it. SameSite=Lax: not sent on cross-site POSTs (CSRF).
  // `Secure` would be added behind HTTPS.
  return `${SESSION_COOKIE}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${maxAgeSeconds}`;
}

function readCookie(req: http.IncomingMessage, name: string): string | undefined {
  const header = req.headers.cookie;
  if (!header) return undefined;
  for (const part of header.split(';')) {
    const [key, ...rest] = part.trim().split('=');
    if (key === name) return decodeURIComponent(rest.join('='));
  }
  return undefined;
}

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

function sendJson(res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}): void {
  const payload = JSON.stringify(body);
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store', ...headers });
  res.end(payload);
}

async function serveStatic(pathname: string, res: http.ServerResponse): Promise<void> {
  const clean = PAGES[pathname] ?? pathname;
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

// ----- main ---------------------------------------------------------------------

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1]);
if (isMain) {
  const dataPath = process.env.DATA_PATH ?? join(ROOT, 'data', 'ottodot.sqlite');
  const db = openDb(dataPath);
  if (process.argv.includes('--reset') || !isSeeded(db)) {
    seed(db);
    console.log(`Seeded database at ${dataPath}`);
  }
  const live = new LiveHub();
  const service = new BookingService(db, new MockPaymentProvider(), { onChange: (change) => live.broadcast(change) });
  const auth = new AuthService(db);

  // Background jobs, once a minute: release abandoned checkouts, retry refunds the provider failed.
  setInterval(async () => {
    const { expired } = service.expirePendingBookings();
    if (expired > 0) console.log(`[job] expired ${expired} stale pending booking(s)`);
    const refunds = await service.retryPendingRefunds();
    if (refunds.retried > 0) console.log(`[job] refunds: ${refunds.refunded} completed, ${refunds.still_pending} still pending`);
  }, 60_000).unref();

  const port = Number(process.env.PORT ?? 3000);
  createApp({ service, auth, live }).listen(port, () => {
    console.log('Ottodot trial booking');
    console.log(`  Login     : http://localhost:${port}/login`);
    console.log(`  Parent UI : http://localhost:${port}/`);
    console.log(`  Roster    : http://localhost:${port}/admin`);
    console.log(`  API       : http://localhost:${port}/api/trial-classes`);
    printSeedSummary();
  });
}
