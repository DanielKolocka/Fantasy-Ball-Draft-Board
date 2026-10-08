import { readFileSync, writeFileSync } from 'node:fs';
import { config } from './config.js';

// The league itself — name, teams, managers, draft order, round count — is
// always entered by hand here. The only thing this app pulls from ESPN is
// the player database (see espnClient.js); ESPN's own league/team settings
// are never read. Persisted to disk so it survives a restart.

const FILE = new URL('./league.json', import.meta.url);

const VALID_DRAFT_TYPES = ['SNAKE', 'SNAKE_3RR', 'LINEAR'];
const DEFAULTS = { name: '', draftType: 'SNAKE', rounds: 13, teams: [] };

let state = load();

function load() {
  try {
    return sanitizeStored(JSON.parse(readFileSync(FILE, 'utf8')));
  } catch {
    return { ...DEFAULTS };
  }
}

function sanitizeTeam(t) {
  const name = String(t?.name || '').trim();
  if (!name) return null;
  return { name: name.slice(0, 60), manager: String(t?.manager || '').trim().slice(0, 60) };
}

function clampRounds(n) {
  const v = Math.trunc(Number(n));
  return Number.isFinite(v) && v >= 1 && v <= 40 ? v : DEFAULTS.rounds;
}

function sanitizeStored(raw) {
  return {
    name: typeof raw?.name === 'string' ? raw.name.trim().slice(0, 80) : '',
    draftType: VALID_DRAFT_TYPES.includes(raw?.draftType) ? raw.draftType : 'SNAKE',
    rounds: clampRounds(raw?.rounds),
    teams: Array.isArray(raw?.teams) ? raw.teams.map(sanitizeTeam).filter(Boolean) : [],
  };
}

function persist() {
  try {
    writeFileSync(FILE, JSON.stringify(state, null, 2));
  } catch (err) {
    console.error('[league] could not persist:', err.message);
  }
}

export function getLeagueConfig() {
  return { ...state, teams: state.teams.map((t) => ({ ...t })) };
}

/** Merge a partial update — name, draftType, rounds, and/or the full teams list. */
export function setLeagueConfig(patch = {}) {
  const next = { ...state };
  if (patch.name !== undefined) next.name = String(patch.name || '').trim().slice(0, 80);
  if (patch.draftType !== undefined) {
    next.draftType = VALID_DRAFT_TYPES.includes(patch.draftType) ? patch.draftType : 'SNAKE';
  }
  if (patch.rounds !== undefined) next.rounds = clampRounds(patch.rounds);
  if (patch.teams !== undefined) {
    if (!Array.isArray(patch.teams)) throw new Error('teams must be a list');
    next.teams = patch.teams.map(sanitizeTeam).filter(Boolean);
  }
  state = next;
  persist();
  return getLeagueConfig();
}

function abbrevFrom(name, index) {
  const words = name.trim().split(/\s+/).filter(Boolean);
  const letters = words.length > 1 ? words.map((w) => w[0]).join('') : words[0] || '';
  return letters.slice(0, 4).toUpperCase() || `T${index + 1}`;
}

/** Build an ESPN-shaped league payload from the config, for normalize(). */
export function synthesizeLeague() {
  const pickOrder = state.teams.map((_, i) => i + 1);
  return {
    id: 'LOCAL',
    seasonId: config.seasonYear || new Date().getFullYear(),
    settings: {
      name: state.name || 'My League',
      size: state.teams.length,
      draftSettings: { type: state.draftType, pickOrder },
      rosterSettings: { lineupSlotCounts: { 0: state.rounds } },
    },
    draftDetail: { picks: [] },
    teams: state.teams.map((t, i) => ({
      id: i + 1,
      abbrev: abbrevFrom(t.name, i),
      name: t.name,
      location: t.name,
      nickname: '',
      logo: null,
      owners: t.manager ? [`{TEAM-${i + 1}}`] : [],
      roster: { entries: [] },
    })),
    members: state.teams
      .map((t, i) =>
        t.manager
          ? { id: `{TEAM-${i + 1}}`, firstName: t.manager, lastName: '', displayName: t.manager }
          : null,
      )
      .filter(Boolean),
  };
}
