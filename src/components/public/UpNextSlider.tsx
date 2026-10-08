import { useRef, useState, useEffect } from "react";
import type { Team } from "@/data/tournaments";

export type UpNextMatchItem = {
  key: string;
  orderNumber: number;
  teamAName: string;
  teamBName: string;
  teamA?: Team | null | undefined;
  teamB?: Team | null | undefined;
  court?: string | null | undefined;
  round?: string | null | undefined;
  estimatedTime?: string | null | undefined;
};

interface UpNextSliderProps {
  matches: UpNextMatchItem[];
  highlightTeam?: string | null | undefined;
  onTeamTap?: ((team: Team) => void) | undefined;
  title?: string | undefined;
}

function formatCourtName(court?: string | null): string | null {
  if (!court || court.toLowerCase() === "queue") return null;
  const num = court.replace(/[^0-9]/g, "");
  return num ? `Court ${num}` : court;
}

export function UpNextSlider({
  matches,
  highlightTeam,
  onTeamTap,
  title = "Up Next in Queue",
}: UpNextSliderProps) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [canScrollLeft, setCanScrollLeft] = useState(false);
  const [canScrollRight, setCanScrollRight] = useState(false);

  const checkScroll = () => {
    const el = scrollRef.current;
    if (!el) return;
    setCanScrollLeft(el.scrollLeft > 10);
    setCanScrollRight(el.scrollLeft + el.clientWidth < el.scrollWidth - 10);
  };

  useEffect(() => {
    checkScroll();
    const el = scrollRef.current;
    if (!el) return;
    el.addEventListener("scroll", checkScroll, { passive: true });
    window.addEventListener("resize", checkScroll);
    return () => {
      el.removeEventListener("scroll", checkScroll);
      window.removeEventListener("resize", checkScroll);
    };
  }, [matches]);

  const scrollByAmount = (amount: number) => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollBy({ left: amount, behavior: "smooth" });
  };

  if (matches.length === 0) return null;

  return (
    <div className="surface-card p-3 sm:p-4 border-2 border-border rounded-2xl space-y-2.5">
      {/* Slider Header */}
      <div className="flex items-center justify-between gap-2">
        <div className="flex items-center gap-2 min-w-0">
          <span className="h-2 w-2 rounded-full bg-pickle shrink-0" />
          <h4 className="font-display text-base sm:text-lg text-foreground truncate">
            {title}
          </h4>
          <span className="px-2 py-0.5 text-[0.65rem] font-mono font-bold uppercase tracking-wider bg-charcoal text-sand rounded shrink-0">
            {matches.length} {matches.length === 1 ? "match" : "queued"}
          </span>
        </div>

        {/* Navigation Arrows */}
        <div className="flex items-center gap-1 shrink-0">
          <button
            type="button"
            onClick={() => scrollByAmount(-260)}
            disabled={!canScrollLeft}
            aria-label="Previous upcoming match"
            className={`w-8 h-8 rounded-lg border flex items-center justify-center font-bold text-sm transition-colors cursor-pointer ${
              canScrollLeft
                ? "border-border bg-card text-foreground hover:border-pickle hover:text-pickle"
                : "border-border/40 bg-background text-muted-foreground/40 cursor-not-allowed"
            }`}
          >
            &larr;
          </button>
          <button
            type="button"
            onClick={() => scrollByAmount(260)}
            disabled={!canScrollRight}
            aria-label="Next upcoming match"
            className={`w-8 h-8 rounded-lg border flex items-center justify-center font-bold text-sm transition-colors cursor-pointer ${
              canScrollRight
                ? "border-border bg-card text-foreground hover:border-pickle hover:text-pickle"
                : "border-border/40 bg-background text-muted-foreground/40 cursor-not-allowed"
            }`}
          >
            &rarr;
          </button>
        </div>
      </div>

      {/* Horizontal Carousel Track */}
      <div
        ref={scrollRef}
        className="flex gap-2.5 overflow-x-auto pb-1.5 pt-0.5 scroll-smooth snap-x snap-mandatory no-scrollbar"
        style={{ scrollbarWidth: "none", msOverflowStyle: "none" }}
      >
        {matches.map((m) => {
          const isHighlight =
            Boolean(highlightTeam) &&
            (m.teamAName === highlightTeam || m.teamBName === highlightTeam);
          const formattedCourt = formatCourtName(m.court);

          return (
            <div
              key={m.key}
              className={`w-[240px] sm:w-[260px] shrink-0 snap-start p-3 rounded-xl border-2 transition-all flex flex-col justify-between ${
                isHighlight
                  ? "border-pickle bg-pickle/15 ring-2 ring-pickle/40"
                  : "border-border/80 bg-background hover:border-pickle/60"
              }`}
            >
              {/* Card Meta: Order and Court */}
              <div className="flex items-center justify-between text-[0.65rem] uppercase tracking-wider mb-2">
                <span className="font-mono font-bold text-muted-foreground">
                  #{m.orderNumber} in Queue
                </span>
                {formattedCourt ? (
                  <span className="px-2 py-0.5 font-mono font-bold text-pickle bg-pickle/20 border border-pickle/40 rounded">
                    {formattedCourt}
                  </span>
                ) : (
                  <span className="px-1.5 py-0.5 font-mono text-[0.6rem] text-muted-foreground bg-card border border-border rounded">
                    Standby
                  </span>
                )}
              </div>

              {/* Teams List (Compact) */}
              <div className="space-y-1 text-xs sm:text-sm">
                <div
                  onClick={() => m.teamA && onTeamTap?.(m.teamA)}
                  className={`px-2 py-1 rounded truncate flex items-center justify-between ${
                    m.teamAName === highlightTeam
                      ? "bg-pickle text-sand font-bold"
                      : "text-foreground font-semibold"
                  } ${m.teamA ? "cursor-pointer hover:bg-pickle/10" : ""}`}
                >
                  <span className="truncate">{m.teamAName}</span>
                </div>
                <div className="text-[0.6rem] uppercase tracking-widest text-muted-foreground/60 px-2 font-mono">
                  vs
                </div>
                <div
                  onClick={() => m.teamB && onTeamTap?.(m.teamB)}
                  className={`px-2 py-1 rounded truncate flex items-center justify-between ${
                    m.teamBName === highlightTeam
                      ? "bg-pickle text-sand font-bold"
                      : "text-foreground font-semibold"
                  } ${m.teamB ? "cursor-pointer hover:bg-pickle/10" : ""}`}
                >
                  <span className="truncate">{m.teamBName}</span>
                </div>
              </div>

              {m.round && (
                <div className="mt-2 pt-1.5 border-t border-border/40 text-[0.6rem] text-muted-foreground font-mono uppercase tracking-wider truncate">
                  {m.round}
                </div>
              )}
            </div>
          );
        })}
      </div>
    </div>
  );
}
