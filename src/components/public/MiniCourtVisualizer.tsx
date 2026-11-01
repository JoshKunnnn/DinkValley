import React, { useState, useEffect } from "react";
import { type LiveScore, deriveActiveServerBase } from "@/lib/match-store";

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
  const isTeamAServing = score.servingTeam === "A";
  const teamAScoreEven = score.teamAScore % 2 === 0;
  const teamBScoreEven = score.teamBScore % 2 === 0;

  const rawAPlayers = teamAPlayers && teamAPlayers.length > 0 ? teamAPlayers : [];
  const rawBPlayers = teamBPlayers && teamBPlayers.length > 0 ? teamBPlayers : [];
  const isSingles = rawAPlayers.length === 1 && rawBPlayers.length === 1;

  const localBase1A =
    matchId && typeof localStorage !== "undefined"
      ? localStorage.getItem(`dv_base1_A_${matchId}`)
      : null;
  const aBase1 =
    teamABase1Player ||
    (localBase1A && rawAPlayers.includes(localBase1A) ? localBase1A : rawAPlayers[0]) ||
    "";
  const aBase2 = rawAPlayers.find((p) => p !== aBase1) || rawAPlayers[1] || aBase1;

  const localBase1B =
    matchId && typeof localStorage !== "undefined"
      ? localStorage.getItem(`dv_base1_B_${matchId}`)
      : null;
  const bBase1 =
    teamBBase1Player ||
    (localBase1B && rawBPlayers.includes(localBase1B) ? localBase1B : rawBPlayers[0]) ||
    "";
  const bBase2 = rawBPlayers.find((p) => p !== bBase1) || rawBPlayers[1] || bBase1;

  // In pickleball doubles:
  // Base 1 is on Right court when score is even, Left court when odd.
  // Base 2 is on Right court when score is odd, Left court when even.
  const aRightBase: 1 | 2 = teamAScoreEven ? 1 : 2;
  const aRightName = isSingles
    ? teamAScoreEven ? aBase1 : ""
    : teamAScoreEven ? aBase1 : aBase2;
  const aLeftName = isSingles
    ? !teamAScoreEven ? aBase1 : ""
    : teamAScoreEven ? aBase2 : aBase1;

  const bRightBase: 1 | 2 = teamBScoreEven ? 1 : 2;
  const bRightName = isSingles
    ? teamBScoreEven ? bBase1 : ""
    : teamBScoreEven ? bBase1 : bBase2;
  const bLeftName = isSingles
    ? !teamBScoreEven ? bBase1 : ""
    : teamBScoreEven ? bBase2 : bBase1;

  const activeServerBase = deriveActiveServerBase(score);
  const isRightCourt = isSingles
    ? isTeamAServing ? teamAScoreEven : teamBScoreEven
    : isTeamAServing
      ? aRightBase === activeServerBase
      : bRightBase === activeServerBase;

  const aLeftServing = isTeamAServing && !isRightCourt;
  const aRightServing = isTeamAServing && isRightCourt;
  const bRightServing = !isTeamAServing && isRightCourt;
  const bLeftServing = !isTeamAServing && !isRightCourt;

  const aLeftReceiving = !isTeamAServing && !isRightCourt;
  const aRightReceiving = !isTeamAServing && isRightCourt;
  const bRightReceiving = isTeamAServing && isRightCourt;
  const bLeftReceiving = isTeamAServing && !isRightCourt;

  const teamAData = {
    teamName: teamAName,
    leftName: aLeftName,
    rightName: aRightName,
    leftServing: aLeftServing,
    rightServing: aRightServing,
    leftReceiving: aLeftReceiving,
    rightReceiving: aRightReceiving,
  };

  const teamBData = {
    teamName: teamBName,
    leftName: bLeftName,
    rightName: bRightName,
    leftServing: bLeftServing,
    rightServing: bRightServing,
    leftReceiving: bLeftReceiving,
    rightReceiving: bRightReceiving,
  };

  const leftSide = effectiveTeamASide === "right" ? teamBData : teamAData;
  const rightSide = effectiveTeamASide === "right" ? teamAData : teamBData;

  const servingTeamName = isTeamAServing ? teamAName : teamBName;
  const activeServerPlayer = isTeamAServing
    ? isRightCourt ? aRightName : aLeftName
    : isRightCourt ? bRightName : bLeftName;
  const showServerPlayerInBanner =
    Boolean(activeServerPlayer) &&
    activeServerPlayer.trim().toLowerCase() !== servingTeamName.trim().toLowerCase();

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
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-pickle opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-pickle shadow"></span>
                </span>
                <span className="text-[0.5rem] sm:text-[0.55rem] font-bold text-pickle font-mono leading-none">
                  {isSingles ? "SRV" : `S${score.serverNumber}`}
                </span>
              </div>
            )}
            {leftSide.leftReceiving && (
              <span className="mt-0.5 px-1 rounded bg-sand/15 text-[0.46rem] sm:text-[0.5rem] font-bold text-sand/90 font-mono leading-tight">
                RCV
              </span>
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
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-pickle opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-pickle shadow"></span>
                </span>
                <span className="text-[0.5rem] sm:text-[0.55rem] font-bold text-pickle font-mono leading-none">
                  {isSingles ? "SRV" : `S${score.serverNumber}`}
                </span>
              </div>
            )}
            {leftSide.rightReceiving && (
              <span className="mt-0.5 px-1 rounded bg-sand/15 text-[0.46rem] sm:text-[0.5rem] font-bold text-sand/90 font-mono leading-tight">
                RCV
              </span>
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
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-pickle opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-pickle shadow"></span>
                </span>
                <span className="text-[0.5rem] sm:text-[0.55rem] font-bold text-pickle font-mono leading-none">
                  {isSingles ? "SRV" : `S${score.serverNumber}`}
                </span>
              </div>
            )}
            {rightSide.rightReceiving && (
              <span className="mt-0.5 px-1 rounded bg-sand/15 text-[0.46rem] sm:text-[0.5rem] font-bold text-sand/90 font-mono leading-tight">
                RCV
              </span>
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
                <span className="relative flex h-2.5 w-2.5 shrink-0">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-pickle opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-pickle shadow"></span>
                </span>
                <span className="text-[0.5rem] sm:text-[0.55rem] font-bold text-pickle font-mono leading-none">
                  {isSingles ? "SRV" : `S${score.serverNumber}`}
                </span>
              </div>
            )}
            {rightSide.leftReceiving && (
              <span className="mt-0.5 px-1 rounded bg-sand/15 text-[0.46rem] sm:text-[0.5rem] font-bold text-sand/90 font-mono leading-tight">
                RCV
              </span>
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
