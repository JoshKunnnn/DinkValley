import React from "react";
import type { LiveScore } from "@/lib/match-store";

interface MiniCourtVisualizerProps {
  score: LiveScore;
  teamAName: string;
  teamBName: string;
  compact?: boolean;
}

export function MiniCourtVisualizer({
  score,
  teamAName,
  teamBName,
  compact = false,
}: MiniCourtVisualizerProps) {
  const isTeamAServing = score.servingTeam === "A";
  const servingScore = isTeamAServing ? score.teamAScore : score.teamBScore;
  // In pickleball doubles, even score serves from right court, odd from left
  const isRightCourt = servingScore % 2 === 0;

  return (
    <div className={`w-full overflow-hidden rounded border border-pickle/40 bg-[#16221D] ${compact ? "p-2" : "p-3 sm:p-4"}`}>
      {/* Top Banner: Service Call readout */}
      <div className="flex items-center justify-between pb-2 mb-2 border-b border-border/40 text-[0.65rem] font-mono uppercase tracking-wider text-sand">
        <span className="flex items-center gap-1.5 font-bold text-pickle">
          <span className="relative flex h-2 w-2">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-pickle opacity-75"></span>
            <span className="relative inline-flex rounded-full h-2 w-2 bg-pickle"></span>
          </span>
          Serving: {isTeamAServing ? teamAName : teamBName}
        </span>
        <span className="px-1.5 py-0.5 rounded bg-charcoal border border-border text-[0.6rem] font-bold">
          Server {score.serverNumber} &middot; {isRightCourt ? "Right (Even)" : "Left (Odd)"}
        </span>
      </div>

      {/* 2D Overhead Pickleball Court */}
      <div className="relative mx-auto aspect-[22/10] w-full max-w-md rounded border-2 border-pickle/60 bg-[#1c2b24] shadow-inner select-none">
        {/* Baseline A (Left) & Baseline B (Right) */}

        {/* Center Net */}
        <div className="absolute top-0 bottom-0 left-1/2 w-1 -translate-x-1/2 bg-sand shadow-sm z-10">
          {/* Net posts */}
          <div className="absolute -top-1 left-1/2 -translate-x-1/2 h-2 w-2 rounded-full bg-sand" />
          <div className="absolute -bottom-1 left-1/2 -translate-x-1/2 h-2 w-2 rounded-full bg-sand" />
        </div>

        {/* Kitchen / Non-Volley Zone (7ft both sides of net = 31.8% of total 44ft) */}
        <div className="absolute top-0 bottom-0 left-[34%] right-[34%] bg-[#253930] border-x-2 border-pickle/50 flex items-center justify-center pointer-events-none">
          <span className="text-[0.55rem] sm:text-[0.65rem] font-mono tracking-widest text-pickle/60 font-bold uppercase rotate-90 sm:rotate-0">
            Kitchen (NVZ)
          </span>
        </div>

        {/* Left Side (Team A Court Area) */}
        <div className="absolute top-0 bottom-0 left-0 right-[66%]">
          {/* Center line dividing left and right service boxes */}
          <div className="absolute left-0 right-0 top-1/2 h-[1.5px] -translate-y-1/2 bg-pickle/40" />

          {/* Team A - Left Service Box (Top half: Odd Court) */}
          <div
            className={`absolute top-0 left-0 right-0 bottom-1/2 flex items-center justify-center p-1 transition-colors ${
              isTeamAServing && !isRightCourt ? "bg-pickle/15" : ""
            }`}
          >
            {isTeamAServing && !isRightCourt && (
              <div className="flex items-center gap-1">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-pickle opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-pickle shadow"></span>
                </span>
                <span className="text-[0.55rem] font-bold text-pickle font-mono">S{score.serverNumber}</span>
              </div>
            )}
          </div>

          {/* Team A - Right Service Box (Bottom half: Even Court) */}
          <div
            className={`absolute bottom-0 left-0 right-0 top-1/2 flex items-center justify-center p-1 transition-colors ${
              isTeamAServing && isRightCourt ? "bg-pickle/15" : ""
            }`}
          >
            {isTeamAServing && isRightCourt && (
              <div className="flex items-center gap-1">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-pickle opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-pickle shadow"></span>
                </span>
                <span className="text-[0.55rem] font-bold text-pickle font-mono">S{score.serverNumber}</span>
              </div>
            )}
          </div>
        </div>

        {/* Right Side (Team B Court Area) */}
        <div className="absolute top-0 bottom-0 right-0 left-[66%]">
          {/* Center line dividing left and right service boxes */}
          <div className="absolute left-0 right-0 top-1/2 h-[1.5px] -translate-y-1/2 bg-pickle/40" />

          {/* Team B - Left Service Box (Bottom half when viewing from Team B baseline) */}
          <div
            className={`absolute bottom-0 left-0 right-0 top-1/2 flex items-center justify-center p-1 transition-colors ${
              !isTeamAServing && !isRightCourt ? "bg-pickle/15" : ""
            }`}
          >
            {!isTeamAServing && !isRightCourt && (
              <div className="flex items-center gap-1">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-pickle opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-pickle shadow"></span>
                </span>
                <span className="text-[0.55rem] font-bold text-pickle font-mono">S{score.serverNumber}</span>
              </div>
            )}
          </div>

          {/* Team B - Right Service Box (Top half when viewing from Team B baseline) */}
          <div
            className={`absolute top-0 left-0 right-0 bottom-1/2 flex items-center justify-center p-1 transition-colors ${
              !isTeamAServing && isRightCourt ? "bg-pickle/15" : ""
            }`}
          >
            {!isTeamAServing && isRightCourt && (
              <div className="flex items-center gap-1">
                <span className="relative flex h-3 w-3">
                  <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-pickle opacity-75"></span>
                  <span className="relative inline-flex rounded-full h-3 w-3 bg-pickle shadow"></span>
                </span>
                <span className="text-[0.55rem] font-bold text-pickle font-mono">S{score.serverNumber}</span>
              </div>
            )}
          </div>
        </div>

        {/* Team Labels along sidelines */}
        <div className="absolute left-1 bottom-1 text-[0.55rem] font-bold uppercase tracking-wider text-sand/80 truncate max-w-[30%]">
          {teamAName}
        </div>
        <div className="absolute right-1 top-1 text-[0.55rem] font-bold uppercase tracking-wider text-sand/80 truncate max-w-[30%] text-right">
          {teamBName}
        </div>
      </div>
    </div>
  );
}
