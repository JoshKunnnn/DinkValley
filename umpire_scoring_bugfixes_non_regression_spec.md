# Technical Specification: Umpire Scoring & Championship 15+ Point Bugfixes (Zero-Regression Patch)

## 1. Executive Summary
This specification documents **7 confirmed bugs** across `src/components/admin/DrawsManager.tsx`, `src/lib/match-store.ts`, and `src/routes/umpire.tsx`—most notably **Bug 1 (The Championship / 15+ Point Premature Winner Bug)**, where a hardcoded `>= 11` threshold in `DrawsManager.tsx` prematurely crowns a winner and advances the bracket while a 15-point Championship or Playoffs game is still being playedLIVE on court.

All fixes are designed as **surgical, backward-compatible patches** that preserve 100% of existing features (Court Dispatch, Public Arena Monitor `/monitor`, Tournament Page live boards, Coin Toss, and Supabase Realtime sync).

---

## 2. What Happens in a Championship Game Right Now (Root Cause of the 15-Point Bug)

### Bug 1: Hardcoded `scoreA >= 11` in `DrawsManager.tsx` Prematurely Ends 15-Point Championship Matches!
* **Exact Location:** `src/components/admin/DrawsManager.tsx` (`syncMainDrawWithLiveMatches`, lines 318–325) and `src/routes/CourtDispatch.tsx` (lines 410–412)
* **The Exact Code Running Right Now:**
  In `DrawsManager.tsx`, `syncMainDrawWithLiveMatches` runs automatically on **every single point** via a `useEffect` in `CourtDispatch.tsx` (`useEffect(() => { ... syncMainDrawWithLiveMatches(...) }, [matches])`) and `tournaments.$slug.tsx`:
  ```ts
  // ❌ CURRENT BUGGY CODE IN DrawsManager.tsx (Lines 318-325):
  const isFinished =
    live.status === "final" ||
    Boolean(live.winnerTeam) ||
    (scoreA !== undefined &&
      scoreB !== undefined &&
      (scoreA >= 11 || scoreB >= 11) &&
      Math.abs(scoreA - scoreB) >= 2);
  ```
* **What Happens During a 15-Point Championship (or 15-Point Knockout) Game:**
  1. Your tournament rules state: *"Games to 11, win by 2. Playoff finals to 15."*
  2. In `UmpireConsole` (`umpire.tsx`), the umpire keeps scoring points past 11 because `scorePoint()` in `match-store.ts` does not stop at 11.
  3. **However**, the exact moment either team reaches **11 points with a 2-point lead** (e.g., `11 - 8` or `11 - 9`) while the match is still `status === "live"`, `syncMainDrawWithLiveMatches` evaluates `(scoreA >= 11 || scoreB >= 11) && Math.abs(scoreA - scoreB) >= 2` as **`true`**!
  4. Even though the umpire has **not** clicked "End Match" and the players are playing to 15:
     * `syncMainDrawWithLiveMatches` sets `nextKm.winner = winningTeam` and saves the Main Draw to Supabase.
     * It immediately calls `syncKnockoutToLiveMatches(tournamentSlug, categoryId, advanced)`.
     * Inside `syncKnockoutToLiveMatches` (line 425 of `DrawsManager.tsx`), because `km.winner` is now truthy:
       ```ts
       const nextStatus: LiveMatch["status"] = km.winner ? "final" : ...
       ```
       **It forcefully overwrites the live match in `dv_live_matches` and Supabase to `status: "final"` and sets `winnerTeam` right in the middle of the game at 11 points!**
  5. **The Cascade:**
     * On the Umpire's tablet (`umpire.tsx`), the match suddenly flips to **"Match Concluded (Final)"**, disabling the **"Point Scored"** and **"Side Out"** buttons!
     * On the Public Arena TV (`monitor.tsx`), the full-screen **Winner Celebration Banner** blasts onto the TV at 11 points!
     * If the umpire or admin tries to keep scoring past 11 up to 15+, every single point scored where the lead is $\ge 2$ (`12-9`, `13-9`, `14-10`, `15-13`, `16-14`) triggers `syncMainDrawWithLiveMatches` again and **re-locks the match as `"final"` after every single rally**!
* **The Non-Breaking Fix:**
  1. **Never auto-mark a live match as finished in `syncMainDrawWithLiveMatches` while `live.status === "live"`!** A match should ONLY be marked `isFinished` in `syncMainDrawWithLiveMatches` when the umpire or admin explicitly finalizes it (`live.status === "final" || Boolean(live.winnerTeam) || Boolean(live.endedAt)`).
  2. Add a target-score helper `getEffectiveTargetScore(match)` (`15` for Finals/Championship, `11` for standard matches, or configurable `11 / 15 / 21`) so the Umpire Console can show a helpful **"Match Point / Target Reached"** indicator without forcefully terminating the match behind the umpire's back.

---

## 3. Additional Umpire Scoring Bugs & Surgical Fixes

### Bug 2: `undoLastRally` Misidentifies Initial Server After Manual Server Swaps
* **Location:** `src/lib/match-store.ts` (`undoLastRally`, lines ~894–901) & `deriveActiveServerBase` (lines ~559–565)
* **Root Cause:**
  `undoLastRally` replays all rallies from scratch starting from a hardcoded `serverNumber: 2, activeServerBase: 1`. If the umpire tapped **"Swap Server #"** during the game, or if the first rally was a fault after a manual adjustment, replaying from scratch corrupts `servingTeam`, `serverNumber`, and the 2D court player positions.
* **Non-Breaking Fix:**
  Save `beforeServingTeam`, `beforeServerNumber`, `beforeActiveServerBase`, `beforeTeamAScore`, and `beforeTeamBScore` on each `RallyEvent` in `scorePoint` and `sideOut`. When `undoLastRally` is called, restore those exact fields from the popped rally directly (falling back to the replay loop only for older rallies without `before*` fields).

---

### Bug 3: `handleSwapServerNumber` Gets Overwritten by Cloud Polling After 5 Seconds
* **Location:** `src/routes/umpire.tsx` (`handleSwapServerNumber`, lines ~1484–1497) & `src/lib/match-store.ts` (`mergeMatchesSafely`, lines ~350–380)
* **Root Cause:**
  Tapping **"Swap Server #"** changes `serverNumber` and `activeServerBase`, but does not change `teamAScore + teamBScore` or `rallies.length`. In `mergeMatchesSafely`, when scores and rally counts are equal, `chosenScore` defaults to `cm.score` (cloud), reverting the umpire's server swap if a cloud poll arrives after the 5s window.
* **Non-Breaking Fix:**
  Set `courtPositionUpdatedAt: Date.now()` inside `handleSwapServerNumber` and `handleSwapServingTeam`, and in `mergeMatchesSafely`, prefer `lm.score` when `localScoreTotal === cloudScoreTotal && localRallies === cloudRallies && (lm.courtPositionUpdatedAt ?? 0) > (cm.courtPositionUpdatedAt ?? 0)`.

---

### Bug 4: Global 5-Second Cloud Sync Blind Spot (`safeRefreshFromCloud`)
* **Location:** `src/routes/umpire.tsx` (lines ~269–275)
* **Root Cause:**
  `safeRefreshFromCloud` blocks `refreshFromCloud()` for 5 seconds across the entire Umpire app whenever a point is scored. Because `mergeMatchesSafely` in `match-store.ts` already guards in-flight local mutations per match (`getLocalMatchMutationAt(lm.id) < 5000`), blocking `refreshFromCloud()` globally is redundant and delays court dispatch updates on other courts.
* **Non-Breaking Fix:**
  Call `refreshFromCloud()` directly inside `safeRefreshFromCloud()`.

---

### Bug 5: Auto-Switch Hijacks the Umpire Screen Immediately Upon Final Point
* **Location:** `src/routes/umpire.tsx` (lines ~383–392)
* **Root Cause:**
  When `selectedMatch.status === "final"`, the `useEffect` checks `if (st.currentMatchId !== selectedMatch.id)` and immediately switches `selectedMatchId` to `st.currentMatchId`. If `st.currentMatchId` is an alias ID of the same match, or if the umpire wants to review the final score, it yanks the screen away.
* **Non-Breaking Fix:**
  Add `!isMatchMatchingStation(selectedMatch, st.currentMatchId, court)` to the condition so it never switches to an alias ID of the same match.

---

### Bug 6: Global `onClickCapture` iOS Hidden Switch Steals Focus & Drops Rapid Taps
* **Location:** `src/routes/umpire.tsx` (lines ~401 and ~1579)
* **Root Cause:**
  `onClickCapture={() => triggerUmpireHaptic(35)}` is attached to two nested wrapper `<div>` elements in `Umpire` and `UmpireConsole`. On iOS Safari, clicking the hidden `<label id="dv-ios-haptic-label">` during the **capture phase** before the target `<button>` or `<select>` receives the tap can drop rapid "Point Scored" taps or close `<select>` dropdowns.
* **Non-Breaking Fix:**
  Remove `onClickCapture` from the two outer wrapper `<div>`s while keeping all explicit `triggerUmpireHaptic(...)` calls inside the button click handlers (`handlePoint`, `handleSideOut`, `handleUndo`, etc.).

---

### Bug 7: Match ID Overwrite on Remote Dispatch (`handleRemoteDispatch`)
* **Location:** `src/routes/umpire.tsx` (lines ~299–312)
* **Root Cause:**
  When `dv_remote_match_dispatched` fires, `localMatches[existingIdx]` has its `id` updated to `detail.match.id || detail.matchId`. If the umpire already had that match open under its previous ID, `selectedMatchId` becomes orphaned.
* **Non-Breaking Fix:**
  If `selectedMatchIdRef.current === prevId && prevId !== nextId`, call `setSelectedMatchId(nextId)` so the umpire stays on the match seamlessly.

---

## 4. Copy-Paste AI Prompt (Fixes All 7 Bugs Without Breaking Existing Features)

Copy and paste the prompt below into your AI coding assistant (Cursor, Windsurf, or Lovable):

```markdown
Apply a surgical, non-breaking bugfix patch to `src/components/admin/DrawsManager.tsx`, `src/lib/match-store.ts`, and `src/routes/umpire.tsx` to fix the Championship 15+ point premature auto-finalization bug and umpire scoring synchronization issues. Do NOT remove any existing UI components, modals, or court dispatch features.

### 1. Fix the Championship / 15-Point Premature Auto-Final Bug in `src/components/admin/DrawsManager.tsx`
- In `syncMainDrawWithLiveMatches` (around lines 318–325), REMOVE the hardcoded `(scoreA >= 11 || scoreB >= 11) && Math.abs(scoreA - scoreB) >= 2` check from `isFinished`:
  ```ts
  // ✅ Replace with strict finalization check:
  const isFinished =
    live.status === "final" ||
    Boolean(live.winnerTeam) ||
    Boolean(live.endedAt);
  ```
  Why: Previously, as soon as a 15-point Championship (or deuce) match reached 11-9 while still `status === "live"`, `syncMainDrawWithLiveMatches` treated it as finished, set `km.winner`, and called `syncKnockoutToLiveMatches`, which forcefully overwrote the live match's status to `"final"` in the middle of the game! A match must only be marked finished when the umpire or admin explicitly finalizes it (`status === "final"`).

### 2. Add Target Score Support (`11` vs `15` Championship) & Exact Undo in `src/lib/match-store.ts`
- Add optional `targetScore?: number | undefined;` to `LiveMatch`.
- Export a helper `getEffectiveTargetScore(match: LiveMatch): number`:
  - If `match.targetScore && match.targetScore > 0`, return `match.targetScore`.
  - If `match.stage` (case-insensitive) contains `"final"` (and NOT `"semifinal"` or `"quarterfinal"`), `"championship"`, `"gold"`, `"bronze"`, or `"3rd place"`, return `15`.
  - Otherwise return `11`.
- In `RallyEvent`, add optional snapshot fields:
  ```ts
  beforeServingTeam?: ServingTeam | undefined;
  beforeServerNumber?: 1 | 2 | undefined;
  beforeActiveServerBase?: 1 | 2 | undefined;
  beforeTeamAScore?: number | undefined;
  beforeTeamBScore?: number | undefined;
  ```
- In `scorePoint(match: LiveMatch)` and `sideOut(match: LiveMatch)`:
  - Save `beforeServingTeam: match.score.servingTeam`, `beforeServerNumber: match.score.serverNumber`, `beforeActiveServerBase: match.score.activeServerBase ?? deriveActiveServerBase(match.score)`, `beforeTeamAScore: match.score.teamAScore`, and `beforeTeamBScore: match.score.teamBScore` onto the new `RallyEvent`.
  - Also set `courtPositionUpdatedAt: Date.now()` on the returned `LiveMatch`.
- In `undoLastRally(match: LiveMatch)`:
  - Grab `const lastRally = s.rallies[s.rallies.length - 1];`.
  - If `lastRally` has `beforeServingTeam !== undefined && beforeServerNumber !== undefined`, restore `teamAScore: lastRally.beforeTeamAScore ?? s.teamAScore`, `teamBScore: lastRally.beforeTeamBScore ?? s.teamBScore`, `servingTeam: lastRally.beforeServingTeam`, `serverNumber: lastRally.beforeServerNumber`, `activeServerBase: lastRally.beforeActiveServerBase ?? 1`, and `rallies: prevRallies` directly, with `status: prevRallies.length > 0 || (match.court && match.court !== "Queue") ? "live" : "scheduled"`, `winnerTeam: undefined`, `endedAt: undefined`, and `courtPositionUpdatedAt: Date.now()`. Keep the existing replay loop as a fallback for legacy rallies.
- In `mergeMatchesSafely`:
  - When `localScoreTotal === cloudScoreTotal` and `localRallies === cloudRallies`, if `(lm.courtPositionUpdatedAt ?? 0) > (cm.courtPositionUpdatedAt ?? 0)`, set `chosenScore = lm.score` so manual `Swap Server #` or `Undo` actions on the umpire tablet are never overwritten by stale cloud polls.

### 3. Fix Sync, Focus & Championship Indicator in `src/routes/umpire.tsx`
- **Remove Global 5s Cloud Poll Block:** In `safeRefreshFromCloud`, call `refreshFromCloud()` directly without returning early on `Date.now() - getLocalMatchMutationAt(activeId) < 5000`.
- **Prevent ID Orphan on Remote Dispatch:** In `handleRemoteDispatch`, when updating `localMatches[existingIdx]`, if `selectedMatchIdRef.current === localMatches[existingIdx].id`, update `setSelectedMatchId(detail.match.id || detail.matchId)` so the umpire's open scoring console stays connected.
- **Guard Auto-Switch Effect:** In the `useEffect` that auto-switches `selectedMatchId` when a court receives a newly dispatched match, add `!isMatchMatchingStation(selectedMatch, st.currentMatchId, court)` to the condition.
- **Preserve `Swap Server #` Timestamp:** In `handleSwapServerNumber` and `handleSwapServingTeam`, include `courtPositionUpdatedAt: Date.now()` on the updated match object.
- **Fix Stale Closure in `handleDeskTakeover` & `handleDeskRemoveUmpire`:** Read the latest match from `getMatches().find((x) => x.id === m.id) ?? m` before calling `dbSaveMatch`.
- **Fix iOS Capture-Phase Double-Tap Issue:** Remove `onClickCapture={() => triggerUmpireHaptic(35)}` from the two wrapper `<div>` elements in `Umpire` and `UmpireConsole`, keeping all explicit `triggerUmpireHaptic(...)` calls inside the button handlers.
- **Add Non-Blocking Game Point / Target Score Indicator:** In `UmpireConsole`, import `getEffectiveTargetScore` from `@/lib/match-store`. Display a subtle badge showing `Game to ${getEffectiveTargetScore(match)} (Win by 2)` in the score bar, and when `(s.teamAScore >= target || s.teamBScore >= target) && Math.abs(s.teamAScore - s.teamBScore) >= 2`, highlight the `"End Match"` button with a pulsing border so the umpire knows target score is reached while still allowing points to be scored past 15 if play continues.
```