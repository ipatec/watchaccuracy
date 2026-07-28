'use strict';

const { DatabaseSync } = require('node:sqlite');
const path = require('path');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, '..', 'watchaccuracy.db');

let _db = null;

function getDb() {
  if (_db) return _db;
  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA journal_mode = WAL');
  _db.exec('PRAGMA foreign_keys = ON');
  initSchema(_db);
  return _db;
}

function initSchema(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000)
    );

    CREATE TABLE IF NOT EXISTS watches (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      brand TEXT NOT NULL DEFAULT '',
      model TEXT NOT NULL DEFAULT '',
      notes TEXT NOT NULL DEFAULT '',
      is_public INTEGER NOT NULL DEFAULT 0,
      write_token TEXT,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS reference_points (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watch_id TEXT NOT NULL,
      device_timestamp INTEGER NOT NULL,
      watch_time_seconds INTEGER NOT NULL,
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
      FOREIGN KEY (watch_id) REFERENCES watches(id)
    );

    CREATE TABLE IF NOT EXISTS measurements (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      watch_id TEXT NOT NULL,
      device_timestamp INTEGER NOT NULL,
      watch_hours INTEGER NOT NULL,
      watch_minutes INTEGER NOT NULL,
      watch_seconds INTEGER NOT NULL,
      drift_seconds REAL,
      drift_rate_spd REAL,
      photo_filename TEXT,
      notes TEXT NOT NULL DEFAULT '',
      created_at INTEGER NOT NULL DEFAULT (CAST(strftime('%s', 'now') AS INTEGER) * 1000),
      FOREIGN KEY (watch_id) REFERENCES watches(id)
    );

    CREATE INDEX IF NOT EXISTS idx_watches_user ON watches(user_id);
    CREATE INDEX IF NOT EXISTS idx_ref_watch ON reference_points(watch_id);
    CREATE INDEX IF NOT EXISTS idx_meas_watch ON measurements(watch_id);
    CREATE INDEX IF NOT EXISTS idx_meas_brand ON watches(brand, model);
  `);

  // Migration: add write_token column to existing databases
  try { db.exec('ALTER TABLE watches ADD COLUMN write_token TEXT'); } catch {}
  // Fill in tokens for any watches that don't have one yet
  db.exec("UPDATE watches SET write_token = lower(hex(randomblob(16))) WHERE write_token IS NULL");
}

/**
 * Calculate drift relative to the most recent reference point before the given device_timestamp.
 * Returns { driftSeconds, driftRateSpd } or null if no reference found.
 * driftSeconds: positive = watch is fast, negative = watch is slow
 * driftRateSpd: drift rate in seconds per day
 */
function calcDrift(db, watchId, watchH, watchM, watchS, deviceTimestampMs) {
  const ref = db
    .prepare(
      `SELECT * FROM reference_points
       WHERE watch_id = ? AND device_timestamp <= ?
       ORDER BY device_timestamp DESC LIMIT 1`
    )
    .get(watchId, deviceTimestampMs);

  if (!ref) return null;

  const elapsedMs = deviceTimestampMs - ref.device_timestamp;
  if (elapsedMs <= 0) return null;

  const measWatchSeconds = watchH * 3600 + watchM * 60 + watchS;
  const refWatchSeconds = ref.watch_time_seconds;

  // Raw difference in seconds (what the watch shows vs what it should show)
  const rawDiff = measWatchSeconds - refWatchSeconds;

  // Expected elapsed seconds on the watch (device elapsed time)
  const expectedElapsedS = elapsedMs / 1000;

  // Reconstruct watch elapsed time: rawDiff is always in (-86400, 86400) because
  // both values are time-of-day seconds. We find the integer N such that
  // rawDiff + N*86400 is closest to expectedElapsedS (handles midnight crossings
  // and multi-day measurements correctly).
  const N = Math.round((expectedElapsedS - rawDiff) / 86400);
  const watchElapsedS = rawDiff + N * 86400;

  const driftSeconds = watchElapsedS - expectedElapsedS;
  const elapsedDays = elapsedMs / 86400000;
  const driftRateSpd = elapsedDays > 0 ? driftSeconds / elapsedDays : 0;

  return { driftSeconds, driftRateSpd };
}

module.exports = { getDb, calcDrift };
