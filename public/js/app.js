/* jshint esversion: 11 */
'use strict';

// ─── API helpers ────────────────────────────────────────────────────────────
async function api(method, path, body, isFormData = false) {
  const opts = {
    method,
    credentials: 'same-origin'
  };
  if (body) {
    if (isFormData) {
      opts.body = body;
    } else {
      opts.headers = { 'Content-Type': 'application/json' };
      opts.body = JSON.stringify(body);
    }
  }
  const res = await fetch(path, opts);
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`);
  return data;
}

const GET    = (p)       => api('GET', p);
const POST   = (p, b, f) => api('POST', p, b, f);
const PUT    = (p, b)    => api('PUT', p, b);
const DEL    = (p)       => api('DELETE', p);

// ─── State ──────────────────────────────────────────────────────────────────
let currentWatchId = null;
let driftChart = null;
let cameraStream = null;
let capturedPhotoBlob = null;
let syncClockInterval = null;
let myUserId = null;

// ─── Router (hash-based) ─────────────────────────────────────────────────────
const routes = {};

function route(hash, fn) { routes[hash] = fn; }

function navigate(hash) {
  history.pushState(null, '', hash);
  handleRoute(hash);
}

// Known top-level route segments — used to whitelist dynamic dispatch
const KNOWN_ROUTES = new Set(['/', '/watch', '/leaderboard', '/benchmark', '/settings']);

function handleRoute(hash) {
  const [base, ...rest] = hash.replace(/^#/, '').split('/').filter(Boolean);
  const key = base ? `/${base}` : '/';

  // Stop sync clock if leaving reset page
  if (syncClockInterval && !hash.includes('reset')) {
    clearInterval(syncClockInterval);
    syncClockInterval = null;
  }

  if (KNOWN_ROUTES.has(key) && routes[key]) {
    routes[key](rest);
  } else if (routes['/']) {
    routes['/'](rest);
  }
}

window.addEventListener('popstate', () => handleRoute(location.hash || '#/'));

// ─── Utils ──────────────────────────────────────────────────────────────────
function pad(n) { return String(n).padStart(2, '0'); }

function fmtDrift(spd) {
  if (spd === null || spd === undefined) return '—';
  const sign = spd > 0 ? '+' : '';
  return `${sign}${spd.toFixed(1)} s/day`;
}

function driftClass(spd) {
  if (spd === null || spd === undefined) return 'drift-none';
  const abs = Math.abs(spd);
  if (abs < 2)  return 'drift-good';
  if (abs < 10) return 'drift-slow';
  return 'drift-fast';
}

function fmtDate(ts) {
  return new Date(ts).toLocaleString(undefined, {
    month: 'short', day: 'numeric',
    hour: '2-digit', minute: '2-digit'
  });
}

function fmtTime(h, m, s) { return `${pad(h)}:${pad(m)}:${pad(s)}`; }

function toast(msg, duration = 2500) {
  const el = document.getElementById('toast');
  el.textContent = msg;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), duration);
}

function setHeader(title, showBack = false) {
  document.querySelector('header h1').textContent = title;
  const back = document.querySelector('header .back-btn');
  back.style.display = showBack ? 'block' : 'none';
}

function setActiveTab(id) {
  document.querySelectorAll('.nav-tab').forEach(t => t.classList.remove('active'));
  const el = document.getElementById(`tab-${id}`);
  if (el) el.classList.add('active');
}

function showMain(html) {
  document.getElementById('main').innerHTML = html;
}

// ─── Image modal ─────────────────────────────────────────────────────────────
document.addEventListener('click', e => {
  if (e.target.classList.contains('meas-photo')) {
    const src = e.target.getAttribute('src');
    const modal = document.getElementById('img-modal');
    modal.querySelector('img').src = src;
    modal.classList.add('open');
  }
});
document.getElementById('img-modal-close')?.addEventListener('click', () => {
  document.getElementById('img-modal').classList.remove('open');
});

// ─── HOME VIEW ────────────────────────────────────────────────────────────────
route('/', async () => {
  setHeader('⌚ WatchAccuracy');
  setActiveTab('home');

  showMain(`<p class="text-muted text-center mt-16">Loading watches…</p>`);

  try {
    const watches = await GET('/api/watches');

    if (watches.length === 0) {
      showMain(`
        <div class="text-center mt-16">
          <div style="font-size:3rem">⌚</div>
          <h2 style="margin:12px 0 8px">No watches yet</h2>
          <p class="text-muted">Add your first watch to start tracking accuracy.</p>
          <button class="btn btn-primary mt-16" onclick="showAddWatchModal()">+ Add Watch</button>
        </div>
      `);
    } else {
      const items = watches.map(w => `
        <div class="card watch-item" onclick="navigate('#/watch/${w.id}')">
          <div class="watch-icon">⌚</div>
          <div class="watch-info">
            <div class="name">${w.brand ? `${esc(w.brand)} ${esc(w.model)}` : esc(w.model) || 'Unnamed Watch'}</div>
            <div class="meta">${w.measurement_count} measurement${w.measurement_count !== 1 ? 's' : ''}</div>
          </div>
          <span class="drift-badge ${driftClass(w.latest_drift_rate)}">${fmtDrift(w.latest_drift_rate)}</span>
        </div>
      `).join('');

      showMain(`
        ${items}
        <button class="btn btn-ghost btn-block mt-16" onclick="showAddWatchModal()">+ Add Watch</button>
      `);
    }
  } catch (err) {
    showMain(`<p class="text-muted text-center mt-16">Error: ${esc(err.message)}</p>`);
  }
});

// ─── WATCH DETAIL VIEW ───────────────────────────────────────────────────────
route('/watch', async ([watchId]) => {
  if (!watchId) return navigate('#/');
  currentWatchId = watchId;
  setActiveTab('home');

  showMain(`<p class="text-muted text-center mt-16">Loading…</p>`);

  try {
    const [watch, measurements, ref] = await Promise.all([
      GET(`/api/watches/${watchId}`),
      GET(`/api/watches/${watchId}/measurements`),
      GET(`/api/watches/${watchId}/reference`)
    ]);

    const isOwner = watch.user_id === myUserId;
    const name = watch.brand ? `${esc(watch.brand)} ${esc(watch.model)}` : esc(watch.model) || 'Unnamed Watch';
    setHeader(name, true);

    // Stats
    const latestDrift = measurements.length
      ? measurements[measurements.length - 1].drift_rate_spd
      : null;
    const avgDrift = measurements.filter(m => m.drift_rate_spd !== null).length
      ? measurements.filter(m => m.drift_rate_spd !== null)
          .reduce((a, m) => a + m.drift_rate_spd, 0) /
        measurements.filter(m => m.drift_rate_spd !== null).length
      : null;

    const shareUrl = `${location.origin}/#/watch/${watchId}`;

    showMain(`
      ${watch.is_public ? `
        <div class="share-banner">
          <span>🔗</span>
          <span class="url">${shareUrl}</span>
          <button class="btn btn-ghost" style="padding:6px 10px;font-size:.8rem" onclick="copyShare('${shareUrl}')">Copy</button>
        </div>` : ''}

      <div class="stats-grid">
        <div class="stat-box">
          <div class="val ${latestDrift !== null ? (Math.abs(latestDrift) < 2 ? 'text-green' : '') : ''}"
               style="font-size:1.2rem;color:${latestDrift !== null ? (Math.abs(latestDrift) < 2 ? 'var(--green)' : Math.abs(latestDrift) < 10 ? 'var(--amber)' : 'var(--red)') : 'var(--text2)'}">
            ${fmtDrift(latestDrift)}
          </div>
          <div class="lbl">Latest rate</div>
        </div>
        <div class="stat-box">
          <div class="val" style="color:var(--text2)">${fmtDrift(avgDrift)}</div>
          <div class="lbl">Avg rate</div>
        </div>
        <div class="stat-box">
          <div class="val">${measurements.length}</div>
          <div class="lbl">Measurements</div>
        </div>
        <div class="stat-box">
          <div class="val" style="font-size:1rem;color:${ref ? 'var(--green)' : 'var(--amber)'}">
            ${ref ? '✓ Synced' : '⚠ Not set'}
          </div>
          <div class="lbl">Reference</div>
        </div>
      </div>

      ${measurements.length > 1 ? `
        <div class="card">
          <h3>Accuracy Over Time</h3>
          <div class="chart-container">
            <canvas id="drift-chart"></canvas>
          </div>
        </div>` : ''}

      ${isOwner ? `
        <div class="flex-row mb-8">
          <button class="btn btn-primary flex-1" onclick="navigate('#/watch/${watchId}/measure')">📷 Record Measurement</button>
          <button class="btn btn-ghost" onclick="navigate('#/watch/${watchId}/reset')" title="Sync reference">🔄</button>
          <button class="btn btn-ghost" onclick="showEditModal('${watchId}')" title="Edit">✏️</button>
        </div>` : ''}

      <div class="card" id="meas-list">
        <h3>History</h3>
        ${measurements.length === 0
          ? '<p class="text-muted mt-8">No measurements yet. Sync your watch first, then record measurements.</p>'
          : measurements.slice().reverse().map(m => measRow(m, isOwner)).join('')}
      </div>
    `);

    // Render chart
    if (measurements.length > 1) {
      renderChart(measurements);
    }
  } catch (err) {
    showMain(`<p class="text-muted text-center mt-16">Error: ${esc(err.message)}</p>`);
  }
});

function measRow(m, isOwner) {
  const driftStr = m.drift_seconds !== null
    ? `${m.drift_seconds > 0 ? '+' : ''}${m.drift_seconds.toFixed(1)}s total`
    : '';
  const rateStr = m.drift_rate_spd !== null
    ? `${fmtDrift(m.drift_rate_spd)}`
    : 'no reference';
  return `
    <div class="meas-row" id="meas-${m.id}">
      ${m.photo_filename ? `<img class="meas-photo" src="/uploads/${esc(m.photo_filename)}" alt="watch photo">` : ''}
      <div style="flex:1;min-width:0">
        <div class="meas-time">${fmtDate(m.device_timestamp)}</div>
        <div class="meas-drift ${driftClass(m.drift_rate_spd)}">${rateStr}</div>
        ${driftStr ? `<div style="font-size:.75rem;color:var(--text2)">${driftStr} · ${fmtTime(m.watch_hours, m.watch_minutes, m.watch_seconds)}</div>` : ''}
        ${m.notes ? `<div style="font-size:.75rem;color:var(--text2)">${esc(m.notes)}</div>` : ''}
      </div>
      ${isOwner ? `<button class="meas-del" onclick="deleteMeasurement('${m.watch_id}',${m.id})" title="Delete">🗑</button>` : ''}
    </div>
  `;
}

async function deleteMeasurement(watchId, id) {
  if (!confirm('Delete this measurement?')) return;
  try {
    await DEL(`/api/watches/${watchId}/measurements/${id}`);
    document.getElementById(`meas-${id}`)?.remove();
    toast('Measurement deleted');
  } catch (e) {
    toast('Error: ' + e.message);
  }
}

function copyShare(url) {
  navigator.clipboard.writeText(url).then(() => toast('Link copied!'));
}

function renderChart(measurements) {
  const canvas = document.getElementById('drift-chart');
  if (!canvas) return;

  if (driftChart) { driftChart.destroy(); driftChart = null; }

  const withDrift = measurements.filter(m => m.drift_rate_spd !== null);
  if (withDrift.length < 2) return;

  const labels = withDrift.map(m => fmtDate(m.device_timestamp));
  const rates  = withDrift.map(m => parseFloat(m.drift_rate_spd.toFixed(2)));

  driftChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [{
        label: 'Drift rate (s/day)',
        data: rates,
        borderColor: '#6c63ff',
        backgroundColor: 'rgba(108,99,255,.15)',
        fill: true,
        tension: 0.35,
        pointBackgroundColor: '#6c63ff',
        pointRadius: 4
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { display: false },
        tooltip: {
          callbacks: {
            label: ctx => `${ctx.parsed.y > 0 ? '+' : ''}${ctx.parsed.y} s/day`
          }
        }
      },
      scales: {
        x: {
          ticks: { color: '#9090aa', maxTicksLimit: 5, font: { size: 10 } },
          grid: { color: '#2e2e3e' }
        },
        y: {
          ticks: { color: '#9090aa', font: { size: 10 } },
          grid: { color: '#2e2e3e' }
        }
      }
    }
  });
}

// ─── RESET / SYNC VIEW ───────────────────────────────────────────────────────
// /watch/:id/reset and /watch/:id/measure are handled as sub-segments of /watch
const _origRoute = routes['/watch'];
routes['/watch'] = async ([watchId, sub]) => {
  if (sub === 'reset')   return showResetView(watchId);
  if (sub === 'measure') return showMeasureView(watchId);
  return _origRoute([watchId]);
};

async function showResetView(watchId) {
  currentWatchId = watchId;
  setHeader('Sync Reference', true);
  setActiveTab('home');

  let watch;
  try { watch = await GET(`/api/watches/${watchId}`); }
  catch (e) { return navigate('#/'); }

  const name = watch.brand ? `${esc(watch.brand)} ${esc(watch.model)}` : esc(watch.model) || 'Watch';

  showMain(`
    <div class="card">
      <h2>Set Reference Point</h2>
      <p class="text-muted mt-8">
        Set your <strong>${name}</strong> to match the time shown below, then press <strong>Mark Sync</strong> at the exact second.
      </p>
    </div>

    <div class="card text-center">
      <p class="text-muted mb-8" style="font-size:.8rem">DEVICE TIME</p>
      <div class="big-clock">
        <span id="clock-hm"></span><span class="seconds sync-pulse" id="clock-s"></span>
      </div>
      <p class="text-muted mt-8" id="sync-hint">Align the second hand with the pulsing digits</p>
    </div>

    <div class="card">
      <p class="text-muted mb-8" style="font-size:.8rem">WATCH TIME AT SYNC (optional – leave as-is if you're matching exactly)</p>
      <div class="form-group">
        <div class="time-picker" id="ref-time-picker">
          <input type="number" id="ref-h" min="0" max="23" placeholder="HH" inputmode="numeric">
          <span>:</span>
          <input type="number" id="ref-m" min="0" max="59" placeholder="MM" inputmode="numeric">
          <span>:</span>
          <input type="number" id="ref-s" min="0" max="59" placeholder="SS" inputmode="numeric">
        </div>
      </div>
      <button class="btn btn-success btn-block" id="btn-mark-sync" onclick="markSync('${watchId}')">
        ✓ Mark Sync Now
      </button>
    </div>
  `);

  startSyncClock();
}

function startSyncClock() {
  if (syncClockInterval) clearInterval(syncClockInterval);
  function tick() {
    const now = new Date();
    const hm = document.getElementById('clock-hm');
    const s  = document.getElementById('clock-s');
    if (!hm) { clearInterval(syncClockInterval); return; }
    hm.textContent = `${pad(now.getHours())}:${pad(now.getMinutes())}:`;
    s.textContent  = pad(now.getSeconds());

    // Pre-fill the watch time inputs with device time
    const rh = document.getElementById('ref-h');
    const rm = document.getElementById('ref-m');
    const rs = document.getElementById('ref-s');
    if (rh && !rh.dataset.touched) rh.value = now.getHours();
    if (rm && !rm.dataset.touched) rm.value = now.getMinutes();
    if (rs && !rs.dataset.touched) rs.value = now.getSeconds();
  }
  tick();
  syncClockInterval = setInterval(tick, 200);

  // Mark touched when user edits
  ['ref-h','ref-m','ref-s'].forEach(id => {
    setTimeout(() => {
      const el = document.getElementById(id);
      if (el) el.addEventListener('input', () => { el.dataset.touched = '1'; });
    }, 100);
  });
}

async function markSync(watchId) {
  const deviceTs = Date.now();
  const now = new Date(deviceTs);

  const h = parseInt(document.getElementById('ref-h').value, 10);
  const m = parseInt(document.getElementById('ref-m').value, 10);
  const s = parseInt(document.getElementById('ref-s').value, 10);

  const watchH = isNaN(h) ? now.getHours()   : h;
  const watchM = isNaN(m) ? now.getMinutes() : m;
  const watchS = isNaN(s) ? now.getSeconds() : s;

  const watchTimeSeconds = watchH * 3600 + watchM * 60 + watchS;

  try {
    await POST(`/api/watches/${watchId}/reference`, {
      device_timestamp: deviceTs,
      watch_time_seconds: watchTimeSeconds
    });
    clearInterval(syncClockInterval);
    toast('✓ Reference saved!');
    navigate(`#/watch/${watchId}`);
  } catch (e) {
    toast('Error: ' + e.message);
  }
}

// ─── MEASURE VIEW ────────────────────────────────────────────────────────────
async function showMeasureView(watchId) {
  currentWatchId = watchId;
  setHeader('Record Measurement', true);
  setActiveTab('home');

  let watch, ref;
  try {
    [watch, ref] = await Promise.all([
      GET(`/api/watches/${watchId}`),
      GET(`/api/watches/${watchId}/reference`)
    ]);
  } catch (e) { return navigate('#/'); }

  const name = watch.brand ? `${esc(watch.brand)} ${esc(watch.model)}` : 'Watch';

  showMain(`
    <div class="card">
      <h2>📷 Record Measurement</h2>
      <p class="text-muted mt-8">Take a photo of <strong>${name}</strong> and enter the time it shows.</p>
    </div>

    ${!ref ? `
      <div class="card" style="border-color:var(--amber)">
        <p style="color:var(--amber)">⚠️ No reference point set. <a href="#" onclick="navigate('#/watch/${watchId}/reset');return false" style="color:var(--accent)">Sync first →</a></p>
      </div>` : ''}

    <div class="card">
      <div class="camera-area" id="camera-area">
        <video id="cam-video" autoplay playsinline muted></video>
        <canvas id="cam-canvas"></canvas>
      </div>
      <img id="photo-preview" class="photo-preview" alt="Captured photo">

      <div class="camera-btn-row">
        <button class="btn btn-ghost flex-1" id="btn-open-cam" onclick="openCamera()">📷 Open Camera</button>
        <button class="btn btn-success flex-1 hidden" id="btn-capture" onclick="capturePhoto()">⊙ Capture</button>
        <button class="btn btn-ghost hidden" id="btn-retake" onclick="retakePhoto()">↺ Retake</button>
      </div>
    </div>

    <div class="card">
      <div id="ocr-status" class="ocr-status"></div>
      <div class="form-group">
        <label>Time shown on watch (H : M : S)</label>
        <div class="time-picker">
          <input type="number" id="meas-h" min="0" max="23" placeholder="HH" inputmode="numeric">
          <span>:</span>
          <input type="number" id="meas-m" min="0" max="59" placeholder="MM" inputmode="numeric">
          <span>:</span>
          <input type="number" id="meas-s" min="0" max="59" placeholder="SS" inputmode="numeric">
        </div>
      </div>
      <div class="form-group">
        <label>Notes (optional)</label>
        <textarea id="meas-notes" placeholder="e.g. 3rd day after sync…"></textarea>
      </div>
      <button class="btn btn-primary btn-block" onclick="submitMeasurement('${watchId}')">Save Measurement</button>
    </div>
  `);

  // Prefill time with device time as a hint
  const now = new Date();
  document.getElementById('meas-h').value = now.getHours();
  document.getElementById('meas-m').value = now.getMinutes();
  document.getElementById('meas-s').value = now.getSeconds();
}

async function openCamera() {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 } }
    });
    const video = document.getElementById('cam-video');
    video.srcObject = cameraStream;
    document.getElementById('camera-area').classList.add('visible');
    document.getElementById('btn-open-cam').classList.add('hidden');
    document.getElementById('btn-capture').classList.remove('hidden');
  } catch (e) {
    toast('Camera access denied or not available');
  }
}

function capturePhoto() {
  const video = document.getElementById('cam-video');
  const canvas = document.getElementById('cam-canvas');
  canvas.width  = video.videoWidth  || 640;
  canvas.height = video.videoHeight || 480;
  canvas.getContext('2d').drawImage(video, 0, 0);

  canvas.toBlob(blob => {
    capturedPhotoBlob = blob;
    const url = URL.createObjectURL(blob);
    const preview = document.getElementById('photo-preview');
    preview.src = url;
    preview.classList.add('visible');
    document.getElementById('camera-area').classList.remove('visible');
    document.getElementById('btn-capture').classList.add('hidden');
    document.getElementById('btn-retake').classList.remove('hidden');

    // Stop camera
    if (cameraStream) {
      cameraStream.getTracks().forEach(t => t.stop());
      cameraStream = null;
    }

    // Attempt to OCR the watch time from the captured photo
    runOcrOnCanvas(canvas);
  }, 'image/jpeg', 0.85);
}

// Parse the first valid HH:MM or HH:MM:SS pattern from OCR text
function parseTimeFromText(text) {
  const matches = [...text.matchAll(/\b(\d{1,2}):(\d{2})(?::(\d{2}))?\b/g)];
  for (const match of matches) {
    const h = parseInt(match[1], 10);
    const m = parseInt(match[2], 10);
    const s = match[3] !== undefined ? parseInt(match[3], 10) : 0;
    if (h >= 0 && h <= 23 && m >= 0 && m <= 59 && s >= 0 && s <= 59) {
      return { h, m, s };
    }
  }
  return null;
}

async function runOcrOnCanvas(canvas) {
  const statusEl = document.getElementById('ocr-status');
  if (!statusEl) return;

  // Tesseract may not be loaded (e.g. offline)
  if (typeof Tesseract === 'undefined') {
    statusEl.textContent = '⚠ OCR unavailable — please enter time manually';
    statusEl.className = 'ocr-status failed';
    return;
  }

  statusEl.textContent = '🔍 Scanning photo for time…';
  statusEl.className = 'ocr-status loading';

  try {
    const { data: { text } } = await Tesseract.recognize(canvas, 'eng', {
      tessedit_char_whitelist: '0123456789:'
    });

    const time = parseTimeFromText(text);
    if (time) {
      const hEl = document.getElementById('meas-h');
      const mEl = document.getElementById('meas-m');
      const sEl = document.getElementById('meas-s');
      if (hEl) hEl.value = time.h;
      if (mEl) mEl.value = time.m;
      if (sEl) sEl.value = time.s;
      statusEl.textContent = `✓ Detected ${pad(time.h)}:${pad(time.m)}:${pad(time.s)} — please verify`;
      statusEl.className = 'ocr-status detected';
    } else {
      statusEl.textContent = '⚠ Could not detect time — please enter manually';
      statusEl.className = 'ocr-status failed';
    }
  } catch (e) {
    statusEl.textContent = '⚠ OCR failed — please enter time manually';
    statusEl.className = 'ocr-status failed';
  }
}

function retakePhoto() {
  capturedPhotoBlob = null;
  document.getElementById('photo-preview').classList.remove('visible');
  document.getElementById('btn-retake').classList.add('hidden');
  document.getElementById('btn-open-cam').classList.remove('hidden');
  const statusEl = document.getElementById('ocr-status');
  if (statusEl) { statusEl.textContent = ''; statusEl.className = 'ocr-status'; }
}

async function submitMeasurement(watchId) {
  const h = parseInt(document.getElementById('meas-h').value, 10);
  const m = parseInt(document.getElementById('meas-m').value, 10);
  const s = parseInt(document.getElementById('meas-s').value, 10);
  const notes = document.getElementById('meas-notes').value.trim();

  if (isNaN(h) || isNaN(m) || isNaN(s)) {
    toast('Please enter the watch time');
    return;
  }

  const deviceTs = Date.now();
  const fd = new FormData();
  fd.append('device_timestamp', deviceTs);
  fd.append('watch_hours',   h);
  fd.append('watch_minutes', m);
  fd.append('watch_seconds', s);
  fd.append('notes', notes);
  if (capturedPhotoBlob) fd.append('photo', capturedPhotoBlob, 'watch.jpg');

  try {
    await POST(`/api/watches/${watchId}/measurements`, fd, true);
    capturedPhotoBlob = null;
    toast('✓ Measurement saved!');
    navigate(`#/watch/${watchId}`);
  } catch (e) {
    toast('Error: ' + e.message);
  }
}

// ─── ADD WATCH MODAL ─────────────────────────────────────────────────────────
function showAddWatchModal() {
  const modal = document.getElementById('modal-add-watch');
  modal.classList.add('open');
}

function closeModal(id) {
  document.getElementById(id).classList.remove('open');
}

document.getElementById('modal-add-watch')?.querySelector('.modal-close')?.addEventListener('click', () => closeModal('modal-add-watch'));

async function submitAddWatch() {
  const brand = document.getElementById('aw-brand').value.trim();
  const model = document.getElementById('aw-model').value.trim();
  const notes = document.getElementById('aw-notes').value.trim();
  const isPublic = document.getElementById('aw-public').checked ? 1 : 0;

  try {
    const watch = await POST('/api/watches', { brand, model, notes, is_public: isPublic });
    closeModal('modal-add-watch');
    toast('Watch added!');
    navigate(`#/watch/${watch.id}/reset`);
  } catch (e) {
    toast('Error: ' + e.message);
  }
}

// ─── EDIT WATCH MODAL ────────────────────────────────────────────────────────
async function showEditModal(watchId) {
  const watch = await GET(`/api/watches/${watchId}`).catch(() => null);
  if (!watch) return;

  document.getElementById('ew-brand').value = watch.brand || '';
  document.getElementById('ew-model').value = watch.model || '';
  document.getElementById('ew-notes').value = watch.notes || '';
  document.getElementById('ew-public').checked = !!watch.is_public;
  document.getElementById('ew-watchid').value = watchId;

  document.getElementById('modal-edit-watch').classList.add('open');
}

async function submitEditWatch() {
  const watchId = document.getElementById('ew-watchid').value;
  const brand   = document.getElementById('ew-brand').value.trim();
  const model   = document.getElementById('ew-model').value.trim();
  const notes   = document.getElementById('ew-notes').value.trim();
  const isPublic = document.getElementById('ew-public').checked ? 1 : 0;

  try {
    await PUT(`/api/watches/${watchId}`, { brand, model, notes, is_public: isPublic });
    closeModal('modal-edit-watch');
    toast('Watch updated!');
    navigate(`#/watch/${watchId}`);
  } catch (e) {
    toast('Error: ' + e.message);
  }
}

async function deleteWatch(watchId) {
  if (!confirm('Delete this watch and all its data?')) return;
  try {
    await DEL(`/api/watches/${watchId}`);
    closeModal('modal-edit-watch');
    toast('Watch deleted');
    navigate('#/');
  } catch (e) {
    toast('Error: ' + e.message);
  }
}

// ─── BENCHMARK / LEADERBOARD VIEW ────────────────────────────────────────────
route('/leaderboard', async () => {
  setHeader('Leaderboard 🏆');
  setActiveTab('leaderboard');

  showMain(`<p class="text-muted text-center mt-16">Loading…</p>`);

  try {
    const data = await GET('/api/leaderboard');

    if (data.length === 0) {
      showMain(`
        <div class="text-center mt-16">
          <div style="font-size:3rem">🏆</div>
          <h2 style="margin:12px 0 8px">No benchmark data yet</h2>
          <p class="text-muted">Make watches public and add brand/model to see them here.</p>
        </div>
      `);
      return;
    }

    const rows = data.map((r, i) => `
      <div class="lb-row" onclick="navigate('#/benchmark/${encodeURIComponent(r.brand)}/${encodeURIComponent(r.model)}')" style="cursor:pointer">
        <span class="lb-rank">${i + 1}</span>
        <div class="lb-info">
          <div class="name">${esc(r.brand)} ${esc(r.model)}</div>
          <div class="meta">${r.watch_count} watch${r.watch_count > 1 ? 'es' : ''} · ${r.total_measurements} meas.</div>
        </div>
        <span class="lb-spd ${driftClass(r.avg_abs_drift_spd)}">±${r.avg_abs_drift_spd.toFixed(1)} s/day</span>
      </div>
    `).join('');

    showMain(`
      <div class="card">
        <h3>Most accurate watches (public data)</h3>
        ${rows}
      </div>
      <p class="text-muted text-center mt-8" style="font-size:.75rem">Ranked by avg absolute drift · min 3 measurements</p>
    `);
  } catch (e) {
    showMain(`<p class="text-muted text-center mt-16">Error: ${esc(e.message)}</p>`);
  }
});

// ─── BENCHMARK DETAIL ────────────────────────────────────────────────────────
route('/benchmark', async ([brand, model]) => {
  if (!brand || !model) return navigate('#/leaderboard');
  setHeader(`${decodeURIComponent(brand)} ${decodeURIComponent(model)}`);
  setActiveTab('leaderboard');

  showMain(`<p class="text-muted text-center mt-16">Loading…</p>`);

  try {
    const data = await GET(`/api/benchmark/${encodeURIComponent(brand)}/${encodeURIComponent(model)}`);

    const rows = data.entries.map(e => `
      <div class="meas-row">
        <div style="flex:1">
          <div class="meas-drift ${driftClass(e.avg_drift_rate_spd)}">${fmtDrift(e.avg_drift_rate_spd)} avg</div>
          <div class="meas-time">${e.measurements} measurements</div>
        </div>
      </div>
    `).join('');

    showMain(`
      <div class="stats-grid">
        <div class="stat-box">
          <div class="val">${data.watches}</div>
          <div class="lbl">Watches</div>
        </div>
        <div class="stat-box">
          <div class="val">${data.total_measurements}</div>
          <div class="lbl">Total Meas.</div>
        </div>
        <div class="stat-box" style="grid-column:span 2">
          <div class="val" style="color:${data.avg_drift_rate_spd !== null ? (Math.abs(data.avg_drift_rate_spd) < 2 ? 'var(--green)' : 'var(--amber)') : 'var(--text2)'}">${fmtDrift(data.avg_drift_rate_spd)}</div>
          <div class="lbl">Avg community drift rate</div>
        </div>
      </div>
      <div class="card">
        <h3>Individual watches</h3>
        ${rows || '<p class="text-muted mt-8">No public data</p>'}
      </div>
    `);
  } catch (e) {
    showMain(`<p class="text-muted text-center mt-16">Error: ${esc(e.message)}</p>`);
  }
});

// ─── SETTINGS VIEW ───────────────────────────────────────────────────────────
route('/settings', async () => {
  setHeader('Settings ⚙️');
  setActiveTab('settings');
  showMain(`
    <div class="card">
      <h2>Your Identity</h2>
      <p class="text-muted mt-8">You are identified by a cookie — no login required.</p>
      <p class="text-muted mt-8" style="font-size:.8rem;word-break:break-all">ID: <code id="uid-display">…</code></p>
    </div>
    <div class="card">
      <h2>About</h2>
      <p class="text-muted mt-8">WatchAccuracy lets you track how accurate your watches are over time.</p>
      <p class="text-muted mt-8">Share a tracker URL by making it public (edit watch → toggle Public).</p>
      <p class="text-muted mt-8">Contribute to the leaderboard: add brand/model and enable public sharing.</p>
    </div>
  `);

  try {
    const me = await GET('/api/me');
    const el = document.getElementById('uid-display');
    if (el) el.textContent = me.userId;
  } catch {}
});

// ─── Navigation tabs ──────────────────────────────────────────────────────────
document.querySelectorAll('.nav-tab').forEach(tab => {
  tab.addEventListener('click', () => navigate(tab.dataset.href));
});

// ─── Back button ─────────────────────────────────────────────────────────────
document.querySelector('.back-btn')?.addEventListener('click', () => {
  if (currentWatchId) {
    const hash = location.hash;
    if (hash.includes('/measure') || hash.includes('/reset')) {
      navigate(`#/watch/${currentWatchId}`);
    } else {
      navigate('#/');
    }
  } else {
    history.back();
  }
});

// ─── XSS helper ──────────────────────────────────────────────────────────────
function esc(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

// ─── Init ────────────────────────────────────────────────────────────────────
async function init() {
  try {
    const me = await GET('/api/me');
    myUserId = me.userId;
  } catch {}
  handleRoute(location.hash || '#/');
}

init();
