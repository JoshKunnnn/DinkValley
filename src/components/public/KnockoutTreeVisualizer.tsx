import React, { useState, useRef } from "react";
import type { Category, Team } from "@/data/tournaments";
import type { KnockoutCardItem, ProjectedSlot } from "./KnockoutBracketListView";
import {
  Trophy,
  ShieldCheck,
  CheckCircle2,
  Clock,
  Activity,
  ZoomIn,
  ZoomOut,
  RotateCcw,
  Sparkles,
  Info,
} from "lucide-react";

export interface KnockoutTreeVisualizerProps {
  category: Category;
  bracketItems: KnockoutCardItem[];
  isAllRoundRobinComplete: boolean;
  highlightTeam?: string | null | undefined;
  onTeamTap?: ((team: Team) => void) | undefined;
  poolCount?: number | undefined;
}

/**
 * A tournament bracket tree visualizer with connecting lines
 * inspired by Challonge, Score7, and TournamentSoftware.
 * Supports:
 * - 10-team bracket (2 play-ins in Round 1 + 6 BYEs into Round 2 Quarterfinals)
 * - 8-team bracket (4 Quarterfinals -> 2 Semifinals -> Finals)
 * - 4-team bracket (2 Semifinals -> Finals)
 * - 16-team bracket (8 Round of 16 matches -> QF -> SF -> Finals)
 */
export function KnockoutTreeVisualizer({
  category,
  bracketItems,
  isAllRoundRobinComplete,
  highlightTeam,
  onTeamTap,
  poolCount = 5,
}: KnockoutTreeVisualizerProps) {
  const [zoomLevel, setZoomLevel] = useState<number>(100);
  const containerRef = useRef<HTMLDivElement>(null);

  const isPlayoffLive = bracketItems.some((item) => item.status === "live");
  const finalMatch = bracketItems.find((m) => m.round === "Final");
  const bronzeMatch = bracketItems.find((m) => m.round === "Bronze");

  // Determine rounds available
  const hasR16 = bracketItems.some((m) => m.round === "Round of 16");
  const hasQF = bracketItems.some((m) => m.round === "Quarterfinal");
  const hasSF = bracketItems.some((m) => m.round === "Semifinal");
  const hasFinal = Boolean(finalMatch);

  // Group matches by round
  const r16Matches = bracketItems.filter((m) => m.round === "Round of 16");
  const qfMatches = bracketItems.filter((m) => m.round === "Quarterfinal");
  const sfMatches = bracketItems.filter((m) => m.round === "Semifinal");

  // Match lookup helpers
  const qf1 = qfMatches[0];
  const qf2 = qfMatches[1];
  const qf3 = qfMatches[2];
  const qf4 = qfMatches[3];

  const sf1 = sfMatches[0];
  const sf2 = sfMatches[1];

  const r16Upper = r16Matches[0];
  const r16Lower = r16Matches[1];

  const handleZoom = (delta: number) => {
    setZoomLevel((prev) => Math.min(130, Math.max(75, prev + delta)));
  };

  const handleResetZoom = () => {
    setZoomLevel(100);
  };

  return (
    <div className="space-y-4">
      {/* ── Top Control & Status Banner (Matches user reference) ── */}
      <div className="surface-card bg-charcoal text-sand p-3.5 sm:p-4 rounded-xl border-2 border-border shadow-sm flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        <div className="flex items-center gap-2.5 min-w-0">
          <span className="p-1.5 rounded-lg bg-pickle/20 text-pickle border border-pickle/30 shrink-0">
            <ShieldCheck size={16} />
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2 flex-wrap">
              <span className="text-[0.65rem] font-mono font-bold uppercase tracking-wider text-pickle">
                Knockout Tree
              </span>
              <span className="text-[0.65rem] text-sand/60">&bull;</span>
              <span className="text-[0.65rem] font-mono text-sand/80">
                Seeded by Point Differential
              </span>
            </div>
            <p className="text-xs text-sand/90 truncate">
              {!isAllRoundRobinComplete
                ? "Final stage match-ups will be announced once the group stage has ended."
                : isPlayoffLive
                  ? "Playoff stage matches are currently live on court."
                  : "Round-robin finalized &bull; Knockout seeds locked."}
            </p>
          </div>
        </div>

        {/* Live Indicator & Zoom Toolbar */}
        <div className="flex items-center gap-2 shrink-0 self-end sm:self-auto">
          {isPlayoffLive ? (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-pickle/20 border border-pickle/40 text-pickle font-mono text-xs font-bold uppercase tracking-wider">
              <span className="w-2 h-2 rounded-full bg-pickle animate-ping" />
              LIVE
            </span>
          ) : (
            <span className="inline-flex items-center gap-1.5 px-2.5 py-1 rounded-full bg-white/10 border border-white/20 text-sand/80 font-mono text-xs uppercase tracking-wider">
              <Clock size={12} />
              {isAllRoundRobinComplete ? "Official Seeds" : "Projected Slots"}
            </span>
          )}

          {/* Zoom controls */}
          <div className="hidden sm:inline-flex items-center rounded-lg border border-white/20 bg-black/40 p-0.5 text-xs font-mono text-sand/80">
            <button
              type="button"
              onClick={() => handleZoom(-10)}
              title="Zoom out"
              className="p-1 hover:text-sand hover:bg-white/10 rounded cursor-pointer transition-colors"
            >
              <ZoomOut size={13} />
            </button>
            <button
              type="button"
              onClick={handleResetZoom}
              title="Reset zoom"
              className="px-2 py-0.5 hover:text-sand hover:bg-white/10 rounded cursor-pointer transition-colors text-[0.65rem]"
            >
              {zoomLevel}%
            </button>
            <button
              type="button"
              onClick={() => handleZoom(10)}
              title="Zoom in"
              className="p-1 hover:text-sand hover:bg-white/10 rounded cursor-pointer transition-colors"
            >
              <ZoomIn size={13} />
            </button>
          </div>
        </div>
      </div>

      {/* ── Scroll Hint on Small Screens ── */}
      <div className="sm:hidden text-center">
        <span className="text-[0.65rem] font-mono uppercase tracking-wider text-muted-foreground bg-muted/40 px-3 py-1 rounded-full border border-border inline-flex items-center gap-1.5">
          <span>&larr; Drag horizontally to view full bracket tree &rarr;</span>
        </span>
      </div>

      {/* ── Visual Bracket Canvas (Horizontally Scrollable) ── */}
      <div
        ref={containerRef}
        className="surface-card bg-charcoal/95 border-2 border-border rounded-2xl p-4 sm:p-6 overflow-x-auto shadow-inner"
        style={{ WebkitOverflowScrolling: "touch" }}
      >
        <div
          className="transition-transform duration-150 origin-top-left min-w-max pb-2"
          style={{ transform: `scale(${zoomLevel / 100})` }}
        >
          {/* CASE A: 10-TEAM FORMAT (5 Groups with 2 Play-Ins and 6 BYEs into QF) */}
          {poolCount === 5 || (hasR16 && r16Matches.length === 2 && hasQF) ? (
            <TenTeamBracketTree
              r16Upper={r16Upper}
              r16Lower={r16Lower}
              qf1={qf1}
              qf2={qf2}
              qf3={qf3}
              qf4={qf4}
              sf1={sf1}
              sf2={sf2}
              finalMatch={finalMatch}
              bronzeMatch={bronzeMatch}
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          ) : hasQF ? (
            /* CASE B: 8-TEAM FORMAT (Standard 4 Quarterfinals) */
            <EightTeamBracketTree
              qf1={qf1}
              qf2={qf2}
              qf3={qf3}
              qf4={qf4}
              sf1={sf1}
              sf2={sf2}
              finalMatch={finalMatch}
              bronzeMatch={bronzeMatch}
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          ) : hasSF ? (
            /* CASE C: 4-TEAM FORMAT (2 Semifinals) */
            <FourTeamBracketTree
              sf1={sf1}
              sf2={sf2}
              finalMatch={finalMatch}
              bronzeMatch={bronzeMatch}
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          ) : (
            /* Fallback generic column tree */
            <GenericColumnTree
              bracketItems={bracketItems}
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          )}
        </div>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 10-TEAM BRACKET TREE (2 Preliminary Play-Ins + 4 Quarterfinals)
// Exactly matching user reference screenshot
// ─────────────────────────────────────────────────────────────
function TenTeamBracketTree({
  r16Upper,
  r16Lower,
  qf1,
  qf2,
  qf3,
  qf4,
  sf1,
  sf2,
  finalMatch,
  bronzeMatch,
  highlightTeam,
  onTeamTap,
}: {
  r16Upper?: KnockoutCardItem;
  r16Lower?: KnockoutCardItem;
  qf1?: KnockoutCardItem;
  qf2?: KnockoutCardItem;
  qf3?: KnockoutCardItem;
  qf4?: KnockoutCardItem;
  sf1?: KnockoutCardItem;
  sf2?: KnockoutCardItem;
  finalMatch?: KnockoutCardItem;
  bronzeMatch?: KnockoutCardItem;
  highlightTeam?: string | null | undefined;
  onTeamTap?: ((team: Team) => void) | undefined;
}) {
  return (
    <div className="space-y-6">
      {/* Column Headers */}
      <div className="grid grid-cols-[230px_50px_230px_50px_230px_50px_230px] items-center text-center pb-3 border-b border-white/10 text-xs font-mono font-bold uppercase tracking-widest text-sand/80">
        <div>Round 1 (Play-In)</div>
        <div />
        <div>Round 2 (Quarterfinals)</div>
        <div />
        <div>Round 3 (Semifinals)</div>
        <div />
        <div>Championship Final</div>
      </div>

      {/* Main Bracket Grid */}
      <div className="grid grid-cols-[230px_50px_230px_50px_230px_50px_230px] items-stretch gap-y-4">
        {/* ── UPPER HALF ── */}

        {/* Row 1: R16 Match 1 -> QF 1 */}
        <div className="flex flex-col justify-center">
          {r16Upper ? (
            <TreeMatchNode
              matchIndex="1"
              match={r16Upper}
              defaultSlotALabel="Seed #8 (Pool C/D 2nd)"
              defaultSlotBLabel="Seed #9 (Pool B/E 2nd)"
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          ) : (
            <PlaceholderNode matchIndex="1" label="Match 1 (Seed #8 vs #9)" />
          )}
        </div>

        {/* Connector from R1 Match 1 into QF 1 Bottom Slot */}
        <div className="flex items-center justify-center">
          <svg className="w-full h-24 stroke-white/40 fill-none" strokeWidth="2">
            <path d="M 0 48 H 25 V 72 H 50" />
          </svg>
        </div>

        {/* QF 1 (Match 5 in screenshot) */}
        <div className="flex flex-col justify-center">
          {qf1 ? (
            <TreeMatchNode
              matchIndex="5"
              match={qf1}
              defaultSlotALabel="Seed #1 (Pool A 1st - BYE)"
              defaultSlotBLabel="Winner of Match 1"
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          ) : (
            <PlaceholderNode matchIndex="5" label="Quarterfinal 1 (Seed #1 vs Winner M1)" />
          )}
        </div>

        {/* Connector from QF 1 & QF 2 into SF 1 */}
        <div className="row-span-2 flex items-center justify-center">
          <svg className="w-full h-full stroke-white/40 fill-none min-h-[190px]" strokeWidth="2">
            {/* Top arm from QF 1 */}
            <path d="M 0 25% H 25 V 50% H 50" />
            {/* Bottom arm from QF 2 */}
            <path d="M 0 75% H 25 V 50%" />
          </svg>
        </div>

        {/* Semifinal 1 (spans 2 rows) */}
        <div className="row-span-2 flex flex-col justify-center">
          {sf1 ? (
            <TreeMatchNode
              matchIndex="7"
              match={sf1}
              defaultSlotALabel="Winner of Match 5"
              defaultSlotBLabel="Winner of Match 3"
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          ) : (
            <PlaceholderNode matchIndex="7" label="Semifinal 1 (Winner QF 1 vs QF 2)" />
          )}
        </div>

        {/* Connector from SF 1 & SF 2 into Championship Final */}
        <div className="row-span-4 flex items-center justify-center">
          <svg className="w-full h-full stroke-white/40 fill-none min-h-[380px]" strokeWidth="2">
            {/* Top arm from SF 1 */}
            <path d="M 0 25% H 25 V 50% H 50" />
            {/* Bottom arm from SF 2 */}
            <path d="M 0 75% H 25 V 50%" />
          </svg>
        </div>

        {/* Championship Final (spans all 4 rows) */}
        <div className="row-span-4 flex flex-col justify-center">
          {finalMatch ? (
            <TreeMatchNode
              matchIndex="Final"
              match={finalMatch}
              defaultSlotALabel="Winner of Semifinal 1"
              defaultSlotBLabel="Winner of Semifinal 2"
              isChampionship
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          ) : (
            <PlaceholderNode matchIndex="Final" label="Championship Final" isChampionship />
          )}
        </div>

        {/* Row 2: Empty R1 slot (BYE) -> QF 2 */}
        <div className="flex items-center justify-center p-2 rounded-lg border border-dashed border-white/10 text-[0.68rem] font-mono text-sand/40">
          BYE - Direct to Round 2
        </div>

        {/* Direct line into QF 2 */}
        <div className="flex items-center justify-center">
          <div className="w-full h-0.5 bg-white/20" />
        </div>

        {/* QF 2 (Match 3 in screenshot: 1st C vs 1st E or Seed #4 vs #5) */}
        <div className="flex flex-col justify-center">
          {qf2 ? (
            <TreeMatchNode
              matchIndex="3"
              match={qf2}
              defaultSlotALabel="Seed #4 (Pool C 1st - BYE)"
              defaultSlotBLabel="Seed #5 (Pool E 1st - BYE)"
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          ) : (
            <PlaceholderNode matchIndex="3" label="Quarterfinal 2 (Seed #4 vs Seed #5)" />
          )}
        </div>

        {/* ── LOWER HALF ── */}

        {/* Row 3: R16 Match 2 -> QF 3 */}
        <div className="flex flex-col justify-center pt-4 border-t border-white/10">
          {r16Lower ? (
            <TreeMatchNode
              matchIndex="2"
              match={r16Lower}
              defaultSlotALabel="Seed #7 (Pool A 2nd)"
              defaultSlotBLabel="Seed #10 (Pool D 2nd)"
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          ) : (
            <PlaceholderNode matchIndex="2" label="Match 2 (Seed #7 vs #10)" />
          )}
        </div>

        {/* Connector from R1 Match 2 into QF 3 Bottom Slot */}
        <div className="flex items-center justify-center pt-4 border-t border-white/10">
          <svg className="w-full h-24 stroke-white/40 fill-none" strokeWidth="2">
            <path d="M 0 48 H 25 V 72 H 50" />
          </svg>
        </div>

        {/* QF 3 (Match 6 in screenshot) */}
        <div className="flex flex-col justify-center pt-4 border-t border-white/10">
          {qf3 ? (
            <TreeMatchNode
              matchIndex="6"
              match={qf3}
              defaultSlotALabel="Seed #2 (Pool B 1st - BYE)"
              defaultSlotBLabel="Winner of Match 2"
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          ) : (
            <PlaceholderNode matchIndex="6" label="Quarterfinal 3 (Seed #2 vs Winner M2)" />
          )}
        </div>

        {/* Connector from QF 3 & QF 4 into SF 2 */}
        <div className="row-span-2 flex items-center justify-center pt-4 border-t border-white/10">
          <svg className="w-full h-full stroke-white/40 fill-none min-h-[190px]" strokeWidth="2">
            {/* Top arm from QF 3 */}
            <path d="M 0 25% H 25 V 50% H 50" />
            {/* Bottom arm from QF 4 */}
            <path d="M 0 75% H 25 V 50%" />
          </svg>
        </div>

        {/* Semifinal 2 (spans 2 rows) */}
        <div className="row-span-2 flex flex-col justify-center pt-4 border-t border-white/10">
          {sf2 ? (
            <TreeMatchNode
              matchIndex="8"
              match={sf2}
              defaultSlotALabel="Winner of Match 6"
              defaultSlotBLabel="Winner of Match 4"
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          ) : (
            <PlaceholderNode matchIndex="8" label="Semifinal 2 (Winner QF 3 vs QF 4)" />
          )}
        </div>

        {/* Row 4: Empty R1 slot (BYE) -> QF 4 */}
        <div className="flex items-center justify-center p-2 rounded-lg border border-dashed border-white/10 text-[0.68rem] font-mono text-sand/40">
          BYE - Direct to Round 2
        </div>

        {/* Direct line into QF 4 */}
        <div className="flex items-center justify-center">
          <div className="w-full h-0.5 bg-white/20" />
        </div>

        {/* QF 4 (Match 4 in screenshot: 1st D vs 2nd C or Seed #3 vs #6) */}
        <div className="flex flex-col justify-center">
          {qf4 ? (
            <TreeMatchNode
              matchIndex="4"
              match={qf4}
              defaultSlotALabel="Seed #3 (Pool D 1st - BYE)"
              defaultSlotBLabel="Seed #6 (Pool C 2nd - BYE)"
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          ) : (
            <PlaceholderNode matchIndex="4" label="Quarterfinal 4 (Seed #3 vs Seed #6)" />
          )}
        </div>
      </div>

      {/* ── 3rd Place Match (Bronze Podium) ── */}
      {bronzeMatch && (
        <div className="pt-6 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between gap-4 bg-white/5 p-4 rounded-xl">
          <div className="space-y-0.5">
            <span className="text-[0.65rem] font-mono uppercase tracking-widest text-brick font-bold block">
              Bronze Medal Match
            </span>
            <span className="text-sm font-display text-sand">
              3rd Place Podium Determination
            </span>
          </div>
          <div className="w-full sm:w-80">
            <TreeMatchNode
              matchIndex="Bronze"
              match={bronzeMatch}
              defaultSlotALabel="Runner-up Semifinal 1"
              defaultSlotBLabel="Runner-up Semifinal 2"
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 8-TEAM BRACKET TREE (4 Quarterfinals -> 2 Semifinals -> Final)
// ─────────────────────────────────────────────────────────────
function EightTeamBracketTree({
  qf1,
  qf2,
  qf3,
  qf4,
  sf1,
  sf2,
  finalMatch,
  bronzeMatch,
  highlightTeam,
  onTeamTap,
}: {
  qf1?: KnockoutCardItem;
  qf2?: KnockoutCardItem;
  qf3?: KnockoutCardItem;
  qf4?: KnockoutCardItem;
  sf1?: KnockoutCardItem;
  sf2?: KnockoutCardItem;
  finalMatch?: KnockoutCardItem;
  bronzeMatch?: KnockoutCardItem;
  highlightTeam?: string | null | undefined;
  onTeamTap?: ((team: Team) => void) | undefined;
}) {
  return (
    <div className="space-y-6">
      {/* Column Headers */}
      <div className="grid grid-cols-[230px_50px_230px_50px_230px] items-center text-center pb-3 border-b border-white/10 text-xs font-mono font-bold uppercase tracking-widest text-sand/80">
        <div>Quarterfinals</div>
        <div />
        <div>Semifinals</div>
        <div />
        <div>Championship Final</div>
      </div>

      {/* Main Bracket Grid */}
      <div className="grid grid-cols-[230px_50px_230px_50px_230px] items-stretch gap-y-4">
        {/* QF 1 */}
        <div className="flex flex-col justify-center">
          {qf1 && (
            <TreeMatchNode
              matchIndex="1"
              match={qf1}
              defaultSlotALabel="Seed #1"
              defaultSlotBLabel="Seed #8"
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          )}
        </div>

        {/* Connector QF 1 & QF 2 -> SF 1 */}
        <div className="row-span-2 flex items-center justify-center">
          <svg className="w-full h-full stroke-white/40 fill-none min-h-[180px]" strokeWidth="2">
            <path d="M 0 25% H 25 V 50% H 50" />
            <path d="M 0 75% H 25 V 50%" />
          </svg>
        </div>

        {/* Semifinal 1 */}
        <div className="row-span-2 flex flex-col justify-center">
          {sf1 && (
            <TreeMatchNode
              matchIndex="5"
              match={sf1}
              defaultSlotALabel="Winner QF 1"
              defaultSlotBLabel="Winner QF 2"
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          )}
        </div>

        {/* Connector SF 1 & SF 2 -> Final */}
        <div className="row-span-4 flex items-center justify-center">
          <svg className="w-full h-full stroke-white/40 fill-none min-h-[360px]" strokeWidth="2">
            <path d="M 0 25% H 25 V 50% H 50" />
            <path d="M 0 75% H 25 V 50%" />
          </svg>
        </div>

        {/* Final */}
        <div className="row-span-4 flex flex-col justify-center">
          {finalMatch && (
            <TreeMatchNode
              matchIndex="Final"
              match={finalMatch}
              defaultSlotALabel="Winner Semifinal 1"
              defaultSlotBLabel="Winner Semifinal 2"
              isChampionship
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          )}
        </div>

        {/* QF 2 */}
        <div className="flex flex-col justify-center">
          {qf2 && (
            <TreeMatchNode
              matchIndex="2"
              match={qf2}
              defaultSlotALabel="Seed #4"
              defaultSlotBLabel="Seed #5"
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          )}
        </div>

        {/* QF 3 */}
        <div className="flex flex-col justify-center pt-4 border-t border-white/10">
          {qf3 && (
            <TreeMatchNode
              matchIndex="3"
              match={qf3}
              defaultSlotALabel="Seed #2"
              defaultSlotBLabel="Seed #7"
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          )}
        </div>

        {/* Connector QF 3 & QF 4 -> SF 2 */}
        <div className="row-span-2 flex items-center justify-center pt-4 border-t border-white/10">
          <svg className="w-full h-full stroke-white/40 fill-none min-h-[180px]" strokeWidth="2">
            <path d="M 0 25% H 25 V 50% H 50" />
            <path d="M 0 75% H 25 V 50%" />
          </svg>
        </div>

        {/* Semifinal 2 */}
        <div className="row-span-2 flex flex-col justify-center pt-4 border-t border-white/10">
          {sf2 && (
            <TreeMatchNode
              matchIndex="6"
              match={sf2}
              defaultSlotALabel="Winner QF 3"
              defaultSlotBLabel="Winner QF 4"
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          )}
        </div>

        {/* QF 4 */}
        <div className="flex flex-col justify-center">
          {qf4 && (
            <TreeMatchNode
              matchIndex="4"
              match={qf4}
              defaultSlotALabel="Seed #3"
              defaultSlotBLabel="Seed #6"
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          )}
        </div>
      </div>

      {/* 3rd Place Match */}
      {bronzeMatch && (
        <div className="pt-6 border-t border-white/10 flex flex-col sm:flex-row items-center justify-between gap-4 bg-white/5 p-4 rounded-xl">
          <span className="text-xs font-mono uppercase tracking-widest text-brick font-bold">
            3rd Place Match (Bronze)
          </span>
          <div className="w-full sm:w-80">
            <TreeMatchNode
              matchIndex="Bronze"
              match={bronzeMatch}
              defaultSlotALabel="Runner-up SF 1"
              defaultSlotBLabel="Runner-up SF 2"
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 4-TEAM BRACKET TREE (2 Semifinals -> Final)
// ─────────────────────────────────────────────────────────────
function FourTeamBracketTree({
  sf1,
  sf2,
  finalMatch,
  bronzeMatch,
  highlightTeam,
  onTeamTap,
}: {
  sf1?: KnockoutCardItem;
  sf2?: KnockoutCardItem;
  finalMatch?: KnockoutCardItem;
  bronzeMatch?: KnockoutCardItem;
  highlightTeam?: string | null | undefined;
  onTeamTap?: ((team: Team) => void) | undefined;
}) {
  return (
    <div className="space-y-6">
      <div className="grid grid-cols-[230px_50px_230px] items-center text-center pb-3 border-b border-white/10 text-xs font-mono font-bold uppercase tracking-widest text-sand/80">
        <div>Semifinals</div>
        <div />
        <div>Championship Final</div>
      </div>

      <div className="grid grid-cols-[230px_50px_230px] items-stretch gap-y-6">
        {/* SF 1 */}
        <div className="flex flex-col justify-center">
          {sf1 && (
            <TreeMatchNode
              matchIndex="1"
              match={sf1}
              defaultSlotALabel="Seed #1 (Pool A 1st)"
              defaultSlotBLabel="Seed #4 (Pool B 2nd)"
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          )}
        </div>

        {/* Connector SF 1 & SF 2 -> Final */}
        <div className="row-span-2 flex items-center justify-center">
          <svg className="w-full h-full stroke-white/40 fill-none min-h-[180px]" strokeWidth="2">
            <path d="M 0 25% H 25 V 50% H 50" />
            <path d="M 0 75% H 25 V 50%" />
          </svg>
        </div>

        {/* Final */}
        <div className="row-span-2 flex flex-col justify-center">
          {finalMatch && (
            <TreeMatchNode
              matchIndex="Final"
              match={finalMatch}
              defaultSlotALabel="Winner Semifinal 1"
              defaultSlotBLabel="Winner Semifinal 2"
              isChampionship
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          )}
        </div>

        {/* SF 2 */}
        <div className="flex flex-col justify-center">
          {sf2 && (
            <TreeMatchNode
              matchIndex="2"
              match={sf2}
              defaultSlotALabel="Seed #2 (Pool B 1st)"
              defaultSlotBLabel="Seed #3 (Pool A 2nd)"
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          )}
        </div>
      </div>

      {bronzeMatch && (
        <div className="pt-4 border-t border-white/10 flex items-center justify-between bg-white/5 p-4 rounded-xl">
          <span className="text-xs font-mono uppercase tracking-widest text-brick font-bold">
            3rd Place Match
          </span>
          <div className="w-80">
            <TreeMatchNode
              matchIndex="Bronze"
              match={bronzeMatch}
              defaultSlotALabel="Runner-up SF 1"
              defaultSlotBLabel="Runner-up SF 2"
              highlightTeam={highlightTeam}
              onTeamTap={onTeamTap}
            />
          </div>
        </div>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// GENERIC COLUMN TREE (Fallback)
// ─────────────────────────────────────────────────────────────
function GenericColumnTree({
  bracketItems,
  highlightTeam,
  onTeamTap,
}: {
  bracketItems: KnockoutCardItem[];
  highlightTeam?: string | null | undefined;
  onTeamTap?: ((team: Team) => void) | undefined;
}) {
  const roundOrder = ["Round of 16", "Quarterfinal", "Semifinal", "Final", "Bronze"] as const;
  const activeRounds = roundOrder.filter((r) => bracketItems.some((m) => m.round === r));

  return (
    <div className="flex items-start gap-8 min-w-max">
      {activeRounds.map((roundName) => {
        const matches = bracketItems.filter((m) => m.round === roundName);
        return (
          <div key={roundName} className="w-64 space-y-4">
            <div className="border-b border-pickle pb-2 text-xs font-mono font-bold uppercase tracking-wider text-pickle">
              {roundName === "Final" ? "Championship Final" : roundName}
            </div>
            <div className="space-y-3">
              {matches.map((item, idx) => (
                <TreeMatchNode
                  key={item.id}
                  matchIndex={`${idx + 1}`}
                  match={item}
                  highlightTeam={highlightTeam}
                  onTeamTap={onTeamTap}
                />
              ))}
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// INDIVIDUAL MATCH NODE COMPONENT
// Styled exactly like the screenshot with match index & 2 slots
// ─────────────────────────────────────────────────────────────
function TreeMatchNode({
  matchIndex,
  match,
  defaultSlotALabel,
  defaultSlotBLabel,
  isChampionship = false,
  highlightTeam,
  onTeamTap,
}: {
  matchIndex: string;
  match: KnockoutCardItem;
  defaultSlotALabel?: string;
  defaultSlotBLabel?: string;
  isChampionship?: boolean;
  highlightTeam?: string | null | undefined;
  onTeamTap?: ((team: Team) => void) | undefined;
}) {
  const isLive = match.status === "live";
  const isDone = match.status === "final";
  const wonA = isDone && match.winnerTeamName && match.slotA.team?.name === match.winnerTeamName;
  const wonB = isDone && match.winnerTeamName && match.slotB.team?.name === match.winnerTeamName;

  const isHighlightedA = Boolean(
    highlightTeam && match.slotA.team && match.slotA.team.name.toLowerCase() === highlightTeam.toLowerCase()
  );
  const isHighlightedB = Boolean(
    highlightTeam && match.slotB.team && match.slotB.team.name.toLowerCase() === highlightTeam.toLowerCase()
  );

  return (
    <div
      className={`rounded-lg overflow-hidden border transition-all ${
        isLive
          ? "border-pickle shadow-md shadow-pickle/20 bg-black/60 ring-1 ring-pickle"
          : isChampionship
            ? "border-amber-400/70 bg-[#222421] shadow-sm"
            : "border-white/20 bg-[#1A1E1C] hover:border-white/40"
      } ${isHighlightedA || isHighlightedB ? "ring-2 ring-pickle" : ""}`}
    >
      <div className="flex items-stretch">
        {/* Match Index / Label on the Left (like 1, 2, 5, 3 in screenshot) */}
        <div className="w-6 shrink-0 bg-black/40 border-r border-white/10 flex items-center justify-center text-[0.65rem] font-mono font-bold text-sand/60">
          {matchIndex}
        </div>

        {/* Slots Container */}
        <div className="flex-1 min-w-0 divide-y divide-white/10">
          {/* Top Slot */}
          <SlotRow
            slot={match.slotA}
            defaultLabel={defaultSlotALabel}
            score={match.scoreA}
            isWinner={Boolean(wonA)}
            isLive={isLive}
            onTeamTap={onTeamTap}
          />

          {/* Bottom Slot */}
          <SlotRow
            slot={match.slotB}
            defaultLabel={defaultSlotBLabel}
            score={match.scoreB}
            isWinner={Boolean(wonB)}
            isLive={isLive}
            onTeamTap={onTeamTap}
          />
        </div>
      </div>
    </div>
  );
}

function SlotRow({
  slot,
  defaultLabel,
  score,
  isWinner,
  isLive,
  onTeamTap,
}: {
  slot: ProjectedSlot;
  defaultLabel?: string | undefined;
  score?: number | null | undefined;
  isWinner: boolean;
  isLive: boolean;
  onTeamTap?: ((team: Team) => void) | undefined;
}) {
  const isBye = slot.isBye;
  const isLocked = slot.isLocked && slot.team;
  const displayName = isLocked
    ? slot.team?.name
    : slot.provisionalTeamName
      ? `${slot.provisionalTeamName} (TBD)`
      : slot.label || defaultLabel || "TBD";

  return (
    <div
      onClick={() => isLocked && slot.team && onTeamTap?.(slot.team)}
      className={`flex items-center justify-between px-2.5 py-1.5 gap-2 text-xs transition-colors ${
        isWinner
          ? "bg-pickle/20 font-bold text-pickle"
          : isBye
            ? "bg-white/5 text-sand/40 italic"
            : "text-sand/90 hover:bg-white/5"
      } ${isLocked ? "cursor-pointer" : ""}`}
    >
      {/* Name and Seed details */}
      <div className="min-w-0 flex-1 flex items-center gap-1.5 truncate">
        {isBye ? (
          <span className="text-[0.62rem] font-mono px-1 py-0.2 rounded bg-white/10 text-sand/60 font-bold shrink-0">
            BYE
          </span>
        ) : (
          <span
            className={`text-[0.62rem] font-mono px-1 py-0.2 rounded shrink-0 font-bold ${
              isLocked
                ? "bg-pickle/25 text-pickle border border-pickle/40"
                : "bg-white/10 text-sand/60 border border-white/10"
            }`}
          >
            {isLocked ? `S#${slot.seedNum}` : "TBD"}
          </span>
        )}

        <span className={`truncate text-xs ${isWinner ? "font-bold text-pickle" : "text-sand"}`}>
          {displayName}
        </span>
      </div>

      {/* Score Box at the right end */}
      <div
        className={`w-6 h-6 shrink-0 rounded flex items-center justify-center font-mono text-xs font-bold ${
          typeof score === "number"
            ? isWinner
              ? "bg-pickle text-sand shadow-xs"
              : "bg-black/50 text-sand/80 border border-white/10"
            : isLive
              ? "bg-pickle/20 text-pickle border border-pickle/40"
              : "bg-black/30 text-sand/30 border border-white/5"
        }`}
      >
        {typeof score === "number" ? score : isBye ? "-" : ""}
      </div>
    </div>
  );
}

function PlaceholderNode({
  matchIndex,
  label,
  isChampionship = false,
}: {
  matchIndex: string;
  label: string;
  isChampionship?: boolean;
}) {
  return (
    <div
      className={`rounded-lg overflow-hidden border border-dashed p-3 text-center bg-black/20 ${
        isChampionship ? "border-amber-400/40 text-amber-300/60" : "border-white/10 text-sand/40"
      }`}
    >
      <div className="flex items-center justify-between text-[0.65rem] font-mono">
        <span className="font-bold text-sand/60">Match {matchIndex}</span>
        <span>TBD</span>
      </div>
      <p className="text-xs truncate font-mono mt-1 text-sand/60">{label}</p>
    </div>
  );
}

