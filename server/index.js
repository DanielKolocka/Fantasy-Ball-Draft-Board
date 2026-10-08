import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';

import { config, configError } from './config.js';
import {
  startPolling,
  stopPolling,
  getState,
  getRaw,
  rebuildNow,
  searchPlayers,
  subscribe,
  unsubscribe,
} from './poller.js';
import { addManualPick, undoManualPick, resetManualPicks } from './manualDraft.js';
import { getLeagueConfig, setLeagueConfig } from './league.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const publicDir = path.join(__dirname, '..', 'public');

const app = express();
app.disable('x-powered-by');
app.use(express.json());
app.use(express.static(publicDir));

app.get('/api/health', (_req, res) => {
  res.json({
    ok: true, // the board, league setup, and picks all work regardless of ESPN
    espnConfigured: !configError,
    espnConfigError: configError || null, // only affects player search
    hasState: Boolean(getState()),
    league: config.leagueId || null,
    season: config.seasonYear || null,
  });
});

app.get('/api/draft-state', (_req, res) => {
  const state = getState();
  if (!state) {
    return res.status(503).json({ status: 'starting', message: 'Starting…' });
  }
  res.json(state);
});

// Server-Sent Events — pushes new state the moment a pick is recorded, so a
// board open on a second screen updates without anyone touching it.
app.get('/api/stream', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    Connection: 'keep-alive',
  });
  res.write('retry: 3000\n\n');

  const state = getState();
  if (state) res.write(`event: state\ndata: ${JSON.stringify(state)}\n\n`);

  subscribe(res);
  const keepAlive = setInterval(() => {
    try {
      res.write(': keep-alive\n\n');
    } catch {
      /* ignore */
    }
  }, 20000);

  req.on('close', () => {
    clearInterval(keepAlive);
    unsubscribe(res);
  });
});

// ── pick entry ──────────────────────────────────────────────
app.post('/api/manual/pick', (req, res) => {
  try {
    addManualPick(req.body?.playerId, req.body?.teamId ?? null);
    res.json({ ok: true, state: rebuildNow() });
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err?.message || err) });
  }
});

app.post('/api/manual/undo', (_req, res) => {
  const removed = undoManualPick();
  res.json({ ok: true, removed, state: rebuildNow() });
});

app.post('/api/manual/reset', (_req, res) => {
  resetManualPicks();
  res.json({ ok: true, state: rebuildNow() });
});

// ── league setup (name, teams, managers, draft order, rounds) ──
// Entirely local — never touches ESPN, so this works even without any
// ESPN config at all.
app.get('/api/league', (_req, res) => res.json(getLeagueConfig()));

app.post('/api/league', (req, res) => {
  try {
    const cfg = setLeagueConfig(req.body || {});
    res.json({ ok: true, config: cfg, state: rebuildNow() });
  } catch (err) {
    res.status(400).json({ ok: false, error: String(err?.message || err) });
  }
});

// Player search over the full ESPN player universe (the one thing this app
// does pull from ESPN).
app.get('/api/players/search', (req, res) => {
  if (configError) {
    return res.status(503).json({ error: `Player search needs ESPN config: ${configError}` });
  }
  res.json({ players: searchPlayers(req.query?.q, { limit: 25 }) });
});

// Debug: inspect the league payload sent to normalize() and the last ESPN
// player payload received (for confirming the player schema).
app.get('/api/debug/raw', (_req, res) => {
  res.json(getRaw());
});

const server = app.listen(config.port, () => {
  console.log('\n  ┌─────────────────────────────────────────────');
  console.log(`  │  Draft board  →  http://localhost:${config.port}`);
  console.log('  └─────────────────────────────────────────────\n');
  if (configError) {
    console.log(`  ⚠  ${configError}`);
    console.log('     The board and league setup work now; player search needs this fixed.\n');
  }
  startPolling().catch((err) => console.error('[poll] failed to start:', err));
});

function shutdown() {
  stopPolling();
  server.close(() => process.exit(0));
  setTimeout(() => process.exit(0), 1000).unref();
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
