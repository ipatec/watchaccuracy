# watchaccuracy
Measure and Track your Watch accuracy

## Features

- 📷 **Camera capture** – take a photo of any analog or digital watch as a visual record
- ⏱ **Drift tracking** – compare the watch's displayed time against your device clock and log the difference
- 🔄 **Sync / reference point** – a live ticking clock guide helps you align the watch second hand; mark the exact moment of sync with one tap
- 📈 **Accuracy graph** – Chart.js line chart showing drift rate (seconds/day) over time
- 🍪 **Cookie-based identity** – no login required; your data is tied to a browser cookie
- 🔗 **Shareable URL** – make a watch tracker public and share the link
- 🏆 **Leaderboard & benchmarking** – add brand/model and enable public sharing to contribute to and view community accuracy data

## Tech stack

| Layer | Choice |
|-------|--------|
| Runtime | Node.js ≥ 22.5 (uses built-in `node:sqlite`) |
| Server | Express 4 |
| Database | SQLite via `node:sqlite` (no native compilation needed) |
| File uploads | Multer |
| Frontend | Vanilla JS SPA, Chart.js 4 |

## Local development

```bash
npm install
npm run dev        # nodemon hot-reload
# or
npm start          # plain node
```

Open `http://localhost:3000`.

## Deploy on Railway

### One-click deploy
[![Deploy on Railway](https://railway.app/button.svg)](https://railway.app/new/template)

### Manual steps

1. **Create a new Railway project** from this GitHub repo.  
   Railway auto-detects Node.js and runs `npm start`.

2. **Add a Persistent Volume** (strongly recommended so data survives redeploys):
   - Railway dashboard → your service → **Volumes** → **Add volume**
   - Set the mount path to `/data`

3. **Set environment variables** in Railway → your service → **Variables**:

   | Variable | Description | Example |
   |----------|-------------|---------|
   | `PORT` | Set automatically by Railway | `3000` |
   | `DB_PATH` | Full path to the SQLite file | `/data/watchaccuracy.db` |
   | `UPLOADS_DIR` | Directory for watch photos | `/data/uploads` |

   If you skip `DB_PATH` / `UPLOADS_DIR`, the app still works but data will reset on each redeploy.

4. Railway will run the health check at `GET /health` before routing traffic.

## Project structure

```
server.js              – Express server, middleware, routes
src/
  database.js          – SQLite schema + drift calculation
  routes/
    watches.js         – Watch CRUD + reference points
    measurements.js    – Measurement CRUD + photo upload
public/
  index.html           – Mobile-first SPA shell
  css/styles.css       – Dark theme, responsive layout
  js/app.js            – Frontend routing, camera, charts
tests/
  api.test.js          – Node built-in test runner
uploads/               – Watch photos (gitignored)
railway.json           – Railway deployment config
```

## Running tests

```bash
node --test tests/api.test.js
```
