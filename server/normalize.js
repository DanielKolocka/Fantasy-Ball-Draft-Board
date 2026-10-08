import {
  PRO_TEAMS,
  DEFAULT_POSITION,
  POSITION_SLOT_IDS,
  SLOT_TO_POSITION,
  POSITION_ORDER,
  isDraftableSlot,
} from './nba.js';

const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

// How many "best available" players to ship to the frontend.
const AVAILABLE_LIMIT = 400;

/**
 * Does this round draft in the reversed direction (last-picking team in
 * round 1 goes first)?
 *
 * Plain SNAKE alternates every round: 1 fwd, 2 rev, 3 fwd, 4 rev, ...
 * SNAKE_3RR ("third-round reversal") delays the flip back by one round —
 * round 3 repeats round 2's direction instead of reverting — softening the
 * extreme draft slots' advantage/disadvantage. From round 4 on it alternates
 * normally again, just shifted by that one round. ESPN has no such draft
 * type; this is purely a draft-order choice you make in League Setup (see
 * league.js / manualDraft.js).
 */
export function isReversedRound(draftType, round) {
  if (draftType === 'SNAKE_3RR') {
    const effectiveRound = round <= 2 ? round : round - 1;
    return effectiveRound % 2 === 0;
  }
  if (draftType === 'SNAKE') return round % 2 === 0;
  return false;
}

function teamDisplayName(t) {
  if (!t) return 'Unknown';
  if (t.name && String(t.name).trim()) return String(t.name).trim();
  const combo = [t.location, t.nickname].filter(Boolean).join(' ').trim();
  return combo || t.abbrev || `Team ${t.id}`;
}

function memberDisplayName(m) {
  if (!m) return null;
  const combo = [m.firstName, m.lastName].filter(Boolean).join(' ').trim();
  return (m.displayName && String(m.displayName).trim()) || combo || null;
}

function positionsFor(player) {
  const out = [];
  const slots = Array.isArray(player?.eligibleSlots) ? player.eligibleSlots : [];
  for (const s of slots) {
    const pos = SLOT_TO_POSITION[Number(s)];
    if (POSITION_SLOT_IDS.includes(Number(s)) && pos && !out.includes(pos)) out.push(pos);
  }
  if (!out.length && DEFAULT_POSITION[player?.defaultPositionId]) {
    out.push(DEFAULT_POSITION[player.defaultPositionId]);
  }
  out.sort((a, b) => POSITION_ORDER.indexOf(a) - POSITION_ORDER.indexOf(b));
  return out;
}

function draftRank(player) {
  const ranks = player?.draftRanksByRankType || {};
  const r = ranks.STANDARD?.rank ?? ranks.PPR?.rank ?? ranks.STANDARD_H2H?.rank;
  return Number.isFinite(r) && r > 0 ? r : null;
}

function averageDraftPosition(player) {
  const a = player?.ownership?.averageDraftPosition;
  return Number.isFinite(a) && a > 0 ? Math.round(a * 10) / 10 : null;
}

function emptyState({ status, error, lastPlayersOk }) {
  return {
    status,
    error: error || null,
    warnings: [],
    lastUpdated: new Date().toISOString(),
    lastPlayersOk: lastPlayersOk || null,
    league: null,
    rounds: 0,
    draft: { started: false, complete: false },
    teams: [],
    picks: [],
    board: { rounds: 0, teamOrder: [], cells: {} },
    onTheClock: null,
    onTheClockTeamId: null,
    availablePlayers: [],
    playerCount: 0,
    availableCount: 0,
    revision: 0,
  };
}

/**
 * Parse the raw kona_player_info payload into a Map<id, player>.
 * Exported so the poller can keep a searchable index for pick entry.
 */
export function buildPlayerIndex(rawPlayers) {
  const list = Array.isArray(rawPlayers?.players)
    ? rawPlayers.players
    : Array.isArray(rawPlayers)
      ? rawPlayers
      : [];
  const byId = new Map();
  for (const entry of list) {
    const p = entry.player || entry;
    const id = Number(p?.id);
    if (!Number.isFinite(id)) continue;
    byId.set(id, {
      id,
      name:
        p.fullName ||
        [p.firstName, p.lastName].filter(Boolean).join(' ') ||
        `Player ${id}`,
      positions: positionsFor(p),
      proTeam: PRO_TEAMS[p.proTeamId] ?? null,
      rank: draftRank(p),
      adp: averageDraftPosition(p),
      onTeamId: Number(entry.onTeamId) > 0 ? Number(entry.onTeamId) : null,
    });
  }
  return byId;
}

/**
 * Turn the hand-entered league config (see league.js) and the raw ESPN
 * player payload — plus the picks you've recorded — into the shape the
 * frontend renders. `rawLeague.draftDetail.picks` is always OUR OWN recorded
 * picks (see manualDraft.synthesizeManualPicks); this app never reads a
 * league or draft picks from ESPN. Everything here is defensive: the player
 * API is undocumented, so a missing or unexpected field should degrade a
 * single value, never throw.
 */
export function normalize({ rawLeague, rawPlayers, lastPlayersOk, lastError }) {
  if (!rawLeague) {
    return emptyState({
      status: lastError ? 'error' : 'starting',
      error: lastError,
      lastPlayersOk,
    });
  }

  const warnings = [];
  const settings = rawLeague.settings || {};
  const rawTeams = Array.isArray(rawLeague.teams) ? rawLeague.teams : [];
  const size = Number(settings.size) || rawTeams.length || 0;

  const draftSettings = settings.draftSettings || {};
  const draftType = draftSettings.type || 'SNAKE';

  // ── teams + owners ──────────────────────────────────────────
  const members = new Map(
    (rawLeague.members || []).map((m) => [String(m.id).toUpperCase(), m]),
  );
  const teamsById = new Map();
  for (const t of rawTeams) {
    const ownerGuid =
      Array.isArray(t.owners) && t.owners.length ? String(t.owners[0]).toUpperCase() : null;
    teamsById.set(t.id, {
      id: t.id,
      abbrev: t.abbrev || `T${t.id}`,
      name: teamDisplayName(t),
      owner: memberDisplayName(ownerGuid ? members.get(ownerGuid) : null),
      logo: t.logo || null,
    });
  }

  // ── recorded picks ────────────────────────────────────────────
  const rawPicks = Array.isArray(rawLeague.draftDetail?.picks) ? rawLeague.draftDetail.picks : [];
  const madePicks = rawPicks
    .filter((p) => Number(p.playerId) > 0)
    .sort((a, b) => (a.overallPickNumber || 0) - (b.overallPickNumber || 0));

  // ── draft order (column order for the grid) ─────────────────
  let pickOrder =
    Array.isArray(draftSettings.pickOrder) && draftSettings.pickOrder.length
      ? draftSettings.pickOrder.slice()
      : [];
  if (!pickOrder.length) {
    pickOrder = [...teamsById.keys()];
    if (size) warnings.push('Draft order unknown — using team ID order for columns.');
  }

  // ── rounds ──────────────────────────────────────────────────
  const slotCounts = settings.rosterSettings?.lineupSlotCounts || {};
  let rosterRounds = 0;
  for (const [slot, count] of Object.entries(slotCounts)) {
    if (isDraftableSlot(slot)) rosterRounds += Number(count) || 0;
  }
  let rounds = rosterRounds || 13;
  if (size) rounds = Math.max(rounds, Math.ceil(madePicks.length / size));
  rounds = clamp(rounds, 1, 40);

  // ── drafted / owned player ids ──────────────────────────────
  const draftedPlayerIds = new Set(madePicks.map((p) => Number(p.playerId)));
  for (const t of rawTeams) {
    for (const e of t.roster?.entries || []) {
      if (Number(e.playerId) > 0) draftedPlayerIds.add(Number(e.playerId));
    }
  }

  // ── player universe ─────────────────────────────────────────
  const playerById = buildPlayerIndex(rawPlayers);
  if (!playerById.size) {
    warnings.push(
      'Player universe is empty — pick names and ADP are unavailable. ' +
        'The kona_player_info fetch may have failed (check the server log).',
    );
  }

  // ── normalized picks ────────────────────────────────────────
  const picks = madePicks.map((p) => {
    const pl = playerById.get(Number(p.playerId));
    return {
      overall: p.overallPickNumber ?? null,
      round: p.roundId ?? null,
      roundPick: p.roundPickNumber ?? null,
      teamId: p.teamId ?? null,
      playerId: Number(p.playerId),
      playerName: pl?.name || `Player ${p.playerId}`,
      positions: pl?.positions || [],
      proTeam: pl?.proTeam || null,
    };
  });

  // ── grid layout ─────────────────────────────────────────────
  const teamOrder = pickOrder.filter((id) => teamsById.has(id));
  for (const id of teamsById.keys()) if (!teamOrder.includes(id)) teamOrder.push(id);

  const cells = {};
  for (const pk of picks) {
    if (pk.round != null && pk.teamId != null) cells[`${pk.round}:${pk.teamId}`] = pk;
  }

  // ── draft state flags ───────────────────────────────────────
  const totalSlots = size > 0 ? rounds * size : 0;
  const complete = totalSlots > 0 && madePicks.length >= totalSlots;
  const started = madePicks.length > 0;

  // ── on the clock ────────────────────────────────────────────
  let onTheClock = null;
  if (!complete && size > 0) {
    const nextOverall = madePicks.length + 1;
    if (!totalSlots || nextOverall <= totalSlots) {
      const round = Math.ceil(nextOverall / size);
      const idxInRound = (nextOverall - 1) % size;
      const slot = isReversedRound(draftType, round) ? size - 1 - idxInRound : idxInRound;
      const teamId = teamOrder[slot] ?? pickOrder[slot] ?? null;

      onTheClock = {
        overall: nextOverall,
        round,
        roundPick: idxInRound + 1,
        teamId,
        label: `${round}.${String(idxInRound + 1).padStart(2, '0')}`,
      };
    }
  }

  // ── best available ──────────────────────────────────────────
  const available = [...playerById.values()]
    .filter((p) => !draftedPlayerIds.has(p.id) && !p.onTeamId)
    .sort((a, b) => {
      const ar = a.rank ?? (a.adp != null ? a.adp + 0.5 : 99999);
      const br = b.rank ?? (b.adp != null ? b.adp + 0.5 : 99999);
      return ar - br;
    });

  return {
    status: 'ok',
    error: lastError || null,
    warnings,
    lastUpdated: new Date().toISOString(),
    lastPlayersOk: lastPlayersOk || null,
    league: {
      id: rawLeague.id,
      name: settings.name || `League ${rawLeague.id}`,
      seasonYear: rawLeague.seasonId || null,
      size,
      draftType,
    },
    rounds,
    draft: { started, complete },
    teams: teamOrder.map((id, i) => ({ ...teamsById.get(id), draftSlot: i + 1 })),
    picks,
    board: { rounds, teamOrder, cells },
    onTheClock,
    onTheClockTeamId: onTheClock?.teamId ?? null,
    availablePlayers: available.slice(0, AVAILABLE_LIMIT),
    playerCount: playerById.size,
    availableCount: available.length,
  };
}
