'use strict';

const express = require('express');
const path = require('path');
const multer = require('multer');
const { getDb, calcDrift } = require('../database');

const router = express.Router({ mergeParams: true });

const storage = multer.diskStorage({
  destination: process.env.UPLOADS_DIR || path.join(__dirname, '..', '..', 'uploads'),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname) || '.jpg';
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  }
});
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10 MB max
  fileFilter: (req, file, cb) => {
    if (file.mimetype.startsWith('image/')) cb(null, true);
    else cb(new Error('Only images are allowed'));
  }
});

// GET /api/watches/:watchId/measurements
router.get('/', (req, res) => {
  const db = getDb();
  const watch = db.prepare('SELECT * FROM watches WHERE id = ?').get(req.params.watchId);
  if (!watch) return res.status(404).json({ error: 'Watch not found' });
  if (watch.user_id !== req.userId && !watch.is_public) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const measurements = db
    .prepare(
      `SELECT * FROM measurements WHERE watch_id = ? ORDER BY device_timestamp ASC`
    )
    .all(req.params.watchId);
  res.json(measurements);
});

// POST /api/watches/:watchId/measurements
router.post('/', upload.single('photo'), (req, res) => {
  const db = getDb();
  const watch = db.prepare('SELECT * FROM watches WHERE id = ?').get(req.params.watchId);
  if (!watch) return res.status(404).json({ error: 'Watch not found' });
  if (watch.user_id !== req.userId) return res.status(403).json({ error: 'Access denied' });

  const {
    device_timestamp = Date.now(),
    watch_hours,
    watch_minutes,
    watch_seconds,
    notes = ''
  } = req.body;

  const h = parseInt(watch_hours, 10);
  const m = parseInt(watch_minutes, 10);
  const s = parseInt(watch_seconds, 10);

  if (isNaN(h) || isNaN(m) || isNaN(s)) {
    return res.status(400).json({ error: 'watch_hours, watch_minutes, watch_seconds are required' });
  }
  if (h < 0 || h > 23 || m < 0 || m > 59 || s < 0 || s > 59) {
    return res.status(400).json({ error: 'Invalid time values' });
  }

  const ts = parseInt(device_timestamp, 10);
  const drift = calcDrift(db, req.params.watchId, h, m, s, ts);

  const result = db
    .prepare(
      `INSERT INTO measurements
       (watch_id, device_timestamp, watch_hours, watch_minutes, watch_seconds,
        drift_seconds, drift_rate_spd, photo_filename, notes)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run(
      req.params.watchId, ts, h, m, s,
      drift ? drift.driftSeconds : null,
      drift ? drift.driftRateSpd : null,
      req.file ? req.file.filename : null,
      notes
    );

  const measurement = db
    .prepare('SELECT * FROM measurements WHERE id = ?')
    .get(result.lastInsertRowid);
  res.status(201).json(measurement);
});

// DELETE /api/watches/:watchId/measurements/:id
router.delete('/:id', (req, res) => {
  const db = getDb();
  const watch = db.prepare('SELECT * FROM watches WHERE id = ?').get(req.params.watchId);
  if (!watch) return res.status(404).json({ error: 'Watch not found' });
  if (watch.user_id !== req.userId) return res.status(403).json({ error: 'Access denied' });

  const meas = db
    .prepare('SELECT * FROM measurements WHERE id = ? AND watch_id = ?')
    .get(req.params.id, req.params.watchId);
  if (!meas) return res.status(404).json({ error: 'Measurement not found' });

  db.prepare('DELETE FROM measurements WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

module.exports = router;
