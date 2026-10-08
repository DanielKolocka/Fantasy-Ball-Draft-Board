# Fantasy Basketball Draft Board

A local draft board for a snake draft. Open it in its own browser window —
it's not part of your main draft screen, so it won't show up in a screen
share.

**Everything about the league — name, teams, managers, draft order — is
entered by hand in the app. The only thing pulled from ESPN is the player
database** (names, positions, pro team, rank/ADP), for search while you
record picks. Nothing about this board depends on any specific ESPN league's
settings, and it isn't tied to a live ESPN draft at all.

- **Backend** (Node/Express): holds your ESPN cookies server-side (only used
  for player search), and serves the league/board state you build locally.
  **No auth secret ever reaches the browser.**
- **Frontend** (plain HTML/JS): the grid + a best-available sidebar with
  player search, updating automatically (SSE push + polling fallback) —
  handy if you want the board open on a second screen while you click picks
  from elsewhere.
- Runs entirely on `localhost`. No deployment, no HTTPS, no public exposure.

---

## 1. Requirements

- **Node.js 20 or newer** (`node --version`). Uses the built-in `fetch` and
  `node --watch`.

## 2. Run it

```bash
npm install
npm run dev
```

Open **http://localhost:3000** in its own window. `npm run dev` auto-restarts
on file changes; `npm start` for a plain run.

The first time you open it with no league set up yet, **League Setup** opens
automatically — fill in your league name, draft type, round count, and each
team's name + manager (in draft order), then **Save league**. You can reopen
it anytime with **`⚙ Edit league`** in the header.

That's enough to use the board — search is just names typed from memory until
you also set up ESPN player data (next section).

## 3. Player search (optional, but recommended) — get your ESPN values

Player search, names, positions, and ADP/rank come from ESPN's player
database. This needs **any ESPN Fantasy Basketball league your account can
see** — it does not have to be the league you're actually drafting, since the
player data itself isn't league-specific.

### League ID and season year
- **League ID** — open any league on `fantasy.espn.com`. The URL looks like
  `https://fantasy.espn.com/basketball/league?leagueId=123456`. The number is
  the league ID.
- **Season year** — the year that league's season *ends* in. The 2025-26
  season is `2026`.

### Auth cookies (needed for a private league)
1. In a browser signed in to `fantasy.espn.com`, open **DevTools**
   (Cmd+Opt+I / F12).
2. Go to **Application** → **Storage** → **Cookies** → `https://fantasy.espn.com`.
3. Copy the full value of two cookies:
   - `espn_s2` — a long URL-encoded string.
   - `SWID` — looks like `{AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}` (keep the braces;
     the app adds them if you forget).

These cookies expire periodically. If the banner starts showing an auth
error, grab fresh ones and update `.env`.

### Configure

```bash
cp .env.example .env
```

Edit `.env`:

```
ESPN_LEAGUE_ID=123456
ESPN_SEASON_YEAR=2026
ESPN_S2=AEB...long...string
ESPN_SWID={AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE}
```

Restart the server (or it auto-restarts under `npm run dev`). Player search
in the sidebar will start working.

---

## Recording picks

- **Search** for the player who was just picked and press **Enter** (drafts the
  top match), or click any player in the sidebar list.
- The pick lands in the current slot; the on-the-clock highlight advances to
  the next team via your configured draft order.
- **↩ Undo** removes the last pick. **⟲ Restart** wipes every recorded pick and
  starts the board over (asks for confirmation first). Picks are saved to
  `server/manual-draft.json`, so a server restart mid-draft is harmless.

## Draft order, including third-round reversal (3RR)

Set in **League Setup** → **Draft type**: Snake, Snake (3RR), or Linear.

3RR plays rounds 1 and 2 as a normal snake, then **round 3 repeats round 2's
direction instead of flipping back** (so the team that picked last in round 1
gets consecutive picks across rounds 2–3); round 4 onward alternates normally
again from there.

> Editing team names or count **after** picks have already been recorded
> reassigns existing picks to the new draft order — finish League Setup before
> you start drafting. If you need to start over, use **⟲ Restart**.

---

## How it works

```
ESPN player API  ──refresh every ~5 min──▶  Express backend  ──▶  in-memory cache
 (cookies, server-side,                           │                     │
  only used for player search)                    │  GET /api/draft-state (JSON)
                                                   │  GET /api/stream     (SSE push)
                                                   │  POST /api/league (league setup)
                                                   │  POST /api/manual/pick (record a pick)
                                                   ▼
                                            Frontend (localhost:3000)
                                            draft grid + best-available sidebar
```

- League setup (`server/league.js`) is local state, persisted to
  `server/league.json`. It never touches ESPN.
- The player database (`kona_player_info`, scoped with an `X-Fantasy-Filter`
  header) refreshes every `PLAYER_POLL_INTERVAL_MS` (default 5 min) and is
  cached to disk (`server/.cache-players.json`) so a restart — or ESPN
  cookies expiring mid-draft — doesn't lose the searchable list; you just
  keep recording picks. This is the *only* ESPN traffic the app makes.
- Every pick you record is layered on top of your league setup and turned
  into the grid via the configured draft order. `/api/draft-state` serves the
  in-memory result immediately; it never blocks on an ESPN call, and the
  board/league/picks all work even with zero ESPN configuration.
- An ESPN player-fetch failure only ever shows as a warning banner — it can't
  break the board, since picks, teams, and draft order are all local.

### API endpoints

| Endpoint | Purpose |
| --- | --- |
| `GET /api/draft-state` | Normalized board state (JSON). |
| `GET /api/stream` | Same state pushed over Server-Sent Events. |
| `GET /api/health` | Connection sanity check (`espnConfigured` reflects whether player search will work). |
| `GET /api/debug/raw` | The league payload sent to the normalizer, plus a sample of the last ESPN player payload (for confirming the schema). Set `DEBUG_DUMP=1` to also write `server/sample-response.json` each refresh. |
| `POST /api/manual/pick` · `/undo` · `/reset` | Record / remove picks (`{ "playerId": 12345 }`). |
| `GET /api/players/search?q=` | Search the full ESPN player universe by name. |
| `GET /api/league` · `POST /api/league` | Read / save the league (name, draft type, rounds, teams). `draftType` accepts `SNAKE`, `SNAKE_3RR`, or `LINEAR`. |

### `/api/draft-state` shape

```jsonc
{
  "status": "ok",
  "error": null,
  "warnings": [],
  "lastUpdated": "2026-10-07T18:00:00.000Z",
  "revision": 42,                 // increments only on a real change
  "league": { "id": "LOCAL", "name": "...", "size": 10, "draftType": "SNAKE" },
  "rounds": 13,
  "draft": { "started": true, "complete": false },
  "teams": [
    { "id": 3, "abbrev": "ISO", "name": "Iso Kings", "owner": "Dana", "draftSlot": 1 }
  ],
  "picks": [
    { "overall": 1, "round": 1, "roundPick": 1, "teamId": 3,
      "playerId": 4066261, "playerName": "...", "positions": ["PG"], "proTeam": "OKC" }
  ],
  "board": {
    "rounds": 13,
    "teamOrder": [3, 7, 1, ...],       // column order (draft slots)
    "cells": { "1:3": { /* pick */ } } // keyed "round:teamId"
  },
  "onTheClock": { "overall": 5, "round": 1, "roundPick": 5, "teamId": 1, "label": "1.05" },
  "onTheClockTeamId": 1,
  "availablePlayers": [
    { "id": 4, "name": "...", "positions": ["SG","SF"], "proTeam": "BOS", "rank": 4, "adp": 4.2 }
  ],
  "playerCount": 900,
  "availableCount": 812,
  "manualPickCount": 1
}
```

---

## Troubleshooting

| Symptom | Likely cause / fix |
| --- | --- |
| Banner: *"ESPN player data unavailable"* | Player search only — the board/picks still work. Check `espn_s2`/`SWID` are current in `.env`, or `ESPN_LEAGUE_ID`/`ESPN_SEASON_YEAR`. |
| Board is empty, "Set up your league to begin" | Expected on first run — click **⚙ Edit league** (or it already auto-opened) and fill in your teams. |
| Sidebar says player list unavailable | ESPN isn't configured (or the fetch failed) — see the banner. Everything else still works. |
| A pick landed on the wrong team | Check **League Setup** → **Draft type** matches your league's actual format — see 3RR above. |

## Player photos

The grid and sidebar show each player's ESPN headshot
(`a.espncdn.com/i/headshots/nba/players/full/{id}.png`, public CDN, no auth
needed). Deep-bench / two-way players sometimes have no photo on ESPN — those
just fall back to a colored circle with the player's initials, no broken-image
icon.

## Notes

- `kona_player_info` is undocumented ESPN API. The player parser is written
  defensively (a missing field degrades one value, never crashes), but if
  ESPN's shape changes, hit `GET /api/debug/raw` and compare — the parsing
  lives in `server/normalize.js` and the id maps in `server/nba.js`.
- `.env` is gitignored. Cookies are only ever sent from the backend to ESPN,
  and only for player search — never for anything about your league or draft.
- This app does not read a league, teams, or draft picks from ESPN at all.
  League setup lives in `server/league.js` / `server/league.json`; picks live
  in `server/manualDraft.js` / `server/manual-draft.json`.
