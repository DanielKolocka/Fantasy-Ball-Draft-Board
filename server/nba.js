// ─────────────────────────────────────────────────────────────
//  ESPN NBA id → label maps.
//  These are stable enough to hardcode, but every lookup falls
//  back gracefully so an unexpected id never breaks a render.
// ─────────────────────────────────────────────────────────────

export const PRO_TEAMS = {
  0: 'FA',
  1: 'ATL', 2: 'BOS', 3: 'NOP', 4: 'CHI', 5: 'CLE', 6: 'DAL', 7: 'DEN',
  8: 'DET', 9: 'GSW', 10: 'HOU', 11: 'IND', 12: 'LAC', 13: 'LAL', 14: 'MIA',
  15: 'MIL', 16: 'MIN', 17: 'BKN', 18: 'NYK', 19: 'ORL', 20: 'PHI', 21: 'PHX',
  22: 'POR', 23: 'SAC', 24: 'SAS', 25: 'OKC', 26: 'UTA', 27: 'WSH', 28: 'TOR',
  29: 'MEM', 30: 'CHA',
};

// Lineup slot ids used by ESPN NBA leagues.
export const LINEUP_SLOTS = {
  0: 'PG', 1: 'SG', 2: 'SF', 3: 'PF', 4: 'C',
  5: 'G', 6: 'F', 7: 'SG/SF', 8: 'G/F', 9: 'PF/C', 10: 'F/C',
  11: 'UTIL', 12: 'BE', 13: 'IR', 15: 'Rookie',
};

// defaultPositionId → primary position.
export const DEFAULT_POSITION = { 1: 'PG', 2: 'SG', 3: 'SF', 4: 'PF', 5: 'C' };

// The five slots we surface as position-filter chips.
export const POSITION_SLOT_IDS = [0, 1, 2, 3, 4];
export const SLOT_TO_POSITION = { 0: 'PG', 1: 'SG', 2: 'SF', 3: 'PF', 4: 'C' };
export const POSITION_ORDER = ['PG', 'SG', 'SF', 'PF', 'C'];

// Roster slots that consume a draft pick (everything except IR / rookie stashes).
export function isDraftableSlot(slotId) {
  const n = Number(slotId);
  return n >= 0 && n <= 12;
}
