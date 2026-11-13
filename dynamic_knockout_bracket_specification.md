# Feature Specification: Dynamic Challonge-Style Knockout Bracket

## 1. Overview & Objective
Upgrade the Dink Valley tournament knockout bracket engine (`DrawsManager.tsx`, `KnockoutBracketListView.tsx`, and `KnockoutTreeVisualizer.tsx`) so that **any number of round-robin pools or advancing teams** ($N \ge 2$, including irregular pool counts such as 5, 6, 10, or 13 pools up to **Bracket M** with 26 qualifiers) dynamically generates and renders a self-aligning, single-elimination tournament tree modeled after Challonge's dark-mode bracket layout.

---

## 2. Core Capabilities
1. **Universal $N$-Team Power-of-2 Seeding Engine:**
   - Supports any qualifier count $N \ge 2$ (e.g., 3, 4, 6, 8, 10, 13, 16, 24, 26, or 32 teams).
   - Automatically pads $N$ to the next power of 2 ($P = 2^{\lceil \log_2(N) \rceil}$) across $R = \log_2(P)$ rounds.
   - Uses standard recursive tournament fold seeding (`[1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11]` for $P=16$, and 32-slot folding for $17 \le N \le 32$) so top seeds never meet until the final rounds.
   - Automatically assigns Round 1 **BYEs** to the top $P - N$ overall seeds and immediately advances them into Round 2.
2. **Cross-Pool Rematch Prevention:**
   - Checks Round 1 playable pairings and swaps adjacent bottom-seed slots if two qualifiers from the exact same round-robin pool (`bracketLetter`) are paired against each other in Round 1.
3. **Self-Aligning Challonge Visual Tree (`KnockoutTreeVisualizer.tsx`):**
   - Replaces hardcoded 4/8/10-team SVG grid layouts with a dynamic flexbox column architecture (`justify-around` per round column).
   - Automatically aligns every match card dead-center between its two feeder matches from the previous round, regardless of whether the bracket has 2, 3, 4, or 5 rounds (up to 32 slots).
   - Draws crisp CSS elbow connectors (`┐` / `┘` and incoming horizontal stems) between feeder pairs and next-round matches.
   - Hides Round 1 `"BYE"` match nodes while preserving their vertical flex slot height so bracket geometry stays symmetrical.
4. **Challonge Dark-Theme Match Card UI:**
   - Sequential match number indicator to the left of each card.
   - Compact two-row match card (`#4a4a4a` surface on a `#262626` canvas) with:
     - Left seed badge (`#595959` with seed number).
     - Truncated team/player display name (`getMatchTeamDisplay`) and pulsing live serving dot (`bg-pickle`).
     - Right score box (`#595959` default, `#e86c1f` orange highlight for the winning team).

---

## 3. Codebase Integration Map

| File Path | Role in Current Codebase | Required Changes |
| :--- | :--- | :--- |
| `src/components/admin/DrawsManager.tsx` | Generates `KnockoutMatch[]` via `handleGenerateMainDraw`, persists via `saveMainDrawMatches`, and syncs live scores via `syncMainDrawWithLiveMatches`. | Remove the `Math.min(qualifiers.length, 16)` cap. Add `Round of 32` to `KnockoutMatch["round"]`. Replace hardcoded $N=16 / 8 / 4$ branches with a unified fold-seeding + `feedWinnerTo` generator that supports up to 32 qualifiers (e.g., 13 pools $\times$ Top 2 = 26 teams). |
| `src/components/public/KnockoutBracketListView.tsx` | Computes live pool standings and builds projected `KnockoutCardItem[]` when the Admin hasn't locked the Main Draw yet; toggles between `"cards"` and `"tree"` views. | Update projected bracket builder to use the same dynamic $N$-team fold generator so any pool count (A–M) previews accurately before pool play finishes. |
| `src/components/public/KnockoutTreeVisualizer.tsx` | Renders the visual tree when `viewMode === "tree"` is selected in `KnockoutBracketListView.tsx`. | Replace fixed `TenTeamBracketTree` / `EightTeamBracketTree` / `FourTeamBracketTree` grids with the universal Challonge flexbox + elbow-connector renderer that scales to any round depth. |
| `src/routes/tournaments.$slug.tsx` | Public tournament page rendering `<KnockoutBracketListView />` in Easy View and Detailed Grid. | Optionally default `viewMode` to `"tree"` on desktop or expose the Tree/Cards toggle prominently. |

---

## 4. Non-Regression & Backward-Compatibility Guardrails

To ensure **zero breakage** across Court Dispatch, Umpire Scoring, Arena TV Monitor, and Supabase cloud sync, enforce these 5 rules:

### Rule 1: Preserve Stage Naming Contract
`match-store.ts`, `court-dispatch.ts`, and `tournaments.$slug.tsx` distinguish knockout matches from pool play matches by checking:
```ts
!m.stage?.includes("Pool Play") && !m.stage?.includes("Bracket ")
```
And match lookups format the stage as:
```ts
const stage = `${km.round} - ${km.label}`;
```
- **Guardrail:** Keep `km.round` values strictly within `"Round of 32" | "Round of 16" | "Quarterfinal" | "Semifinal" | "Final" | "Bronze"`. Never put `"Pool Play"` or `"Bracket "` inside a knockout match's `round` or `label`.

### Rule 2: Auto-Resolve BYEs Off-Court
In `DrawsManager.tsx`, `syncKnockoutToLiveMatches` only creates `LiveMatch` records when `km.teamA && km.teamB` are both present.
- **Guardrail:** When a top seed receives a Round 1 BYE, do **not** create a playable Round 1 match with a dummy `"BYE"` `Team` object in `mainDrawMatches`, or else `syncKnockoutToLiveMatches` and `computeCategoryUnassignedMatches` will push `"Team A vs BYE"` to the Umpire Console and Court Dispatch queue.
- Instead, pre-populate the bye team directly into their Round 2 match slot (`teamA` or `teamB`) with `seedA: "#1 (A1, +18 diff - BYE)"`, and only emit playable `KnockoutMatch` objects into `mainDrawMatches` (while the UI tree renders visual spacer slots for the Round 1 byes).

### Rule 3: Preserve `feedWinnerTo` and `feedLoserTo` Links
`advancePlayoffBracket(matches)` in `DrawsManager.tsx` already supports dynamic cascading across rounds whenever `feedWinnerTo: { matchId, slot }` and `feedLoserTo: { matchId, slot }` are defined on `KnockoutMatch`!
- **Guardrail:** Increase the cascade loop limit in `advancePlayoffBracket` from `while (passChanged && passes < 4)` to `passes < 6` so 5-round brackets (`Round of 32` $\rightarrow$ `Round of 16` $\rightarrow$ `Quarterfinal` $\rightarrow$ `Semifinal` $\rightarrow$ `Final`) cascade completely in a single pass.

### Rule 4: Extend `KnockoutMatch` Non-Destructively
- **Guardrail:** Only add optional properties (`matchNumber?: number`, `slotIndex?: number`, `roundIndex?: number`, `isByePlaceholder?: boolean`) to `KnockoutMatch` so existing tournaments saved in `localStorage` or Supabase `tournaments.rules.mainDraw` continue to load without migration errors.

### Rule 5: Keep `match-store.ts` Recognized Knockout Tokens Updated
In `src/lib/match-store.ts`, `getKnockoutRoundType(stage)` checks for round keywords (`r16`, `qf`, `sf`, `bronze`, `final`).
- **Guardrail:** Add `"r32"` support (`s.includes("round of 32") || /\br32\b/.test(s)`) in `getKnockoutRoundType` so 26-team (Pool A–M) Round of 32 matches are recognized as distinct knockout rounds during deduplication and live-match pairing.

---

## 5. Dynamic Fold-Seeding & Tree Layout Reference Implementation

### A. Recursive Fold Seeding Helper
```ts
/**
 * Generates standard tournament bracket seed order for any power-of-2 size P.
 * P = 4  -> [1, 4, 2, 3]
 * P = 8  -> [1, 8, 4, 5, 2, 7, 3, 6]
 * P = 16 -> [1, 16, 8, 9, 4, 13, 5, 12, 2, 15, 7, 10, 3, 14, 6, 11]
 * P = 32 -> [1, 32, 16, 17, 8, 25, 9, 24, 4, 29, 13, 20, 5, 28, 12, 21, ...]
 */
export function generateTournamentSeedOrder(bracketSize: number): number[] {
  let seeds = [1, 2];
  while (seeds.length < bracketSize) {
    const nextSum = seeds.length * 2 + 1;
    const expanded: number[] = [];
    for (const s of seeds) {
      expanded.push(s, nextSum - s);
    }
    seeds = expanded;
  }
  return seeds;
}
```

### B. Mapping Round Depth to Round Names
```ts
export type KnockoutRoundName =
  | "Round of 32"
  | "Round of 16"
  | "Quarterfinal"
  | "Semifinal"
  | "Final"
  | "Bronze";

export function getRoundNameForSize(slotCountInRound: number): KnockoutRoundName {
  if (slotCountInRound >= 32) return "Round of 32";
  if (slotCountInRound === 16) return "Round of 16";
  if (slotCountInRound === 8) return "Quarterfinal";
  if (slotCountInRound === 4) return "Semifinal";
  return "Final";
}

export function getDisplayRoundHeader(
  roundName: KnockoutRoundName,
  roundIndex: number,
  totalMainRounds: number
): string {
  const fromEnd = totalMainRounds - 1 - roundIndex;
  if (fromEnd === 0) return "Finals";
  if (fromEnd === 1) return "Semifinals";
  if (totalMainRounds >= 4 && roundIndex === 0) return "Round 1";
  if (totalMainRounds >= 4 && roundIndex === 1) return "Round 2";
  if (roundName === "Quarterfinal") return "Round 2";
  return `Round ${roundIndex + 1}`;
}
```

### C. Challonge Tree Node & Connector Geometry (`KnockoutTreeVisualizer.tsx`)
To achieve the exact Challonge look from the reference screenshot:
- **Canvas:** `bg-[#262626]` with subtle diagonal texture or `court-lines`, horizontal scroll container (`overflow-x-auto`).
- **Round Header Bar:** `bg-[#333333] text-gray-200 text-xs font-semibold py-1.5 text-center w-64 shrink-0`.
- **Full-Grid Tree Construction:**
  Even when Round 1 only has a few playable play-in matches (e.g., 10 teams $\rightarrow$ $P=16$ has 2 playable Round 1 matches and 6 BYEs; 26 teams $\rightarrow$ $P=32$ has 10 playable Round 1 matches and 6 BYEs), the visual tree renders **all $P / 2^r$ binary slots** per column:
  - Playable slots render the Challonge match card (`#4a4a4a`) + outgoing elbow connector.
  - Bye slots in Round 1 render an `invisible` spacer of the exact same flex height (`flex-1`) so that the active play-in matches align directly alongside the Round 2 match they feed into.
- **Score Box Highlight:**
  - Winning slot score box: `bg-[#e86c1f] text-white font-bold` (Challonge signature orange).
  - Losing / pending slot score box: `bg-[#595959] text-gray-200`.

---

## 6. Copy-Paste AI Implementation Prompt

Use the prompt below in Cursor, Windsurf, or Claude to apply this feature cleanly to your repository:

```markdown
Implement a dynamic Challonge-style single-elimination knockout bracket across `src/components/admin/DrawsManager.tsx`, `src/components/public/KnockoutBracketListView.tsx`, `src/components/public/KnockoutTreeVisualizer.tsx`, and `src/lib/match-store.ts` that automatically scales to any number of pools/qualifiers (including 13 pools A–M with 13 or 26 qualifiers, up to 32 teams) without breaking any existing live scoring, court dispatch, or Supabase sync features.

### 1. Update `src/lib/match-store.ts`
- In `getKnockoutRoundType(stage: string)`, add `"r32"` to the return union type and check `if (s.includes("round of 32") || /\br32\b/.test(s)) return "r32";` before the `r16` check.
- In `isMatchMatchingStation`, update `stationKoNum` regex from `/-(?:r16|qf|sf)-(\d+)$/i` to `/-(?:r32|r16|qf|sf)-(\d+)$/i`.

### 2. Upgrade `src/components/admin/DrawsManager.tsx`
- Add `"Round of 32"` to `KnockoutMatch["round"]`.
- Add optional fields to `KnockoutMatch`: `slotIndex?: number; matchNumber?: number;`.
- In `advancePlayoffBracket`, increase `while (passChanged && passes < 4)` to `passes < 6` so 5-round brackets cascade completely.
- In `handleGenerateMainDraw` and `handleCreateCustomMainDraw`:
  - Remove the `Math.min(qualifiers.length, 16)` cap and support up to 32 qualifiers ($2 \le N \le 32$).
  - Create a helper `generateTournamentSeedOrder(bracketSize: number): number[]` using standard recursive fold seeding (`[1, 2]` -> `[1, 4, 2, 3]` -> `[1, 8, 4, 5, 2, 7, 3, 6]` -> 16 -> 32).
  - For any $N \ge 4$, compute `bracketSize = Math.pow(2, Math.ceil(Math.log2(N)))`.
  - Build the bracket tree dynamically across all rounds from `bracketSize` down to `Final` (plus `Bronze` 3rd-place match fed by Semifinal losers via `feedLoserTo`).
  - Whenever a Round 1 pairing has `botSeed > N` (a BYE), do NOT emit a playable Round 1 match with a dummy BYE team; instead, pre-populate the top seed directly into the target Round 2 match slot (`teamA` or `teamB`) with `seedA`/`seedB` marked `(#seed, BYE)` so `syncKnockoutToLiveMatches` never dispatches a BYE match to Courts 1–4.
  - Perform same-pool rematch prevention on playable Round 1 matches by swapping `bot` seeds if `qTop.bracketLetter === qBot.bracketLetter`.
  - Assign sequential `matchNumber` (1, 2, 3...) and 0-indexed binary `slotIndex` (`0` to `(bracketSize / 2^round) - 1`) to every match so the visual tree knows its exact binary position.

### 3. Upgrade `src/components/public/KnockoutBracketListView.tsx`
- Add `"Round of 32"` to `KnockoutCardItem["round"]` and the `rounds` filter array.
- Add `slotIndex?: number` and `matchNumber?: number` to `KnockoutCardItem`.
- Replace the hardcoded CASE 0 / CASE 1 / CASE 2 / CASE 3 projected bracket branches with a unified dynamic projection builder that uses `generateTournamentSeedOrder(bracketSize)` for any number of pools/qualifiers $N$ (from 2 pools up to 16 pools / 32 qualifiers).
- Default `viewMode` to `"tree"` so users immediately see the Challonge bracket layout while keeping the `"cards"` toggle available.

### 4. Rewrite `src/components/public/KnockoutTreeVisualizer.tsx`
- Replace the hardcoded `TenTeamBracketTree`, `EightTeamBracketTree`, and `FourTeamBracketTree` components with a unified, self-aligning Challonge-style bracket tree renderer:
  - Reconstruct the binary slot grid (`slotCount = bracketSize / Math.pow(2, roundIdx)`) for each main round (excluding `Bronze`, which renders in a dedicated card below/beside the Finals column).
  - Render column headers (`Round 1`, `Round 2`, `Semifinals`, `Finals`) in muted dark bars (`bg-[#333333] text-gray-200 text-xs font-semibold py-1.5 text-center w-64 shrink-0`).
  - Render each round column as `flex w-64 shrink-0 flex-col justify-around` so every match card automatically centers vertically between its two feeder slots from the previous round.
  - If a Round 1 binary slot was a BYE (no playable Round 1 match feeds that Round 2 slot), render an `invisible` spacer div in that `flex-1` slot so the remaining Round 1 play-in cards align directly with their target Round 2 match cards.
  - Draw crisp white/gray elbow connectors (`border-gray-300`) from playable feeder matches (`border-t-2 border-r-2 top-1/2 h-1/2` for even `slotIndex`, `border-b-2 border-r-2 bottom-1/2 h-1/2` for odd `slotIndex`) into a left horizontal stem (`-left-4 top-1/2 w-4 border-t-2 border-gray-300`) on the receiving match card.
  - Style each match node after the Challonge dark UI:
    - Sequential match number on the left (`w-6 text-[11px] font-mono text-gray-400`).
    - Card container (`bg-[#4a4a4a] rounded-[3px] shadow overflow-hidden flex-1`).
    - Two team rows (`h-7 text-xs flex items-center`) separated by `h-[1px] bg-[#262626]`.
    - Left seed badge (`w-6 h-full bg-[#595959] text-[10px] text-gray-300 flex items-center justify-center shrink-0`).
    - Team/player name (`flex-1 truncate px-2 text-gray-100`, bold white for winner) with a pulsing `bg-pickle` dot if `match.status === "live"`.
    - Right score box (`w-7 h-full flex items-center justify-center font-bold shrink-0`, `bg-[#e86c1f] text-white` for the winning team, `bg-[#595959] text-gray-200` otherwise).
  - Preserve zoom controls (`75%` to `130%`), `highlightTeam` ring highlighting, and `onTeamTap` click handlers.
```