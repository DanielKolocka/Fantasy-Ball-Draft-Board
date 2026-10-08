import { writeFile, readFile } from 'node:fs/promises';
import { config, configError } from './config.js';
import { fetchPlayers, EspnError } from './espnClient.js';
import { normalize, buildPlayerIndex } from './normalize.js';
import { manualPickCount, synthesizeManualPicks } from './manualDraft.js';
import { synthesizeLeague } from './league.js';

const SAMPLE_FILE = new URL('./sample-response.json', import.meta.url);
// Last-good player payload, cached to disk so a restart (or expired cookies
// mid-draft) doesn't lose the searchable player list.
const PLAYERS_CACHE_FILE = new URL('./.cache-players.json', import.meta.url);

// ── in-memory cache ──────────────────────────────────────────
const cache = {
  state: null,
  rawPlayers: null,
  playerIndex: new Map(),
  lastPlayersOk: null,
  lastError: null,
  playerFailures: 0,
};

const subscribers = new Set();

let playersTimer = null;
let started = false;

export function getState() {
  return cache.state;
}

/** Search the full player universe by name (for pick entry). */
export function searchPlayers(query, { limit = 25 } = {}) {
  const q = String(query || '').trim().toLowerCase();
  if (!q) return [];
  const draftedIds = new Set((cache.state?.picks || []).map((p) => p.playerId));
  const out = [];
  for (const p of cache.playerIndex.values()) {
    if (draftedIds.has(p.id) || p.onTeamId) continue;
    if (p.name.toLowerCase().includes(q)) out.push(p);
  }
  out.sort((a, b) => (a.rank ?? a.adp ?? 9999) - (b.rank ?? b.adp ?? 9999));
  return out.slice(0, limit);
}

export function getRaw() {
  return {
    league: synthesizeLeague(),
    players: cache.rawPlayers
      ? {
          count: Array.isArray(cache.rawPlayers.players) ? cache.rawPlayers.players.length : 0,
          sample: Array.isArray(cache.rawPlayers.players)
            ? cache.rawPlayers.players.slice(0, 2)
            : cache.rawPlayers,
        }
      : null,
    meta: {
      lastPlayersOk: cache.lastPlayersOk,
      lastError: cache.lastError,
      playerFailures: cache.playerFailures,
      recordedPicks: manualPickCount(),
    },
  };
}

export function subscribe(res) {
  subscribers.add(res);
}

export function unsubscribe(res) {
  subscribers.delete(res);
}

function broadcast() {
  if (!cache.state) return;
  const payload = `event: state\ndata: ${JSON.stringify(cache.state)}\n\n`;
  for (const res of subscribers) {
    try {
      res.write(payload);
    } catch {
      subscribers.delete(res);
    }
  }
}

// Compare state ignoring fields that change on every poll.
function stableView(state) {
  if (!state) return '';
  const { lastUpdated, lastPlayersOk, revision, ...rest } = state;
  return JSON.stringify(rest);
}

// The league (name, teams, managers, draft order) always comes from what you
// typed into League Setup; the picks are always what you've recorded
// yourself. This app never fetches either of those from ESPN.
function leagueForNormalize() {
  const league = synthesizeLeague();
  return { ...league, draftDetail: { picks: synthesizeManualPicks(league) } };
}

function rebuild() {
  try {
    const next = normalize({
      rawLeague: leagueForNormalize(),
      rawPlayers: cache.rawPlayers,
      lastPlayersOk: cache.lastPlayersOk,
      lastError: cache.lastError,
    });
    next.manualPickCount = manualPickCount();

    const prev = cache.state;
    const changed = !prev || stableView(prev) !== stableView(next);
    next.revision = changed ? (prev?.revision || 0) + 1 : prev.revision;
    cache.state = next;
    if (changed) broadcast();
  } catch (err) {
    console.error('[normalize] failed:', err);
    cache.state = {
      status: 'error',
      error: { kind: 'normalize', message: String(err?.message || err) },
      warnings: [],
      lastUpdated: new Date().toISOString(),
      revision: (cache.state?.revision || 0) + 1,
      teams: [],
      picks: [],
      board: { rounds: 0, teamOrder: [], cells: {} },
      availablePlayers: [],
    };
    broadcast();
  }
}

/** Rebuild immediately and return the fresh state (used by the setup/pick-entry endpoints). */
export function rebuildNow() {
  rebuild();
  return cache.state;
}

function describeError(err) {
  if (err instanceof EspnError) {
    return { kind: err.kind, message: err.message, status: err.status };
  }
  return { kind: 'unknown', message: String(err?.message || err) };
}

// ── disk cache for the player payload ─────────────────────────
function savePlayersCache(raw) {
  writeFile(PLAYERS_CACHE_FILE, JSON.stringify(raw)).catch(() => {});
}
async function loadPlayersDiskCache() {
  try {
    cache.rawPlayers = JSON.parse(await readFile(PLAYERS_CACHE_FILE, 'utf8'));
    cache.playerIndex = buildPlayerIndex(cache.rawPlayers);
    console.log(`[cache] loaded ${cache.playerIndex.size} players from disk`);
  } catch {
    /* none yet */
  }
}

// ── player universe poll loop ────────────────────────────────
async function pollPlayers() {
  try {
    const raw = await fetchPlayers({ limit: config.playerLimit });
    cache.rawPlayers = raw;
    cache.playerIndex = buildPlayerIndex(raw);
    cache.lastPlayersOk = new Date().toISOString();
    cache.playerFailures = 0;
    cache.lastError = null;
    savePlayersCache(raw);
    console.log(`[poll] player universe refreshed (${cache.playerIndex.size} players)`);
    if (config.debugDump) {
      writeFile(SAMPLE_FILE, JSON.stringify(raw, null, 2)).catch(() => {});
    }
  } catch (err) {
    cache.playerFailures += 1;
    cache.lastError = describeError(err);
    console.error(
      `[poll] player fetch failed (attempt ${cache.playerFailures}): ${cache.lastError.message}` +
        (cache.rawPlayers ? ' — keeping previous player data.' : ''),
    );
  }
  rebuild();
  const delay =
    cache.playerFailures > 0
      ? Math.min(30000 * cache.playerFailures, 120000)
      : config.playerPollIntervalMs;
  playersTimer = setTimeout(pollPlayers, delay);
  playersTimer.unref?.();
}

export async function startPolling() {
  if (started) return;
  started = true;

  // The league/board/picks work regardless of ESPN — build an initial state
  // right away rather than waiting on a network call.
  await loadPlayersDiskCache();
  rebuild();

  if (configError) {
    console.warn(`[poll] ESPN not configured — player search unavailable: ${configError}`);
    return;
  }
  console.log(`[poll] player universe refresh every ${config.playerPollIntervalMs}ms.`);
  pollPlayers();
}

export function stopPolling() {
  clearTimeout(playersTimer);
}
