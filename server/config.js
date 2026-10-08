import dotenv from 'dotenv';

dotenv.config();

const missing = [];
const raw = (name) => (process.env[name] || '').trim();

function required(name) {
  const v = raw(name);
  if (!v) missing.push(name);
  return v;
}

function num(name, dflt) {
  const n = Number(raw(name));
  return Number.isFinite(n) && n > 0 ? n : dflt;
}

// ESPN wants SWID wrapped in braces. Be forgiving about how it's pasted.
function normalizeSwid(value) {
  let s = (value || '').trim();
  if (!s) return s;
  if (!s.startsWith('{')) s = `{${s}`;
  if (!s.endsWith('}')) s = `${s}}`;
  return s;
}

// These four are only used to fetch the ESPN player database (names,
// positions, pro team, rank/ADP) — the league itself (name, teams, managers,
// draft order) is always entered by hand, never read from ESPN. ESPN's
// player endpoint happens to be nested under a league path, so a valid
// league + season + cookies are still needed to reach it — but it doesn't
// have to be "your" draft league, any league your account can see works,
// since the player data itself isn't league-specific.
const leagueId = required('ESPN_LEAGUE_ID');
const seasonYearStr = required('ESPN_SEASON_YEAR');
const espnS2 = required('ESPN_S2');
const swid = normalizeSwid(required('ESPN_SWID'));

let seasonYear = Number(seasonYearStr);
if (!Number.isFinite(seasonYear) || seasonYear < 2000) {
  seasonYear = 0;
  if (seasonYearStr && !missing.includes('ESPN_SEASON_YEAR')) {
    missing.push('ESPN_SEASON_YEAR (must be a 4-digit year, e.g. 2026)');
  }
}

export const config = {
  leagueId,
  seasonYear,
  espnS2,
  swid,
  playerPollIntervalMs: num('PLAYER_POLL_INTERVAL_MS', 300000),
  playerLimit: num('PLAYER_LIMIT', 900),
  port: num('PORT', 3000),
  debugDump: process.env.DEBUG_DUMP === '1',
};

// Missing ESPN config only disables player search — the league board, team
// setup, and pick recording all work without it. See poller.js / index.js.
export const configError = missing.length
  ? `Missing required env var(s): ${[...new Set(missing)].join(', ')}. ` +
    'Copy .env.example to .env and fill them in. Player search will be unavailable until then.'
  : null;
