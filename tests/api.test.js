'use strict';
// Tests for the WatchAccuracy API
// Run with: node --test tests/api.test.js

const { test, before, after } = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');
const fs = require('fs');

// Use an in-memory / tmp DB for tests
const tmpDb = path.join('/tmp', `watchaccuracy-test-${Date.now()}.db`);
process.env.DB_PATH = tmpDb;

const app = require('../server');
const http = require('http');

let server;
let baseUrl;
let cookieJar = '';
let watchId;

// ─── HTTP helper ────────────────────────────────────────────────────────────
function req(method, path, body, extraHeaders = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(path, baseUrl);
    const bodyStr = body ? JSON.stringify(body) : '';
    const headers = {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(bodyStr),
      Cookie: cookieJar,
      ...extraHeaders
    };
    const options = {
      hostname: url.hostname,
      port: url.port,
      path: url.pathname + url.search,
      method,
      headers
    };
    const r = http.request(options, res => {
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => {
        // Capture set-cookie
        const sc = res.headers['set-cookie'];
        if (sc) cookieJar = sc.map(c => c.split(';')[0]).join('; ');
        try { resolve({ status: res.statusCode, body: JSON.parse(data) }); }
        catch { resolve({ status: res.statusCode, body: data }); }
      });
    });
    r.on('error', reject);
    if (bodyStr) r.write(bodyStr);
    r.end();
  });
}

before(() => {
  return new Promise((resolve) => {
    server = app.listen(0, () => {
      baseUrl = `http://127.0.0.1:${server.address().port}`;
      resolve();
    });
  });
});

after(() => {
  server.close();
  try { fs.unlinkSync(tmpDb); } catch {}
});

// ─── Tests ──────────────────────────────────────────────────────────────────

test('GET /api/me returns a userId and sets cookie', async () => {
  const r = await req('GET', '/api/me');
  assert.equal(r.status, 200);
  assert.ok(r.body.userId, 'userId should be present');
  assert.ok(cookieJar.includes('wa_uid'), 'cookie should be set');
});

test('GET /api/watches returns empty array initially', async () => {
  const r = await req('GET', '/api/watches');
  assert.equal(r.status, 200);
  assert.deepEqual(r.body, []);
});

test('POST /api/watches creates a watch', async () => {
  const r = await req('POST', '/api/watches', {
    brand: 'Seiko',
    model: 'SKX007',
    notes: 'Test watch',
    is_public: 0
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.brand, 'Seiko');
  assert.equal(r.body.model, 'SKX007');
  assert.ok(r.body.id, 'id should be present');
  watchId = r.body.id;
});

test('GET /api/watches returns the created watch', async () => {
  const r = await req('GET', '/api/watches');
  assert.equal(r.status, 200);
  assert.equal(r.body.length, 1);
  assert.equal(r.body[0].id, watchId);
});

test('GET /api/watches/:id returns watch details', async () => {
  const r = await req('GET', `/api/watches/${watchId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.brand, 'Seiko');
});

test('PUT /api/watches/:id updates the watch', async () => {
  const r = await req('PUT', `/api/watches/${watchId}`, {
    brand: 'Seiko',
    model: 'SKX007',
    notes: 'Updated notes',
    is_public: 1
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.notes, 'Updated notes');
  assert.equal(r.body.is_public, 1);
});

test('POST /api/watches/:id/reference sets a reference point', async () => {
  const deviceTs = Date.now();
  const watchTimeSeconds = 12 * 3600; // 12:00:00
  const r = await req('POST', `/api/watches/${watchId}/reference`, {
    device_timestamp: deviceTs,
    watch_time_seconds: watchTimeSeconds
  });
  assert.equal(r.status, 201);
  assert.equal(r.body.watch_time_seconds, watchTimeSeconds);
});

test('GET /api/watches/:id/reference returns the reference', async () => {
  const r = await req('GET', `/api/watches/${watchId}/reference`);
  assert.equal(r.status, 200);
  assert.ok(r.body, 'reference should exist');
  assert.equal(r.body.watch_id, watchId);
});

test('POST /api/watches/:id/measurements records drift correctly', async () => {
  // Set up: reference at 12:00:00, device time T0
  const T0 = Date.now() - 86400000; // 1 day ago
  await req('POST', `/api/watches/${watchId}/reference`, {
    device_timestamp: T0,
    watch_time_seconds: 12 * 3600 // 12:00:00
  });

  // Measure: 1 day later, watch shows 12:00:10 (10 seconds fast)
  const T1 = Date.now();
  const expectedWatchSeconds = (12 * 3600 + 86400) % 86400; // 12:00:00 + 24h = 12:00:00 next day
  const watchShowsH = Math.floor(expectedWatchSeconds / 3600);
  const watchShowsM = Math.floor((expectedWatchSeconds % 3600) / 60);
  const watchShowsS = Math.min((expectedWatchSeconds % 60) + 10, 59); // 10 seconds fast

  const r2 = await req('POST', `/api/watches/${watchId}/measurements`, {
    device_timestamp: T1,
    watch_hours:   watchShowsH,
    watch_minutes: watchShowsM,
    watch_seconds: watchShowsS,
    notes: 'Test measurement'
  });

  assert.equal(r2.status, 201);
  assert.ok(r2.body.drift_seconds !== null, 'drift_seconds should be calculated');
  assert.ok(r2.body.drift_rate_spd !== null, 'drift_rate_spd should be calculated');
});

test('GET /api/watches/:id/measurements returns measurements', async () => {
  const r = await req('GET', `/api/watches/${watchId}/measurements`);
  assert.equal(r.status, 200);
  assert.ok(r.body.length >= 1);
});

test('GET /api/leaderboard returns array', async () => {
  const r = await req('GET', '/api/leaderboard');
  assert.equal(r.status, 200);
  assert.ok(Array.isArray(r.body));
});

test('GET /api/benchmark/:brand/:model returns data', async () => {
  const r = await req('GET', '/api/benchmark/Seiko/SKX007');
  assert.equal(r.status, 200);
  assert.equal(r.body.brand, 'Seiko');
  assert.ok('watches' in r.body);
});

test('Access denied for another user watch', async () => {
  // Create a dedicated private watch owned by user1 for this test
  const privateWatch = await req('POST', '/api/watches', {
    brand: 'TestBrand', model: 'PrivateModel', is_public: 0
  });
  assert.equal(privateWatch.status, 201);
  const privateWatchId = privateWatch.body.id;

  const savedCookie = cookieJar;
  cookieJar = ''; // clear cookie → new user (user2)
  try {
    await req('GET', '/api/me'); // mint user2
    const r = await req('GET', `/api/watches/${privateWatchId}`);
    assert.equal(r.status, 403);
  } finally {
    cookieJar = savedCookie; // always restore user1
  }
});

test('Public watch is accessible by other users', async () => {
  const savedCookie = cookieJar;
  cookieJar = ''; // new user
  try {
    await req('GET', '/api/me');
    // watchId was set to public in the PUT test
    const r = await req('GET', `/api/watches/${watchId}`);
    assert.equal(r.status, 200);
    assert.equal(r.body.is_public, 1);
  } finally {
    cookieJar = savedCookie;
  }
});

test('DELETE /api/watches/:id/measurements/:id deletes measurement', async () => {
  const mList = await req('GET', `/api/watches/${watchId}/measurements`);
  const measId = mList.body[0].id;
  const r = await req('DELETE', `/api/watches/${watchId}/measurements/${measId}`);
  assert.equal(r.status, 200);
  assert.equal(r.body.ok, true);
});

test('POST reference: missing watch_time_seconds returns 400', async () => {
  const r = await req('POST', `/api/watches/${watchId}/reference`, {
    device_timestamp: Date.now()
  });
  assert.equal(r.status, 400);
});

test('calcDrift: day boundary wrapping works', () => {
  const { calcDrift } = require('../src/database');
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(':memory:');
  db.exec('PRAGMA foreign_keys = ON');
  // Bootstrap schema manually
  db.exec(`
    CREATE TABLE users (id TEXT PRIMARY KEY, created_at INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE watches (id TEXT PRIMARY KEY, user_id TEXT NOT NULL, brand TEXT DEFAULT '', model TEXT DEFAULT '', notes TEXT DEFAULT '', is_public INTEGER DEFAULT 0, created_at INTEGER DEFAULT 0);
    CREATE TABLE reference_points (id INTEGER PRIMARY KEY AUTOINCREMENT, watch_id TEXT NOT NULL, device_timestamp INTEGER NOT NULL, watch_time_seconds INTEGER NOT NULL, created_at INTEGER DEFAULT 0);
    CREATE TABLE measurements (id INTEGER PRIMARY KEY AUTOINCREMENT, watch_id TEXT NOT NULL, device_timestamp INTEGER NOT NULL, watch_hours INTEGER NOT NULL, watch_minutes INTEGER NOT NULL, watch_seconds INTEGER NOT NULL, drift_seconds REAL, drift_rate_spd REAL, photo_filename TEXT, notes TEXT DEFAULT '', created_at INTEGER DEFAULT 0);
  `);
  db.prepare('INSERT INTO users VALUES (?,?)').run('u1', 0);
  db.prepare('INSERT INTO watches VALUES (?,?,?,?,?,?,?)').run('w1','u1','','','',0,0);

  // Reference: T0, watch at 23:59:00
  const T0 = 1000000000000;
  const refSeconds = 23 * 3600 + 59 * 60; // 23:59:00
  db.prepare('INSERT INTO reference_points (watch_id, device_timestamp, watch_time_seconds) VALUES (?,?,?)').run('w1', T0, refSeconds);

  // Measure 1 hour later: watch shows 00:59:05 (should be 00:59:00, so +5s fast)
  const T1 = T0 + 3600 * 1000;
  const result = calcDrift(db, 'w1', 0, 59, 5, T1);
  assert.ok(result !== null);
  assert.ok(Math.abs(result.driftSeconds - 5) < 0.01, `Expected ~5s drift, got ${result.driftSeconds}`);
});
