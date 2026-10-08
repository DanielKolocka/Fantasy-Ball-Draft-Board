import { readFileSync, writeFileSync } from 'node:fs';
import { isReversedRound } from './normalize.js';

// You record each pick yourself as it happens in the real draft, and the
// board fills in from that — this app never reads draft picks from ESPN.
// Picks are persisted to disk so a server restart mid-draft is harmless.

const FILE = new URL('./manual-draft.json', import.meta.url);

let picks = load();

function load() {
  try {
    const raw = JSON.parse(readFileSync(FILE, 'utf8'));
    if (Array.isArray(raw?.picks)) {
      return raw.picks
        .map((p) => ({ playerId: Number(p.playerId), teamId: p.teamId != null ? Number(p.teamId) : null }))
        .filter((p) => Number.isFinite(p.playerId) && p.playerId > 0);
    }
  } catch {
    /* no file yet */
  }
  return [];
}

function persist() {
  try {
    writeFileSync(FILE, JSON.stringify({ updated: new Date().toISOString(), picks }, null, 2));
  } catch (err) {
    console.error('[manual] could not persist picks:', err.message);
  }
}

export function manualPickCount() {
  return picks.length;
}

/** Append a pick for the next slot. `teamId` optional — normally inferred from snake order. */
export function addManualPick(playerId, teamId = null) {
  const id = Number(playerId);
  if (!Number.isFinite(id) || id <= 0) throw new Error('invalid playerId');
  if (picks.some((p) => p.playerId === id)) throw new Error('that player is already drafted');
  picks.push({ playerId: id, teamId: teamId != null ? Number(teamId) : null });
  persist();
  return picks.length;
}

export function undoManualPick() {
  const removed = picks.pop() || null;
  persist();
  return removed;
}

export function resetManualPicks() {
  picks = [];
  persist();
}

/**
 * Turn the recorded pick list into ESPN-shaped `draftDetail.picks`, computing
 * round / roundPick / teamId via the league's draft order. The result drops
 * straight into normalize().
 */
export function synthesizeManualPicks(rawLeague) {
  const settings = rawLeague?.settings || {};
  const size =
    Number(settings.size) || (Array.isArray(rawLeague?.teams) ? rawLeague.teams.length : 0) || 0;
  const ds = settings.draftSettings || {};
  const type = ds.type || 'SNAKE';

  let order = Array.isArray(ds.pickOrder) && ds.pickOrder.length ? ds.pickOrder.slice() : [];
  if (!order.length && Array.isArray(rawLeague?.teams)) order = rawLeague.teams.map((t) => t.id);

  return picks.map((p, i) => {
    const overall = i + 1;
    const round = size ? Math.ceil(overall / size) : 1;
    const idx = size ? (overall - 1) % size : 0;
    const slot = isReversedRound(type, round) ? size - 1 - idx : idx;
    return {
      playerId: p.playerId,
      teamId: p.teamId ?? order[slot] ?? null,
      overallPickNumber: overall,
      roundId: round,
      roundPickNumber: idx + 1,
    };
  });
}
