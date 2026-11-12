'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { makeHandlers } = require('../src/handlers');
const { validateTrip, serverSessionId, isCounted, ValidationError } = require('../src/trips');
const { requireUser } = require('../src/auth');
const { makeFakeRepo } = require('./fakeRepo');

const alice = { uid: 'alice-uid', name: 'Alice', email: 'alice@example.com' };
const bob = { uid: 'bob-uid', name: 'Bob', email: 'bob@example.com' };

function sampleTrip(overrides = {}) {
  const start = 1731440000000;
  const samples = Array.from({ length: 10 }, (_, i) => ({
    timestamp: start + i * 60000,
    latitude: 43.45 + i * 0.002,
    longitude: -80.49 - i * 0.002,
    speedKmh: 40 + i,
    accelerationMs2: 0.5,
    ...(i % 2 === 0 ? { speedLimitKmh: 50 } : {}),
  }));
  return {
    id: `session-${start}`,
    startedAt: start,
    endedAt: start + 600000,
    durationSec: 600,
    distanceKm: 5.2,
    averageSpeedKmh: 31,
    maxSpeedKmh: 49,
    averageAccelerationMs2: 0.5,
    score: 88,
    grade: 'Excellent',
    speedLimitCoverage: 0.5,
    appVersion: '1.0.0',
    samples,
    ...overrides,
  };
}

async function withConsent(h, user) {
  await h.putConsent({ user, body: { version: 1 } });
}

test('trips are refused until the user has agreed to upload', async () => {
  const h = makeHandlers(makeFakeRepo());
  const res = await h.postTrip({ user: alice, body: sampleTrip() });
  assert.equal(res.status, 403);
  assert.equal(res.body.error, 'consent_required');
});

test('consent is saved and read back', async () => {
  const h = makeHandlers(makeFakeRepo());
  assert.equal((await h.getConsent({ user: alice })).body.consentVersion, 0);
  await withConsent(h, alice);
  const res = await h.getConsent({ user: alice });
  assert.equal(res.body.consentVersion, 1);
  assert.ok(res.body.consentAt > 0);
});

test('consent version must be a positive whole number', async () => {
  const h = makeHandlers(makeFakeRepo());
  await assert.rejects(h.putConsent({ user: alice, body: { version: 'yes' } }), ValidationError);
  await assert.rejects(h.putConsent({ user: alice, body: {} }), ValidationError);
});

test('a trip is stored with its GPS readings', async () => {
  const repo = makeFakeRepo();
  const h = makeHandlers(repo);
  await withConsent(h, alice);
  const res = await h.postTrip({ user: alice, body: sampleTrip() });
  assert.equal(res.status, 201);
  assert.deepEqual(res.body, { id: 'session-1731440000000', created: true, counted: true, readings: 10 });
  assert.equal(repo.sessions.size, 1);
  assert.equal(repo.readings.length, 10);

  const row = [...repo.sessions.values()][0];
  assert.equal(row.user_id, 'alice-uid');
  assert.equal(row.grade, 'Excellent');
  assert.equal(row.speed_limit_coverage, 0.5);
  assert.deepEqual(JSON.parse(row.route_summary).points, 10);
  assert.equal(repo.readings[0].speed_limit, 50);
  assert.equal(repo.readings[1].speed_limit, null);
  assert.ok(repo.readings[0].ts instanceof Date);
});

test('sending the same trip twice does not duplicate it', async () => {
  const repo = makeFakeRepo();
  const h = makeHandlers(repo);
  await withConsent(h, alice);
  await h.postTrip({ user: alice, body: sampleTrip() });
  const again = await h.postTrip({ user: alice, body: sampleTrip() });
  assert.equal(again.status, 200);
  assert.equal(again.body.created, false);
  assert.equal(repo.sessions.size, 1);
  assert.equal(repo.readings.length, 10);
});

test('two users can upload trips with the same app id', async () => {
  const repo = makeFakeRepo();
  const h = makeHandlers(repo);
  await withConsent(h, alice);
  await withConsent(h, bob);
  assert.equal((await h.postTrip({ user: alice, body: sampleTrip() })).status, 201);
  assert.equal((await h.postTrip({ user: bob, body: sampleTrip() })).status, 201);
  assert.equal(repo.sessions.size, 2);
  assert.notEqual(serverSessionId('alice-uid', 'x'), serverSessionId('bob-uid', 'x'));
  assert.equal(serverSessionId('alice-uid', 'x').length, 64);
});

test('short trips are stored but not counted toward the score', async () => {
  const h = makeHandlers(makeFakeRepo());
  await withConsent(h, alice);
  const res = await h.postTrip({ user: alice, body: sampleTrip({ durationSec: 120, distanceKm: 0.8 }) });
  assert.equal(res.status, 201);
  assert.equal(res.body.counted, false);
  assert.equal(isCounted({ durationSec: 300, distanceKm: 2, averageSpeedKmh: 8 }), true);
  assert.equal(isCounted({ durationSec: 299, distanceKm: 2, averageSpeedKmh: 8 }), false);
});

test('users only see and delete their own trips', async () => {
  const h = makeHandlers(makeFakeRepo());
  await withConsent(h, alice);
  await withConsent(h, bob);
  await h.postTrip({ user: alice, body: sampleTrip() });
  await h.postTrip({ user: alice, body: sampleTrip({ id: 'session-2', startedAt: 1731500000000, endedAt: 1731500600000 }) });
  await h.postTrip({ user: bob, body: sampleTrip() });

  const list = await h.listTrips({ user: alice, query: {} });
  assert.equal(list.body.trips.length, 2);
  assert.equal(list.body.trips[0].id, 'session-2'); // newest first
  assert.equal(list.body.trips[0].counted, true);

  const one = await h.getTrip({ user: alice, params: { id: 'session-1731440000000' } });
  assert.equal(one.status, 200);
  assert.equal(one.body.samples.length, 10);
  assert.equal(one.body.samples[0].speedLimitKmh, 50);
  assert.equal((await h.getTrip({ user: bob, params: { id: 'session-2' } })).status, 404);

  const del = await h.deleteTrips({ user: alice });
  assert.equal(del.body.deleted, 2);
  assert.equal((await h.listTrips({ user: alice, query: {} })).body.trips.length, 0);
  assert.equal((await h.listTrips({ user: bob, query: {} })).body.trips.length, 1);
});

test('list limit is capped at 200', async () => {
  let asked;
  const repo = { ...makeFakeRepo(), listTrips: async (uid, limit) => { asked = limit; return []; } };
  const h = makeHandlers(repo);
  await h.listTrips({ user: alice, query: { limit: '9999' } });
  assert.equal(asked, 200);
  await h.listTrips({ user: alice, query: { limit: 'abc' } });
  assert.equal(asked, 50);
});

test('bad trips are rejected with a clear message', () => {
  const bad = [
    [null, /JSON object/],
    [sampleTrip({ id: '' }), /id must be/],
    [sampleTrip({ id: 'x'.repeat(65) }), /id must be/],
    [sampleTrip({ endedAt: 1 }), /endedAt/],
    [sampleTrip({ score: 140 }), /score must be between/],
    [sampleTrip({ distanceKm: 'far' }), /distanceKm must be a number/],
    [sampleTrip({ grade: 'A+' }), /grade must be one of/],
    [sampleTrip({ samples: 'nope' }), /samples must be an array/],
    [sampleTrip({ samples: [{ timestamp: 1, latitude: 95, longitude: 0, speedKmh: 1 }] }), /samples\[0\]\.latitude/],
    [sampleTrip({ maxSpeedKmh: Number.NaN }), /maxSpeedKmh must be a number/],
  ];
  for (const [body, pattern] of bad) {
    assert.throws(() => validateTrip(body), (err) => err instanceof ValidationError && pattern.test(err.message));
  }
});

test('optional fields can be left out', () => {
  const trip = sampleTrip();
  delete trip.score;
  delete trip.grade;
  delete trip.speedLimitCoverage;
  delete trip.averageAccelerationMs2;
  delete trip.appVersion;
  const clean = validateTrip(trip);
  assert.equal(clean.score, null);
  assert.equal(clean.grade, null);
  assert.equal(clean.appVersion, null);
});

// ---- auth middleware (fake req/res, no Express needed) ----

function fakeReqRes(headers) {
  const lower = Object.fromEntries(Object.entries(headers).map(([k, v]) => [k.toLowerCase(), v]));
  const req = { get: (name) => lower[name.toLowerCase()] };
  const res = {
    statusCode: 200,
    body: null,
    status(code) { this.statusCode = code; return this; },
    json(body) { this.body = body; return this; },
  };
  return { req, res };
}

async function runAuth(verify, headers, options) {
  const { req, res } = fakeReqRes(headers);
  let called = false;
  await requireUser(verify, options)(req, res, () => { called = true; });
  return { req, res, called };
}

test('auth: a valid Firebase token sets req.user', async () => {
  const verify = async (t) => {
    assert.equal(t, 'good-token');
    return { uid: 'alice-uid', name: 'Alice', email: 'alice@example.com', email_verified: true };
  };
  const { req, called } = await runAuth(verify, { Authorization: 'Bearer good-token' });
  assert.equal(called, true);
  assert.deepEqual(req.user, alice);
});

test('auth: missing, invalid and unverified tokens are refused', async () => {
  const verify = async (t) => {
    if (t === 'unverified') return { uid: 'u', email: 'u@example.com', email_verified: false };
    throw new Error('bad token');
  };
  let r = await runAuth(verify, {});
  assert.equal(r.res.statusCode, 401);
  assert.equal(r.called, false);
  r = await runAuth(verify, { Authorization: 'Bearer nope' });
  assert.equal(r.res.statusCode, 401);
  r = await runAuth(verify, { Authorization: 'Bearer unverified' });
  assert.equal(r.res.statusCode, 403);
  assert.equal(r.called, false);
});

test('auth: X-Debug-Uid only works when the dev bypass is on', async () => {
  const verify = async () => { throw new Error('no'); };
  let r = await runAuth(verify, { 'X-Debug-Uid': 'tester' });
  assert.equal(r.res.statusCode, 401);
  r = await runAuth(verify, { 'X-Debug-Uid': 'tester' }, { devBypass: true });
  assert.equal(r.called, true);
  assert.equal(r.req.user.uid, 'tester');
});
