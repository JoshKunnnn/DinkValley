import React, { useState, useEffect } from "react";
import { type LiveScore, type LiveMatch, computeCourtPositions } from "@/lib/match-store";

interface MiniCourtVisualizerProps {
  score: LiveScore;
  teamAName: string;
  teamBName: string;
  matchId?: string | undefined;
  teamAPlayers?: string[] | undefined;
  teamBPlayers?: string[] | undefined;
  teamABase1Player?: string | undefined;
  teamBBase1Player?: string | undefined;
  teamASide?: "left" | "right" | undefined;
  compact?: boolean;
}

function formatCourtPlayerName(name: string | undefined, compact: boolean): string {
  if (!name) return "";
  const trimmed = name.trim();
  if (!trimmed) return "";
  if (!compact || trimmed.length <= 12) return trimmed;
  const parts = trimmed.split(/\s+/);
  if (parts.length >= 2) {
    const first = parts[0]!;
    const last = parts[parts.length - 1]!;
    return `${first.charAt(0)}. ${last}`;
  }
  return trimmed;
}

export function MiniCourtVisualizer({
  score,
  teamAName,
  teamBName,
  matchId,
  teamAPlayers,
  teamBPlayers,
  teamABase1Player,
  teamBBase1Player,
  teamASide: propTeamASide,
  compact = false,
}: MiniCourtVisualizerProps) {
  const [localSide, setLocalSide] = useState<"left" | "right">(() => {
    if (propTeamASide === "left" || propTeamASide === "right") return propTeamASide;
    if (matchId && typeof localStorage !== "undefined") {
      const saved = localStorage.getItem(`dv_court_side_${matchId}`);
      if (saved === "right" || saved === "left") return saved;
    }
    return "left";
  });

  useEffect(() => {
    if (propTeamASide === "left" || propTeamASide === "right") {
      setLocalSide(propTeamASide);
      return;
    }
    if (matchId && typeof localStorage !== "undefined") {
      const saved = localStorage.getItem(`dv_court_side_${matchId}`);
      setLocalSide(saved === "right" ? "right" : "left");
    } else {
      setLocalSide("left");
    }
  }, [matchId, propTeamASide]);

  const handleToggleSide = () => {
    setLocalSide((prev) => {
      const next = prev === "left" ? "right" : "left";
      if (matchId && typeof localStorage !== "undefined") {
        try {
          localStorage.setItem(`dv_court_side_${matchId}`, next);
        } catch {
          // ignore
        }
      }
      return next;
    });
  };

  const effectiveTeamASide: "left" | "right" = propTeamASide ?? localSide;

  const courtPositions = computeCourtPositions({
    id: matchId || "temp",
    score,
    teamAName,
    teamBName,
    teamAPlayers,
    teamBPlayers,
    teamABase1Player,
    teamBBase1Player,
    teamASide: effectiveTeamASide,
    status: "live",
  } as LiveMatch);

  const teamAData = {
    teamName: teamAName,
    leftName: courtPositions.teamA.left.name === "-" ? "" : courtPositions.teamA.left.name,
    rightName: courtPositions.teamA.right.name === "-" ? "" : courtPositions.teamA.right.name,
    leftServing: courtPositions.teamA.left.isServing,
    rightServing: courtPositions.teamA.right.isServing,
    leftReceiving: courtPositions.teamA.left.isReceiver,
    rightReceiving: courtPositions.teamA.right.isReceiver,
  };

  const teamBData = {
    teamName: teamBName,
    leftName: courtPositions.teamB.left.name === "-" ? "" : courtPositions.teamB.left.name,
    rightName: courtPositions.teamB.right.name === "-" ? "" : courtPositions.teamB.right.name,
    leftServing: courtPositions.teamB.left.isServing,
    rightServing: courtPositions.teamB.right.isServing,
    leftReceiving: courtPositions.teamB.left.isReceiver,
    rightReceiving: courtPositions.teamB.right.isReceiver,
  };

  const leftSide = effectiveTeamASide === "right" ? teamBData : teamAData;
  const rightSide = effectiveTeamASide === "right" ? teamAData : teamBData;

  const isTeamAServing = score.servingTeam === "A";
  const servingTeamName = isTeamAServing ? teamAName : teamBName;
  const activeServerPlayer =
    (courtPositions.teamA.right.isServing ? courtPositions.teamA.right.name : "") ||
    (courtPositions.teamA.left.isServing ? courtPositions.teamA.left.name : "") ||
    (courtPositions.teamB.right.isServing ? courtPositions.teamB.right.name : "") ||
    (courtPositions.teamB.left.isServing ? courtPositions.teamB.left.name : "");

  const showServerPlayerInBanner =
    Boolean(activeServerPlayer) &&
    activeServerPlayer.trim().toLowerCase() !== servingTeamName.trim().toLowerCase();

  const isSingles = Boolean(courtPositions.teamA.isSingles || courtPositions.teamB.isSingles);
  const servingCourtInfo = isTeamAServing ? courtPositions.teamA : courtPositions.teamB;
  const isRightCourt = servingCourtInfo.right.isServing;

  return (
    <div className={`w-full overflow-hidden rounded border border-pickle/40 bg-[#16221D] ${compact ? "p-2" : "p-3 sm:p-4"}`}>
      {/* Top Banner: Service Call readout */}
      <div className="flex flex-wrap items-center justify-between gap-1.5 pb-2 mb-2 border-b border-white/15 text-[0.65rem] sm:text-[0.68rem] font-mono uppercase tracking-wider text-white">
        <span className="flex items-center gap-1.5 font-black text-emerald-400 min-w-0 truncate">
          <span className="relative flex h-2 w-2 shrink-0">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-emerald-400"></span>
          </span>
          <span className="truncate">
            Serving: {servingTeamName}
            {showServerPlayerInBanner ? ` (${formatCourtPlayerName(activeServerPlayer, true)})` : ""}
          </span>
        </span>
        <div className="flex items-center gap-1.5 shrink-0">
          <span className="px-2 py-0.5 rounded bg-black/80 border border-emerald-500/40 text-[0.6rem] sm:text-[0.62rem] font-black text-emerald-300">
            {isSingles ? "Server" : `Server ${score.serverNumber}`} &middot; {isRightCourt ? "Right Court" : "Left Court"}
          </span>
          <button
            type="button"
            onClick={handleToggleSide}
            className="px-1.5 py-0.5 rounded bg-charcoal/90 hover:bg-charcoal border border-sand/30 hover:border-pickle text-[0.55rem] sm:text-[0.6rem] font-mono font-bold text-sand/90 hover:text-pickle transition-colors cursor-pointer"
            title="Switch 2D Court Ends"
          >
            Flip Side
          </button>
        </div>
      </div>

      {/* 2D Overhead Pickleball Court */}
      <div className="relative mx-auto aspect-[22/10] w-full max-w-md rounded border-2 border-pickle/60 bg-[#1c2b24] shadow-inner select-none">
        {/* Center Net */}
        <div className="absolute top-0 bottom-0 left-1/2 w-1 -translate-x-1/2 bg-sand shadow-sm z-10">
          <div className="absolute -top-1 left-1/2 -translate-x-1/2 h-2 w-2 rounded-full bg-sand" />
          <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 h-2 w-2 rounded-full bg-sand" />
        </div>

        {/* Kitchen / Non-Volley Zone */}
        <div className="absolute top-0 bottom-0 left-[34%] right-[34%] bg-[#253930] border-x-2 border-pickle/50 flex items-center justify-center pointer-events-none">
          <span className="text-[0.5rem] sm:text-[0.62rem] font-mono tracking-widest text-pickle/60 font-bold uppercase rotate-90 sm:rotate-0">
            Kitchen (NVZ)
          </span>
        </div>

        {/* Left Side of 2D Court */}
        <div className="absolute top-0 bottom-0 left-0 right-[66%]">
          <div className="absolute left-0 right-0 top-1/2 h-[1.5px] -translate-y-1/2 bg-pickle/40" />

          {/* Left Team - Left Service Box (Top half: Odd Court) */}
          <div
            className={`absolute top-0 left-0 right-0 bottom-1/2 flex flex-col items-center justify-center px-1 py-0.5 text-center transition-colors ${
              leftSide.leftServing ? "bg-pickle/20" : leftSide.leftReceiving ? "bg-sand/10" : ""
            }`}
          >
            {leftSide.leftName && (
              <span className="max-w-full truncate text-[0.5rem] sm:text-[0.6rem] font-semibold text-sand/95 leading-tight">
                {formatCourtPlayerName(leftSide.leftName, compact)}
              </span>
            )}
            {leftSide.leftServing && (
              <div className="flex items-center gap-1 mt-0.5">
                <span className="w-2.5 h-2.5 rounded-full border border-dashed border-amber-300 inline-block shrink-0" />
                <span className="text-[0.5rem] sm:text-[0.55rem] font-bold text-pickle font-mono leading-none">
                  {isSingles ? "SRV" : `S${score.serverNumber}`}
                </span>
              </div>
            )}
            {leftSide.leftReceiving && (
              <div className="flex items-center gap-1 mt-0.5">
                <span className="w-2 h-2 rounded-full bg-sand text-charcoal flex items-center justify-center shrink-0 border border-charcoal/30">
                  <span className="w-1 h-1 rounded-full bg-pickle inline-block" />
                </span>
                <span className="px-1 rounded bg-sand/15 text-[0.46rem] sm:text-[0.5rem] font-bold text-sand/90 font-mono leading-tight">
                  RCV
                </span>
              </div>
            )}
          </div>

          {/* Left Team - Right Service Box (Bottom half: Even Court) */}
          <div
            className={`absolute bottom-0 left-0 right-0 top-1/2 flex flex-col items-center justify-center px-1 py-0.5 pb-3 text-center transition-colors ${
              leftSide.rightServing ? "bg-pickle/20" : leftSide.rightReceiving ? "bg-sand/10" : ""
            }`}
          >
            {leftSide.rightName && (
              <span className="max-w-full truncate text-[0.5rem] sm:text-[0.6rem] font-semibold text-sand/95 leading-tight">
                {formatCourtPlayerName(leftSide.rightName, compact)}
              </span>
            )}
            {leftSide.rightServing && (
              <div className="flex items-center gap-1 mt-0.5">
                <span className="w-2.5 h-2.5 rounded-full border border-dashed border-amber-300 inline-block shrink-0" />
                <span className="text-[0.5rem] sm:text-[0.55rem] font-bold text-pickle font-mono leading-none">
                  {isSingles ? "SRV" : `S${score.serverNumber}`}
                </span>
              </div>
            )}
            {leftSide.rightReceiving && (
              <div className="flex items-center gap-1 mt-0.5">
                <span className="w-2 h-2 rounded-full bg-sand text-charcoal flex items-center justify-center shrink-0 border border-charcoal/30">
                  <span className="w-1 h-1 rounded-full bg-pickle inline-block" />
                </span>
                <span className="px-1 rounded bg-sand/15 text-[0.46rem] sm:text-[0.5rem] font-bold text-sand/90 font-mono leading-tight">
                  RCV
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Right Side of 2D Court */}
        <div className="absolute top-0 bottom-0 right-0 left-[66%]">
          <div className="absolute left-0 right-0 top-1/2 h-[1.5px] -translate-y-1/2 bg-pickle/40" />

          {/* Right Team - Right Service Box (Top half when viewing from Right baseline) */}
          <div
            className={`absolute top-0 left-0 right-0 bottom-1/2 flex flex-col items-center justify-center px-1 py-0.5 pt-3 text-center transition-colors ${
              rightSide.rightServing ? "bg-pickle/20" : rightSide.rightReceiving ? "bg-sand/10" : ""
            }`}
          >
            {rightSide.rightName && (
              <span className="max-w-full truncate text-[0.5rem] sm:text-[0.6rem] font-semibold text-sand/95 leading-tight">
                {formatCourtPlayerName(rightSide.rightName, compact)}
              </span>
            )}
            {rightSide.rightServing && (
              <div className="flex items-center gap-1 mt-0.5">
                <span className="w-2.5 h-2.5 rounded-full border border-dashed border-amber-300 inline-block shrink-0" />
                <span className="text-[0.5rem] sm:text-[0.55rem] font-bold text-pickle font-mono leading-none">
                  {isSingles ? "SRV" : `S${score.serverNumber}`}
                </span>
              </div>
            )}
            {rightSide.rightReceiving && (
              <div className="flex items-center gap-1 mt-0.5">
                <span className="w-2 h-2 rounded-full bg-sand text-charcoal flex items-center justify-center shrink-0 border border-charcoal/30">
                  <span className="w-1 h-1 rounded-full bg-pickle inline-block" />
                </span>
                <span className="px-1 rounded bg-sand/15 text-[0.46rem] sm:text-[0.5rem] font-bold text-sand/90 font-mono leading-tight">
                  RCV
                </span>
              </div>
            )}
          </div>

          {/* Right Team - Left Service Box (Bottom half when viewing from Right baseline) */}
          <div
            className={`absolute bottom-0 left-0 right-0 top-1/2 flex flex-col items-center justify-center px-1 py-0.5 text-center transition-colors ${
              rightSide.leftServing ? "bg-pickle/20" : rightSide.leftReceiving ? "bg-sand/10" : ""
            }`}
          >
            {rightSide.leftName && (
              <span className="max-w-full truncate text-[0.5rem] sm:text-[0.6rem] font-semibold text-sand/95 leading-tight">
                {formatCourtPlayerName(rightSide.leftName, compact)}
              </span>
            )}
            {rightSide.leftServing && (
              <div className="flex items-center gap-1 mt-0.5">
                <span className="w-2.5 h-2.5 rounded-full border border-dashed border-amber-300 inline-block shrink-0" />
                <span className="text-[0.5rem] sm:text-[0.55rem] font-bold text-pickle font-mono leading-none">
                  {isSingles ? "SRV" : `S${score.serverNumber}`}
                </span>
              </div>
            )}
            {rightSide.leftReceiving && (
              <div className="flex items-center gap-1 mt-0.5">
                <span className="w-2 h-2 rounded-full bg-sand text-charcoal flex items-center justify-center shrink-0 border border-charcoal/30">
                  <span className="w-1 h-1 rounded-full bg-pickle inline-block" />
                </span>
                <span className="px-1 rounded bg-sand/15 text-[0.46rem] sm:text-[0.5rem] font-bold text-sand/90 font-mono leading-tight">
                  RCV
                </span>
              </div>
            )}
          </div>
        </div>

        {/* Team Labels along sidelines */}
        <div className="absolute left-1 bottom-0.5 text-[0.48rem] sm:text-[0.55rem] font-bold uppercase tracking-wider text-sand/75 truncate max-w-[32%] pointer-events-none">
          {leftSide.teamName}
        </div>
        <div className="absolute right-1 top-0.5 text-[0.48rem] sm:text-[0.55rem] font-bold uppercase tracking-wider text-sand/75 truncate max-w-[32%] text-right pointer-events-none">
          {rightSide.teamName}
        </div>
      </div>
    </div>
  );
}
