'use strict';

const express = require('express');
const { v4: uuidv4 } = require('uuid');
const { getDb } = require('../database');

const router = express.Router();

// GET /api/watches - list current user's watches
router.get('/', (req, res) => {
  const db = getDb();
  const watches = db
    .prepare(
      `SELECT w.*,
              (SELECT COUNT(*) FROM measurements m WHERE m.watch_id = w.id) AS measurement_count,
              (SELECT m.drift_rate_spd FROM measurements m WHERE m.watch_id = w.id
               ORDER BY m.device_timestamp DESC LIMIT 1) AS latest_drift_rate
       FROM watches w
       WHERE w.user_id = ?
       ORDER BY w.created_at DESC`
    )
    .all(req.userId);
  res.json(watches);
});

// POST /api/watches - create new watch
router.post('/', (req, res) => {
  const { brand = '', model = '', notes = '', is_public = 0 } = req.body;
  const db = getDb();
  const id = uuidv4();
  db.prepare(
    `INSERT INTO watches (id, user_id, brand, model, notes, is_public) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(id, req.userId, brand, model, notes, is_public ? 1 : 0);
  const watch = db.prepare('SELECT * FROM watches WHERE id = ?').get(id);
  res.status(201).json(watch);
});

// GET /api/watches/:id - get watch details (public or owned)
router.get('/:id', (req, res) => {
  const db = getDb();
  const watch = db.prepare('SELECT * FROM watches WHERE id = ?').get(req.params.id);
  if (!watch) return res.status(404).json({ error: 'Watch not found' });
  if (watch.user_id !== req.userId && !watch.is_public) {
    return res.status(403).json({ error: 'Access denied' });
  }
  res.json(watch);
});

// PUT /api/watches/:id - update watch (owner only)
router.put('/:id', (req, res) => {
  const db = getDb();
  const watch = db.prepare('SELECT * FROM watches WHERE id = ?').get(req.params.id);
  if (!watch) return res.status(404).json({ error: 'Watch not found' });
  if (watch.user_id !== req.userId) return res.status(403).json({ error: 'Access denied' });

  const { brand = watch.brand, model = watch.model, notes = watch.notes, is_public } = req.body;
  const publicFlag = is_public !== undefined ? (is_public ? 1 : 0) : watch.is_public;
  db.prepare(
    `UPDATE watches SET brand=?, model=?, notes=?, is_public=? WHERE id=?`
  ).run(brand, model, notes, publicFlag, req.params.id);
  res.json(db.prepare('SELECT * FROM watches WHERE id = ?').get(req.params.id));
});

// DELETE /api/watches/:id - delete watch (owner only)
router.delete('/:id', (req, res) => {
  const db = getDb();
  const watch = db.prepare('SELECT * FROM watches WHERE id = ?').get(req.params.id);
  if (!watch) return res.status(404).json({ error: 'Watch not found' });
  if (watch.user_id !== req.userId) return res.status(403).json({ error: 'Access denied' });

  db.prepare('DELETE FROM measurements WHERE watch_id = ?').run(req.params.id);
  db.prepare('DELETE FROM reference_points WHERE watch_id = ?').run(req.params.id);
  db.prepare('DELETE FROM watches WHERE id = ?').run(req.params.id);
  res.json({ ok: true });
});

// GET /api/watches/:id/reference - get latest reference point
router.get('/:id/reference', (req, res) => {
  const db = getDb();
  const watch = db.prepare('SELECT * FROM watches WHERE id = ?').get(req.params.id);
  if (!watch) return res.status(404).json({ error: 'Watch not found' });
  if (watch.user_id !== req.userId && !watch.is_public) {
    return res.status(403).json({ error: 'Access denied' });
  }
  const ref = db
    .prepare(
      'SELECT * FROM reference_points WHERE watch_id = ? ORDER BY device_timestamp DESC LIMIT 1'
    )
    .get(req.params.id);
  res.json(ref || null);
});

// POST /api/watches/:id/reference - set a new reference/sync point
router.post('/:id/reference', (req, res) => {
  const db = getDb();
  const watch = db.prepare('SELECT * FROM watches WHERE id = ?').get(req.params.id);
  if (!watch) return res.status(404).json({ error: 'Watch not found' });
  if (watch.user_id !== req.userId) return res.status(403).json({ error: 'Access denied' });

  const { device_timestamp = Date.now(), watch_time_seconds } = req.body;
  if (watch_time_seconds === undefined || watch_time_seconds === null) {
    return res.status(400).json({ error: 'watch_time_seconds is required' });
  }

  const result = db
    .prepare(
      `INSERT INTO reference_points (watch_id, device_timestamp, watch_time_seconds) VALUES (?, ?, ?)`
    )
    .run(req.params.id, device_timestamp, watch_time_seconds);
  const ref = db
    .prepare('SELECT * FROM reference_points WHERE id = ?')
    .get(result.lastInsertRowid);
  res.status(201).json(ref);
});

module.exports = router;
