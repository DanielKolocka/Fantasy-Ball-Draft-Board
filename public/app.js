/* Draft board frontend — plain JS, no build step.
 *
 * Everything about the league — name, teams, managers, draft order, rounds —
 * is entered by hand in League Setup. Picks are always recorded by
 * clicking/searching a player here. The only thing this app pulls from ESPN
 * is the player database (names, positions, pro team, rank, ADP).
 *
 * Data comes from the local backend two ways at once:
 *   • SSE (/api/stream)          → instant updates when a pick is recorded
 *   • polling (/api/draft-state) → reliable baseline / fallback
 * Both feed the same apply() function; we only re-render when the
 * server's `revision` counter actually changes.
 */

const POLL_MS = 2500;

const ui = {
  leagueName: document.getElementById('league-name'),
  leagueMeta: document.getElementById('league-meta'),
  clockLabel: document.getElementById('clock-label'),
  clockTeam: document.getElementById('clock-team'),
  connDot: document.getElementById('conn-dot'),
  connText: document.getElementById('conn-text'),
  updated: document.getElementById('updated'),
  banner: document.getElementById('banner'),
  head: document.getElementById('board-head'),
  body: document.getElementById('board-body'),
  availCount: document.getElementById('avail-count'),
  availList: document.getElementById('avail-list'),
  posFilters: document.getElementById('pos-filters'),
  sortToggle: document.getElementById('sort-toggle'),
  manualHint: document.getElementById('manual-hint'),
  undoPick: document.getElementById('undo-pick'),
  restartDraft: document.getElementById('restart-draft'),
  playerSearch: document.getElementById('player-search'),
  leagueSetupBtn: document.getElementById('league-setup-btn'),
  lsOverlay: document.getElementById('league-setup-overlay'),
  lsClose: document.getElementById('ls-close'),
  lsCancel: document.getElementById('ls-cancel'),
  lsError: document.getElementById('ls-error'),
  lsName: document.getElementById('ls-name'),
  lsDraftType: document.getElementById('ls-draft-type'),
  lsRounds: document.getElementById('ls-rounds'),
  lsTeams: document.getElementById('ls-teams'),
  lsAddTeam: document.getElementById('ls-add-team'),
  lsSave: document.getElementById('ls-save'),
};

const view = {
  state: null,
  renderedRevision: -1,
  posFilter: 'ALL',
  sortBy: 'rank',
  connMode: 'starting', // starting | live | polling | down
  lastPayloadAt: 0,
  manualPickCount: 0,
  autoOpenedSetup: false,
  searchQuery: '',
  searchResults: [],
};

/* ── controls ─────────────────────────────────────────────── */
ui.posFilters.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-pos]');
  if (!btn) return;
  view.posFilter = btn.dataset.pos;
  setActive(ui.posFilters, btn);
  renderSidebar(true);
});

ui.sortToggle.addEventListener('click', (e) => {
  const btn = e.target.closest('button[data-sort]');
  if (!btn) return;
  view.sortBy = btn.dataset.sort;
  setActive(ui.sortToggle, btn);
  renderSidebar(true);
});

ui.undoPick.addEventListener('click', async () => {
  const r = await postJson('/api/manual/undo', {});
  if (r?.state) apply(r.state);
});

ui.restartDraft.addEventListener('click', async () => {
  const n = view.state?.manualPickCount ?? 0;
  if (n > 0 && !confirm(`Restart the draft? This clears all ${n} recorded pick(s) — it can't be undone.`)) {
    return;
  }
  const r = await postJson('/api/manual/reset', {});
  if (r?.state) apply(r.state);
});

ui.leagueSetupBtn.addEventListener('click', openLeagueSetup);
ui.lsClose.addEventListener('click', closeLeagueSetup);
ui.lsCancel.addEventListener('click', closeLeagueSetup);
ui.lsOverlay.addEventListener('click', (e) => {
  if (e.target === ui.lsOverlay) closeLeagueSetup();
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && !ui.lsOverlay.hidden) closeLeagueSetup();
});
ui.lsAddTeam.addEventListener('click', () => addTeamRow());
ui.lsTeams.addEventListener('click', (e) => {
  const btn = e.target.closest('.remove-team');
  if (!btn) return;
  btn.closest('.team-row')?.remove();
  renumberTeamRows();
});
ui.lsSave.addEventListener('click', saveLeagueSetup);

let searchTimer = null;
ui.playerSearch.addEventListener('input', () => {
  view.searchQuery = ui.playerSearch.value.trim();
  clearTimeout(searchTimer);
  searchTimer = setTimeout(runSearch, 150);
});

ui.playerSearch.addEventListener('keydown', async (e) => {
  if (e.key === 'Enter') {
    e.preventDefault();
    clearTimeout(searchTimer);
    if (view.searchQuery) await runSearch(); // make sure results are current
    const first = currentList()[0];
    if (first) draftPlayer(first.id);
  } else if (e.key === 'Escape') {
    clearSearch();
  }
});

function setActive(group, btn) {
  group.querySelectorAll('button').forEach((b) => b.classList.toggle('active', b === btn));
}

/* ── data transport ──────────────────────────────────────── */
function startStream() {
  let es;
  try {
    es = new EventSource('/api/stream');
  } catch {
    return;
  }
  es.addEventListener('state', (ev) => {
    try {
      apply(JSON.parse(ev.data), 'live');
    } catch {
      /* ignore malformed frame */
    }
  });
  es.onopen = () => setConn('live');
  es.onerror = () => {
    if (view.connMode === 'live') setConn('polling');
  };
}

async function pollOnce() {
  try {
    const res = await fetch('/api/draft-state', { cache: 'no-store' });
    const data = await res.json();
    if (res.ok) {
      apply(data, view.connMode === 'live' ? 'live' : 'polling');
    } else {
      showBanner(data?.message || `Backend returned ${res.status}`, 'warn');
      if (view.connMode !== 'live') setConn('down');
    }
  } catch {
    if (view.connMode !== 'live') setConn('down');
  }
}

async function postJson(url, body) {
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body || {}),
    });
    const data = await res.json().catch(() => ({}));
    if (!res.ok || data.ok === false) {
      showBanner(data.error || `Request failed (${res.status})`, 'warn');
    }
    return data;
  } catch (err) {
    showBanner(`Request failed: ${err.message}`, 'warn');
    return null;
  }
}

function apply(state, mode) {
  if (!state) return;
  view.lastPayloadAt = Date.now();
  if (mode) setConn(mode);

  if (state.status === 'error' && !state.teams?.length) {
    showBanner(state.error?.message || 'Backend error', 'error');
  }

  view.state = state;
  if (state.manualPickCount != null) view.manualPickCount = state.manualPickCount;
  updateStatusBar(state);
  renderControls();

  // Nothing set up yet — open League Setup for them rather than showing an
  // empty board with no explanation. Only ever does this once per page load.
  if (!view.autoOpenedSetup && !(state.teams || []).length && ui.lsOverlay.hidden) {
    view.autoOpenedSetup = true;
    openLeagueSetup();
  }

  if (state.revision !== undefined && state.revision === view.renderedRevision) return;
  view.renderedRevision = state.revision ?? view.renderedRevision;
  renderBoard(state);
  renderSidebar(false);
}

function setConn(mode) {
  view.connMode = mode;
  const map = {
    starting: ['dot', 'starting'],
    live: ['dot live', 'live (push)'],
    polling: ['dot polling', 'polling'],
    down: ['dot down', 'no connection'],
  };
  const [cls, text] = map[mode] || map.starting;
  ui.connDot.className = cls;
  ui.connText.textContent = text;
}

/* ── controls ─────────────────────────────────────────────── */
function renderControls() {
  const s = view.state;
  const team = s && (s.teams || []).find((t) => t.id === s.onTheClockTeamId);
  if (s?.draft?.complete) {
    ui.manualHint.textContent = 'Draft complete.';
  } else if (s?.onTheClock && team) {
    ui.manualHint.textContent = `Pick ${s.onTheClock.label} → click the player ${team.name} took`;
  } else if (!(s?.teams || []).length) {
    ui.manualHint.textContent = 'Set up your league to begin';
  } else {
    ui.manualHint.textContent = 'Click the player as each pick is made';
  }
}

/* ── league setup ────────────────────────────────────────── */
async function openLeagueSetup() {
  ui.lsError.classList.add('hidden');
  ui.lsError.textContent = '';
  let cfg = { name: '', draftType: 'SNAKE', rounds: 13, teams: [] };
  try {
    const res = await fetch('/api/league', { cache: 'no-store' });
    if (res.ok) cfg = await res.json();
  } catch {
    /* fall back to defaults below */
  }

  ui.lsName.value = cfg.name || '';
  ui.lsDraftType.value = cfg.draftType === 'LINEAR' || cfg.draftType === 'SNAKE_3RR' ? cfg.draftType : 'SNAKE';
  ui.lsRounds.value = cfg.rounds || 13;

  ui.lsTeams.innerHTML = '';
  const teams = cfg.teams?.length ? cfg.teams : Array.from({ length: 10 }, () => ({ name: '', manager: '' }));
  for (const t of teams) addTeamRow(t.name, t.manager);

  ui.lsOverlay.hidden = false;
  ui.lsName.focus();
}

function closeLeagueSetup() {
  ui.lsOverlay.hidden = true;
}

function addTeamRow(name = '', manager = '') {
  const row = document.createElement('div');
  row.className = 'team-row';
  row.innerHTML = `
    <span class="team-num"></span>
    <input class="team-name" type="text" maxlength="60" placeholder="Team name" />
    <input class="team-manager" type="text" maxlength="60" placeholder="Manager (optional)" />
    <button class="remove-team" type="button" title="Remove team">✕</button>
  `;
  row.querySelector('.team-name').value = name;
  row.querySelector('.team-manager').value = manager;
  ui.lsTeams.appendChild(row);
  renumberTeamRows();
}

function renumberTeamRows() {
  ui.lsTeams.querySelectorAll('.team-row').forEach((row, i) => {
    row.querySelector('.team-num').textContent = `${i + 1}.`;
  });
}

async function saveLeagueSetup() {
  const teams = [...ui.lsTeams.querySelectorAll('.team-row')]
    .map((row) => ({
      name: row.querySelector('.team-name').value.trim(),
      manager: row.querySelector('.team-manager').value.trim(),
    }))
    .filter((t) => t.name);

  const payload = {
    name: ui.lsName.value.trim(),
    draftType: ui.lsDraftType.value,
    rounds: Number(ui.lsRounds.value) || 13,
    teams,
  };

  ui.lsSave.disabled = true;
  const r = await postJson('/api/league', payload);
  ui.lsSave.disabled = false;

  if (r?.ok) {
    apply(r.state);
    closeLeagueSetup();
  } else {
    ui.lsError.textContent = r?.error || 'Could not save.';
    ui.lsError.classList.remove('hidden');
  }
}

/* ── pick actions ────────────────────────────────────────── */
async function draftPlayer(playerId) {
  const r = await postJson('/api/manual/pick', { playerId });
  if (r?.state) {
    clearSearch();
    apply(r.state);
  }
}

function clearSearch() {
  view.searchQuery = '';
  view.searchResults = [];
  ui.playerSearch.value = '';
  renderSidebar(false);
}

async function runSearch() {
  const q = view.searchQuery;
  if (!q) {
    view.searchResults = [];
    renderSidebar(false);
    return;
  }
  try {
    const res = await fetch(`/api/players/search?q=${encodeURIComponent(q)}`, { cache: 'no-store' });
    const data = await res.json();
    if (view.searchQuery === q) {
      view.searchResults = data.players || [];
      renderSidebar(false);
    }
  } catch {
    /* ignore */
  }
}

/* ── status bar ──────────────────────────────────────────── */
function updateStatusBar(state) {
  if (state.league) {
    ui.leagueName.textContent = state.league.name || 'Draft Board';
    const bits = [];
    if (state.league.size) bits.push(`${state.league.size} teams`);
    if (state.rounds) bits.push(`${state.rounds} rounds`);
    if (state.league.draftType) bits.push(fmtDraftType(state.league.draftType));
    ui.leagueMeta.textContent = bits.join(' · ');
  }

  const teamsById = new Map((state.teams || []).map((t) => [t.id, t]));
  if (state.draft?.complete) {
    ui.clockLabel.textContent = '';
    ui.clockTeam.textContent = 'Draft complete';
  } else if (state.onTheClock) {
    const team = teamsById.get(state.onTheClock.teamId);
    ui.clockLabel.textContent = `Pick ${state.onTheClock.label}`;
    ui.clockTeam.textContent = team ? `${team.name} on the clock` : 'On the clock';
  } else if (!(state.teams || []).length) {
    ui.clockLabel.textContent = '';
    ui.clockTeam.textContent = 'Set up your league to begin';
  } else {
    ui.clockLabel.textContent = '';
    ui.clockTeam.textContent = '';
  }

  renderBanner(state);
}

function renderBanner(state) {
  const msgs = [];
  // ESPN only supplies player search here — an ESPN hiccup never breaks the
  // board, league setup, or picks, so this is always just a warning.
  if (state.error?.message) {
    msgs.push({ text: `ESPN player data unavailable: ${state.error.message}`, kind: 'warn' });
  }
  for (const w of state.warnings || []) msgs.push({ text: w, kind: 'warn' });
  if (!msgs.length) {
    ui.banner.classList.add('hidden');
    return;
  }
  const worst = msgs.some((m) => m.kind === 'error') ? 'error' : 'warn';
  ui.banner.className = `banner ${worst}`;
  ui.banner.textContent = msgs.map((m) => m.text).join('  •  ');
}

function showBanner(text, kind = 'warn') {
  ui.banner.className = `banner ${kind}`;
  ui.banner.textContent = text;
}

/* ── board grid ──────────────────────────────────────────── */
function renderBoard(state) {
  const board = state.board || { rounds: 0, teamOrder: [], cells: {} };
  const teamsById = new Map((state.teams || []).map((t) => [t.id, t]));
  const order = board.teamOrder?.length ? board.teamOrder : (state.teams || []).map((t) => t.id);
  const rounds = board.rounds || state.rounds || 0;
  const clockTeamId = state.onTheClockTeamId;
  const clockRound = state.onTheClock?.round;
  const latestOverall = (state.picks || []).reduce((m, p) => Math.max(m, p.overall || 0), 0);

  let head = '<th class="rnd-col">R</th>';
  for (const teamId of order) {
    const t = teamsById.get(teamId) || { name: `Team ${teamId}`, owner: '' };
    const clock = teamId === clockTeamId ? ' clock-col' : '';
    head += `<th class="team-col${clock}" title="${esc(t.name)}${t.owner ? ' — ' + esc(t.owner) : ''}">
      <div class="team-name">${esc(t.name)}</div>
      <div class="team-owner">${esc(t.owner || '')}</div>
    </th>`;
  }
  ui.head.innerHTML = head;

  let bodyHtml = '';
  for (let r = 1; r <= rounds; r += 1) {
    bodyHtml += `<tr><td class="rnd-col">${r}</td>`;
    for (const teamId of order) {
      const pick = board.cells?.[`${r}:${teamId}`];
      const isClockCol = teamId === clockTeamId;
      const isClockCell = isClockCol && clockRound === r && !pick;
      const classes = ['cell'];
      if (isClockCol) classes.push('clock-col');
      if (isClockCell) classes.push('on-clock');
      if (pick) {
        classes.push('filled');
        if (pick.overall && pick.overall === latestOverall) classes.push('latest');
      }
      bodyHtml += `<td class="${classes.join(' ')}">${pick ? cellHtml(pick) : ''}</td>`;
    }
    bodyHtml += '</tr>';
  }
  ui.body.innerHTML =
    bodyHtml || '<tr><td class="empty">Set up your league (⚙ Edit league) to see the grid.</td></tr>';
}

function cellHtml(pick) {
  const meta = [pick.positions?.join('/') || '', pick.proTeam || ''].filter(Boolean).join(' · ');
  return `
    <div class="cell-row">
      <div class="cell-main">
        ${avatarHtml(pick.playerId, pick.playerName, 22)}
        <div class="cell-text">
          <div class="cell-player" title="${esc(pick.playerName)}">${esc(pick.playerName)}</div>
          <div class="cell-meta">${esc(meta)}</div>
        </div>
      </div>
      <div class="cell-overall">${pick.overall ?? ''}</div>
    </div>
  `;
}

/* ── player headshots ────────────────────────────────────── */
// ESPN's public headshot CDN. Not every player has a photo (deep bench /
// two-way guys) — the <img> onerror removes itself and reveals the initials
// underneath, so a 404 there is expected and harmless.
function headshotUrl(playerId) {
  return playerId ? `https://a.espncdn.com/i/headshots/nba/players/full/${playerId}.png` : '';
}

function initialsOf(name) {
  const parts = String(name || '').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  const first = parts[0][0] || '';
  const last = parts.length > 1 ? parts[parts.length - 1][0] || '' : '';
  return (first + last).toUpperCase() || '?';
}

function avatarHtml(playerId, name, size = 22) {
  const url = headshotUrl(playerId);
  const fontSize = Math.round(size * 0.4);
  const style = `width:${size}px;height:${size}px;font-size:${fontSize}px`;
  const img = url
    ? `<img src="${url}" alt="" loading="lazy" width="${size}" height="${size}" onerror="this.remove()" />`
    : '';
  return `<span class="avatar" style="${style}">${esc(initialsOf(name))}${img}</span>`;
}

/* ── sidebar ─────────────────────────────────────────────── */
function currentList() {
  const state = view.state;
  if (!state) return [];
  let players = view.searchQuery ? view.searchResults.slice() : (state.availablePlayers || []).slice();
  if (view.posFilter !== 'ALL') {
    players = players.filter((p) => (p.positions || []).includes(view.posFilter));
  }
  if (!view.searchQuery) {
    players.sort((a, b) => {
      if (view.sortBy === 'adp') {
        return (a.adp ?? 9999) - (b.adp ?? 9999) || (a.rank ?? 9999) - (b.rank ?? 9999);
      }
      return (a.rank ?? 9999) - (b.rank ?? 9999) || (a.adp ?? 9999) - (b.adp ?? 9999);
    });
  }
  return players;
}

function renderSidebar(preserveScroll) {
  const state = view.state;
  if (!state) return;
  const scrollTop = preserveScroll ? ui.availList.scrollTop : 0;
  const pickable = !state.draft?.complete && (state.teams || []).length > 0;
  const players = currentList();

  ui.availCount.textContent = state.availableCount != null ? `(${state.availableCount})` : '';

  if (!players.length) {
    ui.availList.innerHTML = view.searchQuery
      ? '<li class="empty">No matches.</li>'
      : state.playerCount
        ? '<li class="empty">No available players match this filter.</li>'
        : '<li class="empty">Player list unavailable — see the banner above.</li>';
    return;
  }

  ui.availList.innerHTML = players
    .map((p) => {
      const sub = [p.positions?.join('/') || '', p.proTeam || ''].filter(Boolean).join(' · ');
      const primary =
        view.sortBy === 'adp'
          ? p.adp != null
            ? p.adp.toFixed(1)
            : '–'
          : p.rank != null
            ? p.rank
            : '–';
      const secondary =
        view.sortBy === 'adp'
          ? p.rank != null
            ? `#${p.rank}`
            : ''
          : p.adp != null
            ? `ADP ${p.adp.toFixed(1)}`
            : '';
      return `<li${pickable ? ` class="pickable" data-id="${p.id}" tabindex="0"` : ''}>
        <span class="av-rank">${primary}</span>
        ${avatarHtml(p.id, p.name, 22)}
        <span>
          <span class="av-name">${esc(p.name)}</span>
          <span class="av-sub">${esc(sub)}</span>
        </span>
        <span class="av-adp">${esc(secondary)}</span>
      </li>`;
    })
    .join('');

  ui.availList.scrollTop = scrollTop;
}

ui.availList.addEventListener('click', (e) => {
  const li = e.target.closest('li.pickable');
  if (li) draftPlayer(Number(li.dataset.id));
});
ui.availList.addEventListener('keydown', (e) => {
  if (e.key !== 'Enter') return;
  const li = e.target.closest('li.pickable');
  if (li) draftPlayer(Number(li.dataset.id));
});

/* ── misc ────────────────────────────────────────────────── */
function fmtDraftType(t) {
  if (t === 'SNAKE_3RR') return 'snake (3RR)';
  return String(t || '').toLowerCase();
}

function esc(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c],
  );
}

function tickUpdated() {
  if (!view.lastPayloadAt) return;
  const secs = Math.round((Date.now() - view.lastPayloadAt) / 1000);
  ui.updated.textContent = secs < 2 ? 'just now' : `${secs}s ago`;
  if (secs > 15 && view.connMode === 'live') setConn('polling');
}

setConn('starting');
startStream();
pollOnce();
setInterval(pollOnce, POLL_MS);
setInterval(tickUpdated, 1000);
