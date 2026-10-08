import { config } from './config.js';

// The only thing this app fetches from ESPN: the player database
// (kona_player_info — names, positions, pro team, draft rank, ADP). League
// name, teams, managers, and draft order are always entered by hand (see
// league.js) — this client has no league/team/draft-pick fetching at all.
//
// `lm-api-reads` is the read replica ESPN's own apps use for this v3 API;
// `fantasy.espn.com` is kept only as a fallback if it ever has a blip.
const HOSTS = ['https://lm-api-reads.fantasy.espn.com', 'https://fantasy.espn.com'];

const REQUEST_TIMEOUT_MS = 9000;

const USER_AGENT =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/122.0.0.0 Safari/537.36';

export class EspnError extends Error {
  constructor(message, { status, kind, body } = {}) {
    super(message);
    this.name = 'EspnError';
    this.status = status ?? null;
    // kind: 'auth' | 'rate-limit' | 'not-found' | 'network' | 'parse' | 'unknown'
    this.kind = kind ?? 'unknown';
    this.body = body ?? null;
  }
}

function leaguePath(host) {
  return `${host}/apis/v3/games/fba/seasons/${config.seasonYear}/segments/0/leagues/${config.leagueId}`;
}

function baseHeaders() {
  return {
    Cookie: `espn_s2=${config.espnS2}; SWID=${config.swid}`,
    Accept: 'application/json',
    'User-Agent': USER_AGENT,
    'X-Fantasy-Source': 'kona',
    'X-Fantasy-Platform': 'kona-PROD',
  };
}

async function fetchJson(url, headers) {
  let res;
  try {
    res = await fetch(url, {
      headers,
      redirect: 'follow',
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (err) {
    throw new EspnError(`Network error contacting ESPN: ${err.message || err}`, { kind: 'network' });
  }

  const text = await res.text();

  if (res.status === 401 || res.status === 403) {
    throw new EspnError(
      `ESPN rejected the request (${res.status}). Your espn_s2 / SWID cookies are probably expired — ` +
        'grab fresh ones from DevTools and update .env.',
      { status: res.status, kind: 'auth', body: text.slice(0, 400) },
    );
  }
  if (res.status === 404) {
    throw new EspnError(
      `ESPN returned 404 for league ${config.leagueId} in season ${config.seasonYear}. ` +
        'Double-check ESPN_LEAGUE_ID and ESPN_SEASON_YEAR (season = the year it ends).',
      { status: 404, kind: 'not-found', body: text.slice(0, 400) },
    );
  }
  if (res.status === 429) {
    throw new EspnError('ESPN rate-limited the request (429). Backing off automatically.', {
      status: 429,
      kind: 'rate-limit',
    });
  }
  if (!res.ok) {
    throw new EspnError(`ESPN returned HTTP ${res.status}.`, {
      status: res.status,
      kind: 'unknown',
      body: text.slice(0, 400),
    });
  }

  try {
    return JSON.parse(text);
  } catch {
    if (/<html/i.test(text)) {
      throw new EspnError(
        'ESPN returned an HTML page instead of JSON — almost always an auth problem. Refresh your cookies.',
        { status: res.status, kind: 'auth', body: text.slice(0, 300) },
      );
    }
    throw new EspnError('Could not parse the ESPN response as JSON.', {
      status: res.status,
      kind: 'parse',
      body: text.slice(0, 300),
    });
  }
}

// Try each host in order; fall through only on transient errors.
async function fetchWithFallback(buildUrl, headers) {
  let lastErr;
  for (const host of HOSTS) {
    try {
      return await fetchJson(buildUrl(host), headers);
    } catch (err) {
      lastErr = err;
      if (err instanceof EspnError && ['auth', 'not-found', 'rate-limit'].includes(err.kind)) {
        throw err;
      }
    }
  }
  throw lastErr;
}

/**
 * Player universe (names, positions, pro team, draft rank, ADP).
 *
 * kona_player_info returns almost nothing useful unless you scope it with an
 * `X-Fantasy-Filter` header. We ask for the top N players sorted by draft rank,
 * which is exactly the "best available" ordering we want.
 */
export async function fetchPlayers({ limit = config.playerLimit } = {}) {
  const filter = {
    players: {
      limit,
      sortDraftRanks: { sortPriority: 100, sortAsc: true, value: 'STANDARD' },
    },
  };
  const headers = { ...baseHeaders(), 'X-Fantasy-Filter': JSON.stringify(filter) };
  const params = new URLSearchParams();
  params.append('view', 'kona_player_info');
  const qs = params.toString();
  return fetchWithFallback((host) => `${leaguePath(host)}?${qs}`, headers);
}
