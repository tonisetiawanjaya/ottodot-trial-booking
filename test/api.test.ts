import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type http from 'node:http';
import { createApp } from '../src/server.ts';
import { CARD_DECLINED, CARD_OK, IDS, confirmedCount, makeService } from './helpers.ts';

/** End-to-end over real HTTP: the same flow the UI drives. */
describe('HTTP API', () => {
  let server: http.Server;
  let base: string;
  const ctx = makeService();

  before(async () => {
    server = createApp(ctx.service);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });
  after(() => server.close());

  const get = async (path: string) => {
    const res = await fetch(base + path);
    return { status: res.status, body: await res.json() };
  };
  const post = async (path: string, body: unknown = {}) => {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, body: await res.json() };
  };

  it('serves the parent UI and the admin UI', async () => {
    for (const path of ['/', '/admin']) {
      const res = await fetch(base + path);
      assert.equal(res.status, 200);
      assert.match(res.headers.get('content-type') ?? '', /text\/html/);
    }
    const missing = await fetch(base + '/nope.html');
    assert.equal(missing.status, 404);
  });

  it('lists classes with seat counts', async () => {
    const { status, body } = await get('/api/trial-classes');
    assert.equal(status, 200);
    const fractions = body.find((c: { id: string }) => c.id === IDS.fractions);
    assert.equal(fractions.confirmed_count, 3);
    assert.equal(fractions.seats_available, 1);
  });

  it('runs the whole flow: create -> pay -> status -> roster', async () => {
    const created = await post('/api/bookings', { student_id: IDS.sofia, trial_class_id: IDS.forces });
    assert.equal(created.status, 201);
    assert.equal(created.body.booking.status, 'pending_payment');
    const id = created.body.booking.id;

    const paid = await post(`/api/bookings/${id}/pay`, { card: CARD_OK });
    assert.equal(paid.status, 200);
    assert.equal(paid.body.outcome, 'confirmed');

    const detail = await get(`/api/bookings/${id}`);
    assert.equal(detail.body.booking.status, 'confirmed');
    assert.equal(detail.body.payment_attempts[0].status, 'succeeded');

    const roster = await get(`/api/admin/trial-classes/${IDS.forces}/roster`);
    assert.deepEqual(roster.body.confirmed.map((r: { student_id: string }) => r.student_id), [IDS.sofia]);
  });

  it('returns 409 DUPLICATE_BOOKING and 409 CLASS_FULL', async () => {
    const dup = await post('/api/bookings', { student_id: IDS.ethan, trial_class_id: IDS.fractions });
    assert.equal(dup.status, 409);
    assert.equal(dup.body.error.code, 'DUPLICATE_BOOKING');

    const full = await post('/api/bookings', { student_id: IDS.sofia, trial_class_id: IDS.electricity });
    assert.equal(full.status, 409);
    assert.equal(full.body.error.code, 'CLASS_FULL');
  });

  it('records a declined payment without touching the roster', async () => {
    const created = await post('/api/bookings', { student_id: IDS.arjun, trial_class_id: IDS.forces });
    const paid = await post(`/api/bookings/${created.body.booking.id}/pay`, { card: CARD_DECLINED });
    assert.equal(paid.body.outcome, 'payment_failed');
    assert.equal(paid.body.booking.status, 'payment_failed');
    const roster = await get(`/api/admin/trial-classes/${IDS.forces}/roster`);
    assert.ok(!roster.body.confirmed.some((r: { student_id: string }) => r.student_id === IDS.arjun));
  });

  it('last-seat race over HTTP: two concurrent payments, only one confirmed', async () => {
    // Two different families, same last seat in P4 Math.
    const a = (await post('/api/bookings', { student_id: IDS.sofia, trial_class_id: IDS.fractions })).body.booking;
    const b = (await post('/api/bookings', { student_id: IDS.lucas, trial_class_id: IDS.fractions })).body.booking;

    // A's provider is slow (200 ms), B's is fast: B completes first.
    const [resA, resB] = await Promise.all([
      post(`/api/bookings/${a.id}/pay`, { card: CARD_OK, delay_ms: 200 }),
      post(`/api/bookings/${b.id}/pay`, { card: CARD_OK, delay_ms: 0 }),
    ]);

    assert.equal(resB.body.outcome, 'confirmed');
    assert.equal(resA.body.outcome, 'refunded');
    assert.equal(resA.body.booking.status_reason, 'seat_taken');
    assert.equal(resA.body.attempt.status, 'refunded');
    assert.equal(confirmedCount(ctx.db, IDS.fractions), 4);

    const roster = await get(`/api/admin/trial-classes/${IDS.fractions}/roster`);
    assert.equal(roster.body.confirmed.length, 4);
    assert.equal(roster.body.pending.length, 0);
  });

  it('validates input', async () => {
    const res = await post('/api/bookings', { student_id: IDS.sofia });
    assert.equal(res.status, 400);
    assert.equal(res.body.error.code, 'VALIDATION');
    const bad = await fetch(base + '/api/bookings', { method: 'POST', body: '{not json' });
    assert.equal(bad.status, 400);
  });

  it('runs the expiry job on demand', async () => {
    const res = await post('/api/admin/jobs/expire-pending');
    assert.equal(res.status, 200);
    assert.equal(typeof res.body.expired, 'number');
  });
});
