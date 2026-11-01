# Dink Valley Tournament System — Technical Audit & Surgical Fix Plan

> **Instructions for AI Coding Agent:**
>
> Do **not** perform a destructive architectural rewrite or alter existing UI layouts/routes. Execute the 5 phases in this document sequentially using targeted, surgical edits across the specified files.

## 1. Executive Summary of All 13 Bugs

| \# | Bug / Symptom | Root Cause | Target Files | 
| ----- | ----- | ----- | ----- | 
| **1** | **Undrawn / Empty Brackets Show `DONE`** | Bracket tab badge checks `unplayedCount === 0` without checking `totalMatches === 0` first. | `src/components/admin/CourtDispatch.tsx`, `src/lib/court-dispatch.ts` | 
| **2** | **Cross-Division Match & Bracket Bleeding** | `findLiveMatchForTeams(matches, nameA, nameB)` searches by team names globally without enforcing `m.categoryId === categoryId`. | `src/lib/match-store.ts`, `src/routes/tournaments.$slug.tsx`, `src/components/public/SimpleBracketView.tsx` | 
| **3** | **Umpire Console Drops Dispatched Matches** | `activeEventMatches` in `umpire.tsx` falls back to `m.id.includes(activeTournamentSlug)`, which evaluates to `false` for `match_<categoryId>_...` IDs. | `src/routes/umpire.tsx` | 
| **4** | **`0 - 0` Server #1 vs Server #2 Desync** | Admin match creation initializes matches at `0-0` with `serverNumber: 1` (`Tm A #1`), while Umpire/Cloud initializes at `serverNumber: 2` (`Tm A #2`). | `src/components/admin/BracketDraw.tsx`, `src/components/admin/CourtDispatch.tsx`, `src/lib/match-store.ts` | 
| **5** | **Blank Team Names (`" vs "`) & Locked Courts** | `dispatchMatchToCourt` updates `court_stations` before saving the full `LiveMatch` (`teamAName`/`teamBName`) or vacating old matches on that court. | `src/lib/court-dispatch.ts`, `src/components/admin/DispatchDebugStation.tsx` | 
| **6** | **2nd Server Not Switching on Side-Out (`3-2-2`)** | Court position math ignores `serverNumber` transitions (`1 -> 2`) or fails to replay `score.rallies` when hydrated from Supabase. | `src/lib/match-store.ts`, `src/routes/umpire.tsx`, `src/components/public/MiniCourtVisualizer.tsx` | 
| **7** | **`0-0-2` Coin Toss Server Jumps to Left Player** | Fallback logic sees `serverNumber === 2` at `0-0` and mistakes the opening serve (`0-0-2`) for a mid-game 2nd server (`Base 2` / Left court). | `src/lib/match-store.ts`, `src/routes/umpire.tsx` | 
| **8** | **Playoff Rematches Auto-Complete Prematurely** | `MainDrawKnockoutMatchCard` and `SimpleBracketView` call `findLiveMatchForTeams(matches, nameA, nameB)`, grabbing completed Pool Play games between the same two teams. | `src/routes/tournaments.$slug.tsx`, `src/components/public/SimpleBracketView.tsx`, `src/components/admin/DrawsManager.tsx` | 
| **9** | **"Delete Matches" Wipes Brackets & Players** | Delete handler clears `dv_drawn_groups` / `tournaments.rules`, and categories relying on `drawnGroups` for teams lose their roster. | `src/components/admin/CourtDispatch.tsx`, `src/components/admin/BracketDraw.tsx`, `src/lib/court-dispatch.ts` | 
| **10** | **Public Standings Hallucinate W-L & `+/-` Diff** | Standings `Map` in `SimpleBracketView.tsx` and `BracketCard` (`tournaments.$slug.tsx`) is keyed by `t.name` instead of `t.id`, merging or overwriting same-club teams (e.g. multiple `"Nanomoly"` or `"NV"` pairs) and flipping scores when `live.teamAName !== a.name`. | `src/components/public/SimpleBracketView.tsx`, `src/routes/tournaments.$slug.tsx` | 
| **11** | **`mergeMatchesSafely` Collapses Same-Club Matches** | Step 4 of `mergeMatchesSafely` (`match-store.ts` line 437) deduplicates by `teamAName::teamBName` without `m.id` or `teamAPlayers`/`teamBPlayers`, overwriting one club pair's score with another pair's score. | `src/lib/match-store.ts` | 
| **12** | **ID Format Split-Brain (`match_` vs `match-`)** | `migrateMatchesToDeterministicIds` rewrites non-`match_` IDs to `createPairMatchId` (`match-...`), while `SimpleBracketView` and `BracketCard` look up `createCategoryScopedMatchId` (`match_...`), causing exact ID lookups to miss and fall back to fuzzy team-name matching. | `src/lib/match-store.ts`, `src/lib/court-dispatch.ts` | 
| **13** | **`FindMatchesModal` Shows Foreign Division Scores** | `FindMatchesModal.tsx` matches by `m.teamAName === team.name` without checking `m.categoryId === category.id` or player rosters. | `src/components/public/FindMatchesModal.tsx` | 

---

## Phase 1: Protect Data Integrity & Standardize Match Initialization

### Step 1.1: Prevent "Delete Matches" from Deleting `drawnGroups` and `category.teams` (Bug #9)

**Problem:** Clicking "Delete Matches" / "Clear Matches" wipes out drawn brackets (`dv_drawn_groups_*` / `tournaments.rules`) and causes player names to disappear in categories that derive their team list from `drawnGroups`.

**Required Edits (`src/components/admin/CourtDispatch.tsx`, `src/components/admin/DrawsManager.tsx`, `src/components/admin/BracketDraw.tsx`, `src/lib/court-dispatch.ts`):**

1. Locate all "Delete Matches", "Clear Matches", "Reset Matches", and "Clear Queue" handlers.
2. Restrict these handlers so they **ONLY**:
   * Delete or reset records in `dv_matches`, `dv_live_matches`, `dv_dispatch_queue`, and `public.matches`.
   * Vacate affected courts in `dv_court_stations` and `public.court_stations` (`status = 'idle'`, `current_match_id = null`).
3. **NEVER** delete `dv_drawn_groups_*` or remove drawn bracket groups from `tournaments.rules` when deleting/resetting matches.
4. **NEVER** delete or clear `category.teams` (`public.teams`) when deleting matches or resetting a bracket draw.
5. In `src/components/admin/BracketDraw.tsx`, whenever `drawnGroups` are saved or loaded, ensure any teams present in `drawnGroups` slots are also synced into `category.teams` so player rosters are permanently backed up.

### Step 1.2: Standardize Initial Match State to `0 - 0 - 2` (Bug #4)

**Problem:** Diagnostics Telemetry flags a `DESYNC` on newly dispatched matches (`Tm A #2` on Cloud vs `Tm A #1` on Admin) because Admin initializes new matches with `serverNumber: 1`.

**Required Edits (`src/lib/match-store.ts`, `src/components/admin/BracketDraw.tsx`, `src/components/admin/CourtDispatch.tsx`, `src/lib/court-dispatch.ts`):**

1. Audit every place where a new `LiveMatch` or initial `score` object is created or reset at `0 - 0`.
2. Enforce the official pickleball doubles starting state everywhere:
   ```ts
   score: {
     teamAScore: 0,
     teamBScore: 0,
     servingTeam: "A",
     serverNumber: 2, // ALWAYS start at Server #2 (0-0-2), NEVER 1
     activeServerBase: 1, // ALWAYS start with Base 1 (Right court)
     rallies: [],
   }
   ```

---

## Phase 2: Lock Down Division Scoping & Bracket Badges

### Step 2.1: Fix Premature `DONE` Badge on Undrawn/Empty Brackets (Bug #1)

**Problem:** When a division or bracket has `0` generated matches, `unplayedCount` is `0`. The UI evaluates `unplayedCount === 0` as `DONE`.

**Required Edits (`src/components/admin/CourtDispatch.tsx` & `src/lib/court-dispatch.ts`):**

1. In the Direct Court Dispatch modal and bracket status calculators, scope all bracket groups and match counts strictly to the selected division (`m.categoryId === selectedCategory.id`).
2. Compute bracket tab badges using this **strict precedence**:
   ```ts
   const badgeLabel =
     totalMatches === 0
       ? "EMPTY"
       : completedCount === totalMatches
       ? "DONE"
       : unplayedCount === 0 && onCourtCount > 0
       ? `${onCourtCount} ON COURT`
       : `${unplayedCount} LEFT`;
   ```
3. Never display `DONE` when `totalMatches === 0`.
4. When opening the Direct Court Dispatch modal or switching divisions, automatically select the first bracket tab where `unplayedCount > 0`.

### Step 2.2: Eliminate Cross-Division & Playoff Rematch Bleeding (Bugs #2 & #8)

**Problem:** `SimpleBracketView.tsx` (line 202) and `tournaments.$slug.tsx` (lines 997, 1029, 1034, 1147, 1365) fall back to `|| findLiveMatchForTeams(matches, a.name, b.name)` without passing `tournamentSlug`, `category.id`, or `stage`. When a match in a division hasn't been played or found by ID, `findLiveMatchForTeams` grabs a match from **another division or bracket** where teams share the same name!

**Required Edits (`src/lib/match-store.ts`, `src/routes/tournaments.$slug.tsx`, `src/components/public/SimpleBracketView.tsx`):**

1. **In `src/routes/tournaments.$slug.tsx` (`categoryFinalMatches`, lines ~204–211):**
   * Remove the loose team-name fallback `if (category.teams?.some((t) => t.name === m.teamAName || t.name === m.teamBName)) return true;` and strictly require `isSameCategory(m.categoryId, category.id)`.
2. **In `src/components/public/SimpleBracketView.tsx` (line ~202) & `src/routes/tournaments.$slug.tsx` (`BracketCard` lines ~997, 1029, 1034, 1147 & `Pools` line ~1365):**
   * Replace unscoped `findLiveMatchForTeams(matches, a.name, b.name)` with `findMatchForPair(matches, a.name, b.name, undefined, category.id, currentGroup.letter, a.players, b.players)` — OR strictly require `m.id === scopedMatchId`!
3. **In `src/routes/tournaments.$slug.tsx` (`Pools` Jump Bar `hasLiveMatch`, lines ~1277–1284):**
   * Require `isSameCategory(m.categoryId, category.id) && m.stage?.includes(\`Bracket \${grp.letter}\`)`.
4. **Playoff Knockout Cards (`MatchCard` line ~825, `MainDrawKnockoutMatchCard` line ~879 in `tournaments.$slug.tsx`, and Playoff section in `SimpleBracketView.tsx` line ~121):**
   * Look up matches by exact `matches.find((m) => m.id === match.id)` or `findMatchForPair(matches, nameA, nameB, undefined, category.id, match.round, match.teamA?.players, match.teamB?.players)`.
   * Explicitly reject any match where `m.stage?.includes("Pool Play")` or `m.stage?.includes("Bracket ")` so a completed Pool Play match never auto-completes a Playoff rematch!

---

## Phase 3: Fix Public Bracket Standings & Score Hallucinations (Bugs #10, #11, #12, #13)

### Step 3.1: Key Public Standings by `team.id` (Not `team.name`) and Disambiguate Score Order by Players (Bug #10)

**Problem:**
In both `src/components/public/SimpleBracketView.tsx` (lines 180–239) and `src/routes/tournaments.$slug.tsx` (`BracketCard`, lines 970–1025):
1. The standings `Map` uses `t.name` as its key (`tableMap.set(t.name, ...)`). If a bracket has two pairs with the same club/team name (e.g., two `"Nanomoly"` or `"NV"` teams), they overwrite each other in the standings table and combine their W-L and Point Diff (`+/-`)!
2. Score orientation checks `const flipped = live ? live.teamAName !== a.name : false;`. If both teams have the same name (or if team names match), `flipped` is wrong unless player rosters are compared!

**Required Edits (`src/components/public/SimpleBracketView.tsx` & `src/routes/tournaments.$slug.tsx`):**

1. **Key the Standings `Map` by `t.id` (fallback to `${t.name}::${(t.players || []).join(",")}`):**
   ```ts
   const getTeamKey = (t: { id?: string; name: string; players?: string[] }) =>
     t.id || `${t.name.trim().toLowerCase()}::${(t.players || []).map((p) => p.trim().toLowerCase()).sort().join(",")}`;
   ```
   Use `getTeamKey(t)` when initializing `tableMap` / `map` and when looking up `statsA` (`tableMap.get(getTeamKey(a))`) and `statsB` (`tableMap.get(getTeamKey(b))`).
2. **Determine Score Orientation (`isTeamAFirst`) Using Player Rosters + Team Name:**
   Create a helper to check whether `gm.teamA` corresponds to `live.teamAName` / `live.teamAPlayers`:
   ```ts
   function isMatchSameOrder(
     live: LiveMatch,
     teamA: { name: string; players?: string[] },
     teamB: { name: string; players?: string[] }
   ): boolean {
     const aName = teamA.name.trim().toLowerCase();
     const bName = teamB.name.trim().toLowerCase();
     const liveA = (live.teamAName || "").trim().toLowerCase();
     const liveB = (live.teamBName || "").trim().toLowerCase();
     if (liveA !== bName && liveA === aName && aName !== bName) return true;
     if (liveA === bName && liveB === aName && aName !== bName) return false;
     // If both teams share the same club/team name, disambiguate via player rosters:
     if (teamA.players?.length && live.teamAPlayers?.length) {
       const pA = [...teamA.players].map((p) => p.trim().toLowerCase()).sort().join(",");
       const lpA = [...live.teamAPlayers].map((p) => p.trim().toLowerCase()).sort().join(",");
       return pA === lpA;
     }
     return true;
   }
   ```
   Use `const sameOrder = live ? isMatchSameOrder(live, a, b) : true;` so `scoreA` and `scoreB` are never flipped or duplicated!

### Step 3.2: Include Player Rosters in `mergeMatchesSafely` Deduplication (Bug #11)

**Problem:** In `src/lib/match-store.ts` (lines 433–452), step 4 of `mergeMatchesSafely` deduplicates matches using:
```ts
const pair = [m.teamAName.trim().toLowerCase(), m.teamBName.trim().toLowerCase()].sort().join("::");
const pairKey = `${m.tournamentSlug || "event"}::${m.categoryId || "division"}::${bracket}::${pair}`;
```
Because it ignores `m.id` and `m.teamAPlayers` / `m.teamBPlayers`, if two pairs from the same club (e.g. `"Nanomoly (Carlo/Rico)"` and `"Nanomoly (Dante/Gio)"`) both play `"Dink Dynasty"` in the same bracket, `mergeMatchesSafely` treats them as duplicates and overwrites one match with the other's score!

**Required Edits (`src/lib/match-store.ts` lines ~433–452 & `src/lib/court-dispatch.ts` `autoHealDispatchAnomalies` lines ~1470–1485):**

1. In `mergeMatchesSafely` (and `autoHealDispatchAnomalies`), if `m.id.startsWith("match_")`, use `m.id` directly as part of the deduplication key, or include the sorted player rosters in `pair`:
   ```ts
   const pA = (m.teamAPlayers || []).map((p) => p.trim().toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean).sort().join(",");
   const pB = (m.teamBPlayers || []).map((p) => p.trim().toLowerCase().replace(/[^a-z0-9]/g, "")).filter(Boolean).sort().join(",");
   const nameA = pA ? `${m.teamAName.trim().toLowerCase()}[${pA}]` : m.teamAName.trim().toLowerCase();
   const nameB = pB ? `${m.teamBName.trim().toLowerCase()}[${pB}]` : m.teamBName.trim().toLowerCase();
   const pair = [nameA, nameB].sort().join("::");
   const pairKey = m.id.startsWith("match_")
     ? m.id
     : `${m.tournamentSlug || "event"}::${m.categoryId || "division"}::${bracket}::${pair}`;
   ```
   *(Notice `dbGetMatches` in `supabase-service.ts` line 480 already does this! Align `mergeMatchesSafely` and `autoHealDispatchAnomalies` to use the exact same key.)*

### Step 3.3: Unify `dispatchMatchToCourt` & `DrawsManager` on `createCategoryScopedMatchId` (Bug #12)

**Problem:**
* In `src/lib/court-dispatch.ts` (`dispatchMatchToCourt`, line 467), `broadcastDispatchAlert` at the end of the function sends `matchId: canonicalId` (`match-dink-valley-...`) instead of `matchId: targetId` (`match_...`), while the first `broadcastDispatchAlert` (line 403) sends `matchId: targetId` — broadcasting **two different IDs** for the same dispatch!
* In `src/components/admin/DrawsManager.tsx` (`initializeGroupsFromDrawn`, line 417), it still uses `createPairMatchId` instead of checking `createCategoryScopedMatchId(categoryId, dGrp.letter, teamA.id, teamB.id)` first.

**Required Edits (`src/lib/court-dispatch.ts` & `src/components/admin/DrawsManager.tsx`):**

1. In `src/lib/court-dispatch.ts` (`dispatchMatchToCourt`):
   * Remove the duplicate second `broadcastDispatchAlert` call at line 465 (which erroneously passes `matchId: canonicalId`), keeping only the single `broadcastDispatchAlert` with `matchId: targetId`.
2. In `src/components/admin/DrawsManager.tsx` (`initializeGroupsFromDrawn`, lines ~415–438):
   * Look up `const scopedId = (teamA.id && teamB.id) ? createCategoryScopedMatchId(categoryId, dGrp.letter, teamA.id, teamB.id) : null;` and check `liveMatches.find((m) => m.id === scopedId)` first before calling `findMatchForPair(...)`.

### Step 3.4: Scope `FindMatchesModal.tsx` by Category & Player Roster (Bug #13)

**Problem:** In `src/components/public/FindMatchesModal.tsx` (lines 48–67), tapping a team on the public page lists matches from all divisions and other club pairs that share the same `team.name`.

**Required Edits (`src/components/public/FindMatchesModal.tsx`):**

1. When filtering `matches` for `team`:
   * Require `if (m.categoryId && !isSameCategory(m.categoryId, category.id)) continue;`.
   * If `team.players && team.players.length > 0`, verify that the match's `teamAPlayers` (when `isTeamA`) or `teamBPlayers` (when `isTeamB`) matches `team.players` (when the match has player rosters recorded) so two `"Nanomoly"` pairs never see each other's matches.

---

## Phase 4: Fix the Court Dispatch Handshake to Umpire Console

### Step 4.1: Stop `umpire.tsx` from Filtering Out Scoped Match IDs (Bug #3)

**Problem:** Line 117 of `src/routes/umpire.tsx` runs `return m.id.includes(activeTournamentSlug);`. Because `createCategoryScopedMatchId` produces `match_${cleanCat}_${cleanLetter}_${firstId}_vs_${secondId}` (which does not contain `activeTournamentSlug`), matches missing `m.tournamentSlug` are hidden from the Umpire Console.

**Required Edits (`src/routes/umpire.tsx` lines ~110–118):**
Update the final fallback in `activeEventMatches`:
```ts
// 4. Default to tournament slug or active category match
if (!activeTournamentSlug) return true;
if (m.tournamentSlug) {
  return m.tournamentSlug === activeTournamentSlug;
}
if (m.categoryId && activeTournament?.categories?.some((c: any) => c.id === m.categoryId || (c as any).category_slug === m.categoryId)) {
  return true;
}
if (m.id.startsWith("match_")) {
  return true;
}
return m.id.includes(activeTournamentSlug);
```

### Step 4.2: Make `dispatchMatchToCourt` Atomic & Fix Blank Team Names (Bug #5)

**Required Edits (`src/lib/court-dispatch.ts` & `src/components/admin/DispatchDebugStation.tsx`):**

1. **In `dispatchMatchToCourt` (`src/lib/court-dispatch.ts`):**
   * Preserve the exact `createCategoryScopedMatchId` (`match.id`) without overwriting it.
   * Ensure `teamAName` and `teamBName` are non-empty strings.
   * Demote any existing non-final match in `matches` that currently has `m.court === targetCourt && m.id !== targetId` back to `court: "Queue"`.
   * Save the updated `matches` array locally (`saveMatches`) AND await `dbSaveMatch(dispatchedRecord)` to Supabase **before** calling `pushStationsToCloud()`.
2. **In `src/components/admin/DispatchDebugStation.tsx`:**
   * Ensure the matchup title on each court card renders `item.match.teamAName` vs `item.match.teamBName` with visible light text (`text-sand`).

---

## Phase 5: Perfect the 2D Court Server & Receiver Rotation

### Step 5.1: Fix `0-0-2` Coin Toss Start & 2nd-Server Rotation (Bugs #6 & #7)

**Problem:**
1. At `0 - 0 - 2` right after the coin toss, fallback logic sees `serverNumber === 2` and mistakenly assigns the serve to `Base 2` (Left player) instead of `Base 1` (Right player).
2. When a match is hydrated from Supabase (`dbGetMatches` in `src/lib/supabase-service.ts` lines 435–441), `score.activeServerBase` is `undefined` (because `public.matches` has no `active_server_base` column), so `deriveActiveServerBase` must deterministically replay `score.rallies` from `0-0-2` (`curServerNumber = 2`, `curActiveBase = 1`).
3. Look at line 612 of `src/lib/match-store.ts` inside `deriveActiveServerBase`:
   `const isGameStart = teamAScore === 0 && teamBScore === 0 && curServingTeam === "A" && curServerNumber === 1;`
   And if Team B won the coin toss and served first (`0-0-2`), `curServingTeam` started as `"B"`, not `"A"`! Hardcoding `let curServingTeam: ServingTeam = "A";` at line 603 of `match-store.ts` causes `deriveActiveServerBase` to replay the entire game with the **wrong serving team** whenever Team B won the coin toss!

**Required Edits (`src/lib/match-store.ts` & `src/routes/umpire.tsx`):**

1. **Replace `deriveActiveServerBase(score: LiveScore)` in `src/lib/match-store.ts` (lines 599–636) with this exact implementation:**
   ```ts
   export function deriveActiveServerBase(score: LiveScore): 1 | 2 {
     const rallies = score.rallies || [];
     const hasSideOut = rallies.some((r) => r.type === "side_out" || (r as any).type === "sideout" || r.type === "fault");

     // 1. Hard guard for opening serve of the game (0-0-2 before any side-out):
     // The Right-court player (Base 1) ALWAYS serves first at 0-0-2, regardless of whether Team A or Team B won the toss!
     if (score.teamAScore === 0 && score.teamBScore === 0 && score.serverNumber === 2 && !hasSideOut) {
       return 1;
     }

     // 2. If explicit activeServerBase is set on score in memory, use it:
     if (score.activeServerBase === 1 || score.activeServerBase === 2) {
       return score.activeServerBase;
     }

     // 3. If no rallies yet at 0-0, Right court (Base 1) always serves:
     if (rallies.length === 0) {
       return 1;
     }

     // 4. Deterministically replay rallies from game start (0-0-2, activeBase = 1):
     // Infer who served first from the first rally event:
     const firstRally = rallies[0]!;
     let curServingTeam: ServingTeam =
       firstRally.type === "point"
         ? firstRally.servingTeam
         : firstRally.scoreSnapshot?.[2] === 1
         ? (firstRally.servingTeam === "A" ? "B" : "A") // Side-out on opening 0-0-2 switched to the other team at server #1
         : firstRally.servingTeam;

     let curServerNumber: 1 | 2 = 2;
     let curActiveBase: 1 | 2 = 1;
     let teamAScore = 0;
     let teamBScore = 0;

     for (const rally of rallies) {
       if (rally.type === "point") {
         curServingTeam = rally.servingTeam;
         if (curServingTeam === "A") teamAScore++;
         else teamBScore++;
         // Server swaps sides and keeps serving -> curActiveBase does NOT change!
       } else if (rally.type === "side_out" || (rally as any).type === "sideout" || rally.type === "fault") {
         const nextServerNum = (rally.scoreSnapshot?.[2] as 1 | 2 | undefined) ?? (curServerNumber === 2 ? 1 : 2);
         if (rally.servingTeam === curServingTeam && nextServerNum === 2) {
           // 1st server -> 2nd server on the same team: flip to partner on opposite court!
           curServerNumber = 2;
           curActiveBase = curActiveBase === 1 ? 2 : 1;
         } else {
           // Side-out to the opposing team (Server #1):
           curServingTeam = rally.servingTeam;
           curServerNumber = 1;
           const newTeamScore = curServingTeam === "A" ? teamAScore : teamBScore;
           // Whoever is currently standing on the Right court for the new serving team is Server #1:
           curActiveBase = newTeamScore % 2 === 0 ? 1 : 2;
         }
       }
     }

     return curActiveBase;
   }
   ```
2. **In `sideOut(match)` in `src/lib/match-store.ts` (line 676):**
   * Remove `&& s.servingTeam === "A"` from `isGameStart` so that if Team B won the coin toss and somehow started at `0-0-1`, it is treated identically to Team A.

### Step 5.2: Sync Public `MiniCourtVisualizer` with Umpire Console

**Required Edits (`src/components/public/MiniCourtVisualizer.tsx`, `src/routes/tournaments.$slug.tsx`, `src/components/public/LiveCourtsBoard.tsx`):**

1. Pass `teamAPlayers`, `teamBPlayers`, `teamABase1Player`, and `teamBBase1Player` from `liveMatch` into `<MiniCourtVisualizer />` in `src/routes/tournaments.$slug.tsx` and `src/components/public/LiveCourtsBoard.tsx`.
2. Ensure `MiniCourtVisualizer.tsx` uses the updated `deriveActiveServerBase(score)` so public court positions match the Umpire Console 1:1.

---

## 6. Post-Implementation Verification Checklist

* [x] **Test 1 (Empty Category):** Create a new division with 0 drawn matches -> Open Direct Court Dispatch -> Verify all bracket tabs say `EMPTY` (not `DONE`).
* [x] **Test 2 (Delete Matches Safety):** Draw brackets for a division -> Click "Delete Matches" -> Verify `Bracket A..D` and all player names remain intact.
* [x] **Test 3 (Dispatch & `0-0-2` Sync):** Dispatch a match to Court 1 -> Open `Score Sync Debug` -> Verify both Admin and Umpire/Cloud show `0 - 0 (Tm A #2 • 0r)` with green `IN SYNC` badge and visible team names.
* [x] **Test 4 (Coin Toss with Team B Serving First):** On Umpire Console, complete Coin Toss and choose **Team B** to serve first -> Verify Team B's Right-court player (`B1`) serves at `0-0-2` -> Score points and trigger 2nd server -> Verify serve switches to partner (`B2`).
* [x] **Test 5 (Public Standings & Same-Club Teams):** Populate a bracket containing two teams with the same club name (e.g. two `"Nanomoly"` pairs with different players) -> Complete a match -> Verify both pairs appear as separate rows in Public Standings with accurate individual W-L and `+/-` Point Diff.