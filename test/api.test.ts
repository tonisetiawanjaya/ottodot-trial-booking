import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { createApp } from '../src/server.ts';
import { CARD_DECLINED, CARD_OK, IDS, PASSWORDS, confirmedCount, makeService } from './helpers.ts';

/** End-to-end over real HTTP with real cookies: the same flow the UI drives. */
describe('HTTP API', () => {
  let server: http.Server;
  let base: string;
  const ctx = makeService();

  before(async () => {
    server = createApp({ service: ctx.service, auth: ctx.auth, live: ctx.live });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => {
    server.closeAllConnections();
    server.close();
  });

  const get = async (path: string, cookie = '') => {
    const res = await fetch(base + path, { headers: { cookie } });
    return { status: res.status, body: await res.json() };
  };
  const post = async (path: string, body: unknown = {}, cookie = '') => {
    const res = await fetch(base + path, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie },
      body: JSON.stringify(body),
    });
    return { status: res.status, body: await res.json(), setCookie: res.headers.get('set-cookie') ?? '' };
  };
  /** Log in and return the session cookie to send on later requests. */
  const login = async (username: string, password: string) => {
    const res = await post('/api/auth/login', { username, password });
    assert.equal(res.status, 200, `login as ${username}`);
    assert.match(res.setCookie, /^sid=[^;]+; Path=\/; HttpOnly; SameSite=Lax/);
    return res.setCookie.split(';')[0];
  };

  it('serves the login, parent and admin pages', async () => {
    for (const path of ['/login', '/', '/admin']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    }
    assert.equal((await fetch(base + '/nope.html')).status, 404);
  });

  it('lists classes with seat counts without a login', async () => {
    const { status, body } = await get('/api/trial-classes');
    assert.equal(status, 200);
    const fractions = body.find((c: { id: string }) => c.id === IDS.fractions);
    assert.equal(fractions.confirmed_count, 3);
    assert.equal(fractions.seats_available, 1);
  });

  it('rejects everything else without a session (401)', async () => {
    assert.equal((await get('/api/auth/me')).status, 401);
    assert.equal((await get('/api/me/bookings')).status, 401);
    assert.equal((await post('/api/bookings', { student_id: IDS.sofia, trial_class_id: IDS.forces })).status, 401);
    assert.equal((await get('/api/admin/roster')).status, 401);
    assert.equal((await fetch(base + '/api/events')).status, 401);
  });

  it('logs in, reports the current user, and logs out', async () => {
    const bad = await post('/api/auth/login', { username: 'maria', password: 'wrong' });
    assert.equal(bad.status, 401);
    assert.equal(bad.body.error.code, 'INVALID_CREDENTIALS');

    const cookie = await login('maria', PASSWORDS.parent);
    const me = await get('/api/auth/me', cookie);
    assert.equal(me.body.parent.name, 'Maria Santos');
    assert.equal(me.body.students[0].id, IDS.sofia);
    assert.equal('password_hash' in me.body, false);

    const out = await post('/api/auth/logout', {}, cookie);
    assert.match(out.setCookie, /Max-Age=0/);
    assert.equal((await get('/api/auth/me', cookie)).status, 401);
  });

  it("a parent cannot book another family's child or read another family's booking (403)", async () => {
    const maria = await login('maria', PASSWORDS.parent);
    const other = await post('/api/bookings', { student_id: IDS.ethan, trial_class_id: IDS.forces }, maria);
    assert.equal(other.status, 403);
    assert.equal(other.body.error.code, 'FORBIDDEN');
    assert.equal((await get('/api/bookings/bk_lucas_forces_failed', maria)).status, 403);
    assert.equal((await get('/api/admin/roster', maria)).status, 403);
    assert.equal((await post('/api/admin/jobs/expire-pending', {}, maria)).status, 403);
  });

  it('runs the whole flow: create -> pay -> status -> admin roster', async () => {
    const maria = await login('maria', PASSWORDS.parent);
    const created = await post('/api/bookings', { student_id: IDS.sofia, trial_class_id: IDS.forces }, maria);
    assert.equal(created.status, 201);
    assert.equal(created.body.booking.status, 'pending_payment');
    const id = created.body.booking.id;

    const paid = await post(`/api/bookings/${id}/pay`, { card: CARD_OK }, maria);
    assert.equal(paid.status, 200);
    assert.equal(paid.body.outcome, 'confirmed');

    const detail = await get(`/api/bookings/${id}`, maria);
    assert.equal(detail.body.booking.status, 'confirmed');
    assert.equal(detail.body.payment_attempts[0].status, 'succeeded');

    const mine = await get('/api/me/bookings', maria);
    assert.equal(mine.body.some((b: { id: string; status: string }) => b.id === id && b.status === 'confirmed'), true);

    const admin = await login('admin', PASSWORDS.admin);
    const roster = await get(`/api/admin/trial-classes/${IDS.forces}/roster`, admin);
    assert.deepEqual(roster.body.confirmed.map((r: { student_id: string }) => r.student_id), [IDS.sofia]);
  });

  it('returns 409 DUPLICATE_BOOKING and 409 CLASS_FULL', async () => {
    const aisha = await login('aisha', PASSWORDS.parent);
    const dup = await post('/api/bookings', { student_id: IDS.ethan, trial_class_id: IDS.fractions }, aisha);
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'DUPLICATE_BOOKING');

    const maria = await login('maria', PASSWORDS.parent);
    const full = await post('/api/bookings', { student_id: IDS.sofia, trial_class_id: IDS.electricity }, maria);
    assert.equal(full.status, 409);
    assert.equal(full.body.error.code, 'CLASS_FULL');
  });

  it('records a declined payment without touching the roster', async () => {
    const priya = await login('priya', PASSWORDS.parent);
    const created = await post('/api/bookings', { student_id: IDS.arjun, trial_class_id: IDS.forces }, priya);
    const paid = await post(`/api/bookings/${created.body.booking.id}/pay`, { card: CARD_DECLINED }, priya);
    assert.equal(paid.body.outcome, 'payment_failed');
    assert.equal(paid.body.booking.status, 'payment_failed');
    const admin = await login('admin', PASSWORDS.admin);
    const roster = await get(`/api/admin/trial-classes/${IDS.forces}/roster`, admin);
    assert.ok(!roster.body.confirmed.some((r: { student_id: string }) => r.student_id === IDS.arjun));
  });

  it('last-seat race over HTTP: two families, two sessions, one confirmed', async () => {
    const maria = await login('maria', PASSWORDS.parent);
    const daniel = await login('daniel', PASSWORDS.parent);
    const a = (await post('/api/bookings', { student_id: IDS.sofia, trial_class_id: IDS.fractions }, maria)).body.booking;
    const b = (await post('/api/bookings', { student_id: IDS.lucas, trial_class_id: IDS.fractions }, daniel)).body.booking;

    // A's provider is slow (200 ms), B's is fast: B completes first.
    const [resA, resB] = await Promise.all([
      post(`/api/bookings/${a.id}/pay`, { card: CARD_OK, delay_ms: 200 }, maria),
      post(`/api/bookings/${b.id}/pay`, { card: CARD_OK, delay_ms: 0 }, daniel),
    ]);

    assert.equal(resB.body.outcome, 'confirmed');
    assert.equal(resA.body.outcome, 'refunded');
    assert.equal(resA.body.booking.status_reason, 'seat_taken');
    assert.equal(resA.body.attempt.status, 'refunded');
    assert.equal(confirmedCount(ctx.db, IDS.fractions), 4);

    const admin = await login('admin', PASSWORDS.admin);
    const roster = await get(`/api/admin/trial-classes/${IDS.fractions}/roster`, admin);
    assert.equal(roster.body.confirmed.length, 4);
    assert.equal(roster.body.pending.length, 0);
  });

  it('pushes live change events to signed-in pages (SSE)', async () => {
    const wei = await login('wei', PASSWORDS.parent);
    const ac = new AbortController();
    const stream = await fetch(base + '/api/events', { headers: { cookie: wei }, signal: ac.signal });
    assert.equal(stream.status, 200);
    assert.match(stream.headers.get('content-type') ?? '', /text\/event-stream/);
    assert.equal(ctx.live.size, 1);

    // Any change from anyone shows up on the stream.
    const created = await post('/api/bookings', { student_id: IDS.hana, trial_class_id: IDS.forces }, wei);
    assert.equal(created.status, 201);

    const reader = stream.body!.getReader();
    const decoder = new TextDecoder();
    let text = '';
    while (!text.includes('event: change')) {
      const { value, done } = await reader.read();
      if (done) break;
      text += decoder.decode(value, { stream: true });
    }
    ac.abort();
    assert.match(text, /event: change/);
    assert.match(text, /"type":"booking_created"/);
    assert.match(text, new RegExp(`"booking_id":"${created.body.booking.id}"`));
  });

  it('validates input', async () => {
    const maria = await login('maria', PASSWORDS.parent);
    const res = await post('/api/bookings', { student_id: IDS.sofia }, maria);
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION');
    const bad = await fetch(base + '/api/bookings', { method: 'POST', headers: { cookie: maria }, body: '{not json' });
    assert.equal(bad.status, 400);
  });

  it('lets an admin run the background jobs on demand', async () => {
    const admin = await login('admin', PASSWORDS.admin);
    const expiry = await post('/api/admin/jobs/expire-pending', {}, admin);
    assert.equal(expiry.status, 200);
    assert.equal(typeof expiry.body.expired, 'number');
    const refunds = await post('/api/admin/jobs/retry-refunds', {}, admin);
    assert.equal(refunds.status, 200);
    assert.deepEqual(refunds.body, { retried: 0, refunded: 0, still_pending: 0 });
  });
});
