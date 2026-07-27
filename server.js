'use strict';

const express = require('express');
const cookieParser = require('cookie-parser');
const rateLimit = require('express-rate-limit');
const path = require('path');
const fs = require('fs');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('./src/database');

const watchesRouter = require('./src/routes/watches');
const measurementsRouter = require('./src/routes/measurements');

const app = express();
const PORT = process.env.PORT || 3000;
const UPLOADS_DIR = process.env.UPLOADS_DIR || path.join(__dirname, 'uploads');
const IS_PRODUCTION = process.env.NODE_ENV === 'production';

// Ensure the uploads directory exists (important for Railway volumes)
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

// ─── Rate limiting ─────────────────────────────────────────────────────────────
// Apply a stricter limit only to measurement creation (file upload) to prevent
// storage abuse. General API calls get a generous limit.
const uploadLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  limit: 60,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

// ─── Middleware ────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cookieParser());

// Trust Railway's proxy so req.secure works correctly behind HTTPS termination
if (IS_PRODUCTION) app.set('trust proxy', 1);

// Serve uploaded photos
app.use('/uploads', express.static(UPLOADS_DIR));

// ─── Health check (used by Railway) ───────────────────────────────────────────
app.get('/health', (req, res) => {
  try {
    getDb(); // verify DB is reachable
    res.json({ status: 'ok' });
  } catch (err) {
    res.status(503).json({ status: 'error', message: err.message });
  }
});

// ─── User identity middleware ──────────────────────────────────────────────────
// Every request gets a user ID from a cookie (or a fresh one is minted).
app.use((req, res, next) => {
  let userId = req.cookies['wa_uid'];
  const db = getDb();

  if (!userId || !db.prepare('SELECT id FROM users WHERE id = ?').get(userId)) {
    userId = uuidv4();
    const maxAge = 10 * 365 * 24 * 60 * 60 * 1000; // 10 years
    res.cookie('wa_uid', userId, {
      httpOnly: true,
      sameSite: 'lax',
      secure: IS_PRODUCTION, // enforce HTTPS on Railway
      maxAge,
      path: '/'
    });
    db.prepare('INSERT OR IGNORE INTO users (id) VALUES (?)').run(userId);
  }

  req.userId = userId;
  next();
});

// ─── API ───────────────────────────────────────────────────────────────────────
app.get('/api/me', (req, res) => {
  res.json({ userId: req.userId });
});

app.use('/api/watches', watchesRouter);
// Rate-limit measurement creation (POST), but not reads
app.use('/api/watches/:watchId/measurements', (req, res, next) => {
  if (req.method === 'POST') return uploadLimiter(req, res, next);
  next();
}, measurementsRouter);

// ─── Benchmarking ─────────────────────────────────────────────────────────────
// GET /api/benchmark/:brand/:model
// Returns aggregated drift rates for all PUBLIC watches of this brand/model.
app.get('/api/benchmark/:brand/:model', (req, res) => {
  const db = getDb();
  const { brand, model } = req.params;

  const rows = db
    .prepare(
      `SELECT w.id AS watch_id, w.brand, w.model,
              COUNT(m.id) AS measurements,
              AVG(m.drift_rate_spd) AS avg_drift_rate_spd,
              MIN(m.drift_rate_spd) AS min_drift_rate_spd,
              MAX(m.drift_rate_spd) AS max_drift_rate_spd
       FROM watches w
       JOIN measurements m ON m.watch_id = w.id
       WHERE w.is_public = 1
         AND LOWER(w.brand) = LOWER(?)
         AND LOWER(w.model) = LOWER(?)
         AND m.drift_rate_spd IS NOT NULL
       GROUP BY w.id`
    )
    .all(brand, model);

  const totalMeasurements = rows.reduce((a, r) => a + r.measurements, 0);
  const avgAll =
    rows.length > 0
      ? rows.reduce((a, r) => a + r.avg_drift_rate_spd * r.measurements, 0) / (totalMeasurements || 1)
      : null;

  res.json({
    brand,
    model,
    watches: rows.length,
    total_measurements: totalMeasurements,
    avg_drift_rate_spd: avgAll,
    entries: rows
  });
});

// ─── Leaderboard ──────────────────────────────────────────────────────────────
// GET /api/leaderboard - most accurate watches (public, with >= 3 measurements)
app.get('/api/leaderboard', (req, res) => {
  const db = getDb();
  const rows = db
    .prepare(
      `SELECT w.brand, w.model,
              COUNT(DISTINCT w.id) AS watch_count,
              COUNT(m.id) AS total_measurements,
              AVG(ABS(m.drift_rate_spd)) AS avg_abs_drift_spd
       FROM watches w
       JOIN measurements m ON m.watch_id = w.id
       WHERE w.is_public = 1
         AND w.brand != ''
         AND w.model != ''
         AND m.drift_rate_spd IS NOT NULL
       GROUP BY LOWER(w.brand), LOWER(w.model)
       HAVING COUNT(m.id) >= 3
       ORDER BY avg_abs_drift_spd ASC
       LIMIT 50`
    )
    .all();
  res.json(rows);
});

// ─── Static frontend ──────────────────────────────────────────────────────────
app.use(express.static(path.join(__dirname, 'public')));

// SPA fallback – send index.html for all non-API routes so the frontend
// router can handle deep links.
app.get('*', (req, res) => {
  if (req.path.startsWith('/api/') || req.path.startsWith('/uploads/')) {
    return res.status(404).json({ error: 'Not found' });
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ─── Start ────────────────────────────────────────────────────────────────────
if (require.main === module) {
  app.listen(PORT, () => {
    console.log(`WatchAccuracy server running at http://localhost:${PORT}`);
  });
}

module.exports = app;
