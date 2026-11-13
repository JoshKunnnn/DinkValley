import { useMemo, useState } from "react";
import type { Category, Team } from "@/data/tournaments";
import { getMatchTeamDisplay } from "@/lib/match-store";
import { getDisplayRoundHeader, type KnockoutRoundName } from "@/lib/bracket-utils";
import type { KnockoutCardItem, ProjectedSlot } from "./KnockoutBracketListView";
import {
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Trophy,
  Medal,
  MoveHorizontal,
  Clock,
  CheckCircle2,
} from "lucide-react";

export interface KnockoutTreeVisualizerProps {
  category: Category;
  bracketItems: KnockoutCardItem[];
  isAllRoundRobinComplete: boolean;
  highlightTeam?: string | null | undefined;
  onTeamTap?: ((team: Team) => void) | undefined;
  poolCount?: number | undefined;
}

const MAIN_ROUND_SEQUENCE: Exclude<KnockoutRoundName, "Bronze">[] = [
  "Round of 32",
  "Round of 16",
  "Quarterfinal",
  "Semifinal",
  "Final",
];

interface NormalizedTreeMatch {
  item: KnockoutCardItem;
  roundIndex: number;
  slotIndex: number;
  matchNumber: number;
}

/**
 * Normalizes live, saved, or projected bracket items into binary slot coordinates
 * `(roundIndex, slotIndex)` so arbitrary sizes (2..32) render inside an aligned
 * power-of-2 tree—even for legacy Supabase draws saved without explicit `slotIndex`.
 */
function buildNormalizedTree(bracketItems: KnockoutCardItem[]): {
  activeRounds: Exclude<KnockoutRoundName, "Bronze">[];
  roundsMap: Map<number, Map<number, NormalizedTreeMatch>>;
  bronzeMatch: NormalizedTreeMatch | null;
} {
  const bronzeItem = bracketItems.find((m) => m.round === "Bronze") ?? null;
  const mainItems = bracketItems.filter((m) => m.round !== "Bronze");

  if (mainItems.length === 0) {
    return {
      activeRounds: [],
      roundsMap: new Map(),
      bronzeMatch: null,
    };
  }

  // Find earliest main round present so we know full tree depth down to Final
  let earliestGlobalIdx = MAIN_ROUND_SEQUENCE.length - 1;
  for (const item of mainItems) {
    const idx = MAIN_ROUND_SEQUENCE.indexOf(
      item.round as Exclude<KnockoutRoundName, "Bronze">,
    );
    if (idx >= 0 && idx < earliestGlobalIdx) {
      earliestGlobalIdx = idx;
    }
  }

  const activeRounds = MAIN_ROUND_SEQUENCE.slice(earliestGlobalIdx);
  const totalMainRounds = activeRounds.length;
  const roundToLocalIdx = new Map<KnockoutRoundName, number>();
  activeRounds.forEach((r, idx) => roundToLocalIdx.set(r, idx));

  // Infer missing slotIndex bottom-up starting from Final (slotIndex = 0)
  const inferredSlot = new Map<string, number>();
  for (const item of mainItems) {
    if (typeof item.slotIndex === "number" && item.slotIndex >= 0) {
      inferredSlot.set(item.id, item.slotIndex);
    } else if (item.round === "Final") {
      inferredSlot.set(item.id, 0);
    }
  }

  for (let pass = 0; pass < totalMainRounds; pass++) {
    for (const item of mainItems) {
      if (inferredSlot.has(item.id)) continue;
      const targetId = item.feedWinnerTo?.matchId;
      if (targetId && inferredSlot.has(targetId)) {
        const targetSlot = inferredSlot.get(targetId)!;
        const childOffset = item.feedWinnerTo?.slot === "teamB" ? 1 : 0;
        inferredSlot.set(item.id, targetSlot * 2 + childOffset);
      }
    }
  }

  // Deterministic fallback for any orphaned/unlinked match lacking feedWinnerTo
  const fallbackCounter = new Map<number, number>();
  const resolvedList: Array<{
    item: KnockoutCardItem;
    roundIndex: number;
    slotIndex: number;
  }> = [];

  for (const item of mainItems) {
    const roundIndex =
      roundToLocalIdx.get(item.round as Exclude<KnockoutRoundName, "Bronze">) ?? 0;
    let slotIndex = inferredSlot.get(item.id);
    if (slotIndex === undefined) {
      const idNumMatch = item.id.match(/-(\d+)$/);
      const seenCount = fallbackCounter.get(roundIndex) || 0;
      fallbackCounter.set(roundIndex, seenCount + 1);
      slotIndex = idNumMatch ? Math.max(0, Number(idNumMatch[1]) - 1) : seenCount;
    }
    resolvedList.push({ item, roundIndex, slotIndex });
  }

  resolvedList.sort(
    (a, b) => a.roundIndex - b.roundIndex || a.slotIndex - b.slotIndex,
  );

  const roundsMap = new Map<number, Map<number, NormalizedTreeMatch>>();
  let seqNum = 1;

  for (const entry of resolvedList) {
    const matchNumber = entry.item.matchNumber ?? seqNum;
    seqNum = Math.max(seqNum + 1, matchNumber + 1);

    let slotMap = roundsMap.get(entry.roundIndex);
    if (!slotMap) {
      slotMap = new Map();
      roundsMap.set(entry.roundIndex, slotMap);
    }
    // Avoid overwriting if an unusual manual draw put two matches at same slot
    let targetSlot = entry.slotIndex;
    while (slotMap.has(targetSlot)) {
      targetSlot++;
    }
    slotMap.set(targetSlot, {
      item: entry.item,
      roundIndex: entry.roundIndex,
      slotIndex: targetSlot,
      matchNumber,
    });
  }

  const bronzeMatch: NormalizedTreeMatch | null = bronzeItem
    ? {
        item: bronzeItem,
        roundIndex: totalMainRounds - 1,
        slotIndex: 0,
        matchNumber: bronzeItem.matchNumber ?? seqNum,
      }
    : null;

  return { activeRounds, roundsMap, bronzeMatch };
}

export function KnockoutTreeVisualizer({
  category,
  bracketItems,
  isAllRoundRobinComplete,
  highlightTeam,
  onTeamTap,
  poolCount,
}: KnockoutTreeVisualizerProps) {
  const [zoom, setZoom] = useState<number>(1);

  const { activeRounds, roundsMap, bronzeMatch } = useMemo(
    () => buildNormalizedTree(bracketItems),
    [bracketItems],
  );

  const totalMainRounds = activeRounds.length;
  const nonBronzeCount = bracketItems.filter((m) => m.round !== "Bronze").length;
  const participantEstimate = Math.max(2, nonBronzeCount + 1);

  const isOfficial = bracketItems.some(
    (m) =>
      m.status === "live" ||
      m.status === "final" ||
      m.status === "scheduled" ||
      !m.id.startsWith("proj-"),
  );
  const isLiveNow = bracketItems.some((m) => m.status === "live");
  const championSlot = useMemo(() => {
    const finalMatch = bracketItems.find((m) => m.round === "Final");
    return finalMatch?.winnerTeamName ?? null;
  }, [bracketItems]);

  if (totalMainRounds === 0) {
    return null;
  }

  return (
    <div className="space-y-3">
      {/* Control Toolbar (Theme-matched to Dink Valley Charcoal + Sand + Pickle) */}
      <div className="surface-card rounded-xl border-2 border-border bg-charcoal px-3.5 py-2.5 text-sand flex flex-wrap items-center justify-between gap-2.5">
        <div className="flex items-center gap-2 flex-wrap">
          <span className="font-mono text-[0.7rem] font-bold uppercase tracking-wider text-pickle">
            {participantEstimate}-Pair Elimination Tree
          </span>
          {poolCount && poolCount > 0 ? (
            <span className="text-[0.68rem] font-mono text-sand/70">
              &bull; {poolCount} {poolCount === 1 ? "Pool" : "Pools"}
            </span>
          ) : null}

          {isLiveNow ? (
            <span className="inline-flex items-center gap-1.5 rounded-full border border-pickle/40 bg-pickle/15 px-2.5 py-0.5 text-[0.65rem] font-mono font-bold uppercase tracking-wider text-pickle">
              <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-ping" />
              Live
            </span>
          ) : isOfficial || isAllRoundRobinComplete ? (
            <span className="inline-flex items-center gap-1 rounded-full border border-pickle/35 bg-pickle/15 px-2.5 py-0.5 text-[0.65rem] font-mono font-bold uppercase tracking-wider text-pickle">
              <CheckCircle2 size={11} />
              Official Seeds
            </span>
          ) : (
            <span className="inline-flex items-center gap-1 rounded-full border border-white/20 bg-white/10 px-2.5 py-0.5 text-[0.65rem] font-mono font-bold uppercase tracking-wider text-sand/85">
              <Clock size={11} />
              Projected Slots
            </span>
          )}
        </div>

        <div className="flex items-center gap-1.5">
          {highlightTeam ? (
            <span className="hidden sm:inline-block rounded bg-pickle/20 border border-pickle/40 px-2 py-0.5 text-[0.65rem] font-mono text-pickle">
              Highlighting: {highlightTeam}
            </span>
          ) : null}

          <div className="inline-flex items-center rounded-lg border border-white/15 bg-black/40 p-0.5 text-sand">
            <button
              type="button"
              onClick={() => setZoom((z) => Math.max(0.7, Number((z - 0.1).toFixed(2))))}
              className="p-1.5 rounded hover:bg-white/10 transition-colors cursor-pointer"
              title="Zoom Out"
              aria-label="Zoom Out"
            >
              <ZoomOut size={14} />
            </button>
            <span className="px-2 text-[0.68rem] font-mono font-bold min-w-[44px] text-center">
              {Math.round(zoom * 100)}%
            </span>
            <button
              type="button"
              onClick={() => setZoom((z) => Math.min(1.3, Number((z + 0.1).toFixed(2))))}
              className="p-1.5 rounded hover:bg-white/10 transition-colors cursor-pointer"
              title="Zoom In"
              aria-label="Zoom In"
            >
              <ZoomIn size={14} />
            </button>
            {zoom !== 1 && (
              <button
                type="button"
                onClick={() => setZoom(1)}
                className="p-1.5 rounded hover:bg-white/10 transition-colors cursor-pointer text-sand/70 hover:text-sand"
                title="Reset Zoom"
                aria-label="Reset Zoom"
              >
                <RotateCcw size={13} />
              </button>
            )}
          </div>
        </div>
      </div>

      {/* Mobile Scroll Hint */}
      <div className="flex sm:hidden items-center justify-center gap-1.5 text-[0.68rem] font-mono text-muted-foreground">
        <MoveHorizontal size={13} className="text-pickle" />
        <span>Swipe horizontally to inspect all rounds</span>
      </div>

      {/* Challonge Dark-Mode Self-Aligning Tree Canvas */}
      <div className="rounded-2xl border-2 border-border bg-[#262626] shadow-lg overflow-hidden">
        <div
          className="overflow-x-auto p-4 sm:p-6"
          aria-label={`${category.label} Elimination Bracket Tree`}
        >
          <div
            style={{ zoom }}
            className="min-w-max transition-all duration-150 pt-3"
          >
            {/* Horizontal Columns Container */}
            <div className="flex items-stretch gap-x-8">
              {activeRounds.map((roundName, rIdx) => {
                const slotCount = Math.pow(2, totalMainRounds - 1 - rIdx);
                const columnMap = roundsMap.get(rIdx) ?? new Map<number, NormalizedTreeMatch>();
                const prevColumnMap = rIdx > 0 ? roundsMap.get(rIdx - 1) : undefined;
                const isLastRound = rIdx === totalMainRounds - 1;
                const headerTitle = getDisplayRoundHeader(
                  roundName,
                  rIdx,
                  totalMainRounds,
                );

                return (
                  <div key={roundName} className="flex w-64 shrink-0 flex-col">
                    {/* Challonge Column Header */}
                    <div className="mb-4 flex h-9 shrink-0 items-center justify-between rounded-xs bg-[#333333] px-3 text-xs font-semibold tracking-wider text-gray-200 uppercase border border-white/10">
                      <span>{headerTitle}</span>
                      <span className="font-mono text-[10px] text-gray-400">
                        {columnMap.size}{" "}
                        {columnMap.size === 1 ? "match" : "matches"}
                      </span>
                    </div>

                    {/* Binary Flex Slots (No vertical gap so center coordinates stay mathematically aligned) */}
                    <div className="flex flex-1 flex-col">
                      {Array.from({ length: slotCount }, (_, slotIdx) => {
                        const node = columnMap.get(slotIdx);

                        if (!node) {
                          // Invisible BYE Spacer (matches 66px MatchCard + py-3.5 padding so vertical bands stay uniform)
                          return (
                            <div
                              key={`${roundName}-bye-${slotIdx}`}
                              className="relative flex flex-1 items-center py-3.5"
                              aria-hidden="true"
                            >
                              <div className="invisible h-[66px] w-full" />
                            </div>
                          );
                        }

                        const isEven = slotIdx % 2 === 0;
                        const hasIncoming =
                          rIdx > 0 &&
                          Boolean(
                            prevColumnMap?.has(slotIdx * 2) ||
                              prevColumnMap?.has(slotIdx * 2 + 1),
                          );

                        return (
                          <div
                            key={node.item.id}
                            className="relative flex flex-1 items-center py-3.5"
                          >
                            {/* Outgoing Connector Elbow to Next Round */}
                            {!isLastRound &&
                              (isEven ? (
                                <div
                                  className="pointer-events-none absolute -right-4 top-1/2 h-1/2 w-4 border-t-2 border-r-2 border-gray-500/80"
                                  aria-hidden="true"
                                />
                              ) : (
                                <div
                                  className="pointer-events-none absolute -right-4 bottom-1/2 h-1/2 w-4 border-b-2 border-r-2 border-gray-500/80"
                                  aria-hidden="true"
                                />
                              ))}

                            {/* Incoming Connector Stem from Previous Round */}
                            {hasIncoming && (
                              <div
                                className="pointer-events-none absolute -left-4 top-1/2 w-4 border-t-2 border-gray-500/80"
                                aria-hidden="true"
                              />
                            )}

                            <ChallongeMatchCard
                              node={node}
                              highlightTeam={highlightTeam}
                              onTeamTap={onTeamTap}
                            />
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}

              {/* Champion Callout Column */}
              <div className="flex w-52 shrink-0 flex-col">
                <div className="mb-4 flex h-9 shrink-0 items-center gap-1.5 rounded-xs bg-[#333333] px-3 text-xs font-semibold tracking-wider text-gray-200 uppercase border border-white/10">
                  <Trophy size={13} className="text-[#e86c1f]" />
                  <span>Champion</span>
                </div>
                <div className="flex flex-1 flex-col">
                  <div className="relative flex flex-1 items-center py-3.5">
                    <div
                      className="pointer-events-none absolute -left-4 top-1/2 w-4 border-t-2 border-gray-500/80"
                      aria-hidden="true"
                    />
                    <div
                      className={`w-full rounded-xs border px-3 py-3 transition-colors ${
                        championSlot
                          ? "border-[#e86c1f] bg-[#e86c1f]/15 text-white shadow-md"
                          : "border-white/10 bg-[#333333]/70 text-gray-400"
                      }`}
                    >
                      <div className="flex items-center gap-1.5 text-[10px] font-mono uppercase tracking-wider text-gray-400">
                        <Trophy
                          size={11}
                          className={championSlot ? "text-[#e86c1f]" : "text-gray-500"}
                        />
                        <span>Division Winner</span>
                      </div>
                      <div className="mt-1 font-display text-base font-bold truncate">
                        {championSlot || "TBD"}
                      </div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {/* Dedicated 3rd Place / Bronze Match Section (Decoupled from Main Binary Grid) */}
            {bronzeMatch && (
              <div className="mt-6 border-t border-white/10 pt-4">
                <div className="w-72 max-w-full">
                  <div className="mb-6 flex h-8 items-center gap-1.5 rounded-xs bg-[#333333] px-3 text-[11px] font-semibold tracking-wider text-gray-200 uppercase border border-white/10">
                    <Medal size={13} className="text-amber-400" />
                    <span>3rd Place Match</span>
                  </div>
                  <ChallongeMatchCard
                    node={bronzeMatch}
                    highlightTeam={highlightTeam}
                    onTeamTap={onTeamTap}
                  />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}

function doesSlotMatchHighlight(
  slot: ProjectedSlot,
  highlight?: string | null,
): boolean {
  if (!highlight) return false;
  const q = highlight.trim().toLowerCase();
  if (!q) return false;
  if (slot.team) {
    if (slot.team.name.toLowerCase().includes(q)) return true;
    if (slot.team.players.some((p) => p.toLowerCase().includes(q))) return true;
  }
  if (slot.provisionalTeamName?.toLowerCase().includes(q)) return true;
  return false;
}

function ChallongeMatchCard({
  node,
  highlightTeam,
  onTeamTap,
}: {
  node: NormalizedTreeMatch;
  highlightTeam?: string | null | undefined;
  onTeamTap?: ((team: Team) => void) | undefined;
}) {
  const { item, matchNumber } = node;
  const isLive = item.status === "live";
  const isFinal = item.status === "final";

  const hasScores =
    typeof item.scoreA === "number" && typeof item.scoreB === "number";

  const dispA = item.slotA.team
    ? getMatchTeamDisplay(
        item.slotA.team.name,
        item.slotA.team.players,
        item.slotA.team.name,
      )
    : null;
  const dispB = item.slotB.team
    ? getMatchTeamDisplay(
        item.slotB.team.name,
        item.slotB.team.players,
        item.slotB.team.name,
      )
    : null;

  const wonA =
    isFinal &&
    ((item.winnerTeamName &&
      dispA?.primary &&
      item.winnerTeamName === dispA.primary) ||
      (item.winnerTeamName &&
        item.slotA.team?.name &&
        item.winnerTeamName === item.slotA.team.name) ||
      (hasScores && (item.scoreA as number) > (item.scoreB as number)));

  const wonB =
    isFinal &&
    !wonA &&
    ((item.winnerTeamName &&
      dispB?.primary &&
      item.winnerTeamName === dispB.primary) ||
      (item.winnerTeamName &&
        item.slotB.team?.name &&
        item.winnerTeamName === item.slotB.team.name) ||
      (hasScores && (item.scoreB as number) > (item.scoreA as number)));

  const isHighlighted =
    doesSlotMatchHighlight(item.slotA, highlightTeam) ||
    doesSlotMatchHighlight(item.slotB, highlightTeam);

  return (
    <div className="relative w-full">
      {/* Metadata Strip positioned above the 66px card box so top-1/2 stems align to the exact teamA/teamB seam */}
      <div className="pointer-events-none absolute -top-4 left-0 right-0 flex items-center justify-between px-0.5 text-[10px] font-mono leading-none text-gray-400">
        <span className="truncate pr-2 font-bold text-gray-300">
          #{matchNumber}
          {item.court ? ` · ${item.court}` : ""}
        </span>
        {isLive ? (
          <span className="inline-flex shrink-0 items-center gap-1 font-bold text-pickle uppercase">
            <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-pulse" />
            Live
          </span>
        ) : isFinal ? (
          <span className="shrink-0 text-gray-400 uppercase">Final</span>
        ) : null}
      </div>

      {/* Challonge 2-Row Match Box (Fixed 66px height = border + two 32px rows) */}
      <div
        className={`w-full overflow-hidden rounded-xs bg-[#4a4a4a] shadow-md transition-all ${
          isHighlighted
            ? "ring-2 ring-pickle shadow-[0_0_14px_rgba(190,242,100,0.3)]"
            : isLive
              ? "border border-pickle/70"
              : "border border-[#595959]"
        }`}
      >
        <ChallongeSlotRow
          slot={item.slotA}
          displayPrimary={dispA?.primary}
          score={item.scoreA}
          isWinner={Boolean(wonA)}
          isLoser={Boolean(wonB)}
          isLive={isLive}
          hasBorderBottom
          onTeamTap={onTeamTap}
        />
        <ChallongeSlotRow
          slot={item.slotB}
          displayPrimary={dispB?.primary}
          score={item.scoreB}
          isWinner={Boolean(wonB)}
          isLoser={Boolean(wonA)}
          isLive={isLive}
          hasBorderBottom={false}
          onTeamTap={onTeamTap}
        />
      </div>
    </div>
  );
}

function ChallongeSlotRow({
  slot,
  displayPrimary,
  score,
  isWinner,
  isLoser,
  isLive,
  hasBorderBottom,
  onTeamTap,
}: {
  slot: ProjectedSlot;
  displayPrimary?: string | undefined;
  score?: number | null | undefined;
  isWinner: boolean;
  isLoser: boolean;
  isLive: boolean;
  hasBorderBottom: boolean;
  onTeamTap?: ((team: Team) => void) | undefined;
}) {
  const canTap = Boolean(slot.team && onTeamTap);
  const seedText = slot.seedNum > 0 ? String(slot.seedNum) : "-";

  return (
    <div
      onClick={() => canTap && slot.team && onTeamTap?.(slot.team)}
      className={`flex h-8 items-center justify-between text-xs ${
        hasBorderBottom ? "border-b border-[#3a3a3a]" : ""
      } ${canTap ? "cursor-pointer hover:bg-[#525252]" : ""}`}
    >
      {/* Left Seed Number Badge */}
      <div className="flex h-full w-7 shrink-0 items-center justify-center bg-[#595959] font-mono text-[11px] font-bold text-gray-200 border-r border-[#3a3a3a]">
        {seedText}
      </div>

      {/* Team Name / Projected Label */}
      <div className="min-w-0 flex-1 px-2.5 flex items-center gap-1.5">
        {slot.isBye ? (
          <span className="truncate font-mono text-[11px] text-gray-400">BYE</span>
        ) : slot.team && displayPrimary ? (
          <span
            className={`truncate font-semibold ${
              isWinner
                ? "text-white"
                : isLoser
                  ? "text-gray-400"
                  : "text-gray-100"
            }`}
            title={displayPrimary}
          >
            {displayPrimary}
          </span>
        ) : slot.provisionalTeamName ? (
          <span
            className="truncate text-[11px] italic text-gray-300/80"
            title={`Projected: ${slot.provisionalTeamName}`}
          >
            ~ {slot.provisionalTeamName}
          </span>
        ) : (
          <span
            className="truncate font-mono text-[11px] text-gray-400"
            title={slot.label}
          >
            {slot.label}
          </span>
        )}
      </div>

      {/* Score Box */}
      <div
        className={`flex h-full w-8 shrink-0 items-center justify-center font-mono text-xs font-bold border-l border-[#3a3a3a] ${
          isWinner
            ? "bg-[#e86c1f] text-white"
            : isLive && score !== null && score !== undefined
              ? "bg-pickle/25 text-pickle"
              : "bg-[#595959] text-gray-200"
        }`}
      >
        {score !== null && score !== undefined ? score : "-"}
      </div>
    </div>
  );
}
