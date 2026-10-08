import { useEffect } from "react";
import type { Category } from "@/data/tournaments";

/**
 * Step 2: Categories pop up as a bottom sheet.
 * Big buttons (at least 64px tall) showing category label and plain team count.
 * A "Playing Now" dot appears on categories with live matches.
 */
export function CategorySheet({
  open,
  onClose,
  tournamentName,
  categories,
  activeId,
  liveCategoryIds,
  onSelect,
}: {
  open: boolean;
  onClose: () => void;
  tournamentName: string;
  categories: Category[];
  activeId?: string;
  liveCategoryIds?: Set<string>;
  onSelect: (id: string) => void;
}) {
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    const prevOverflow = document.body.style.overflow;
    document.body.style.overflow = "hidden";
    window.addEventListener("keydown", onKey);
    return () => {
      document.body.style.overflow = prevOverflow;
      window.removeEventListener("keydown", onKey);
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-end justify-center sm:items-center sm:p-4"
      role="dialog"
      aria-modal="true"
      aria-labelledby="category-sheet-title"
    >
      {/* Backdrop */}
      <button
        type="button"
        aria-label="Close category list"
        onClick={onClose}
        className="absolute inset-0 bg-charcoal/75 backdrop-blur-sm cursor-default"
      />

      {/* Slide-up panel */}
      <div className="sheet-up relative w-full max-w-lg max-h-[85vh] overflow-hidden rounded-t-3xl sm:rounded-2xl bg-card border-t-4 sm:border-2 border-pickle shadow-2xl flex flex-col z-10">
        {/* Grab bar for mobile */}
        <div className="flex justify-center pt-3 pb-1 sm:hidden">
          <span className="h-1.5 w-12 rounded-full bg-sand/30" />
        </div>

        {/* Header */}
        <div className="px-5 pt-3 pb-4 sm:pt-5 border-b border-border">
          <span className="block text-xs font-bold uppercase tracking-[0.2em] text-pickle">
            Step 2 of 3
          </span>
          <h2
            id="category-sheet-title"
            className="mt-1 font-display text-2xl sm:text-3xl leading-tight text-foreground"
          >
            Select Category
          </h2>
          <p className="mt-1 text-sm text-foreground/75 truncate">
            {tournamentName}
          </p>
        </div>

        {/* Big Buttons List (at least 64px tall) */}
        <ul className="flex-1 overflow-y-auto px-4 py-4 space-y-3">
          {categories.map((c) => {
            const isActive = c.id === activeId;
            const isLive = liveCategoryIds?.has(c.id) ?? false;
            const teamCount = c.teams?.length ?? 0;

            return (
              <li key={c.id}>
                <button
                  type="button"
                  onClick={() => onSelect(c.id)}
                  className={`w-full min-h-[4.5rem] rounded-2xl border-2 px-4 py-3 text-left transition-all cursor-pointer flex items-center justify-between gap-3 ${
                    isActive
                      ? "border-pickle bg-pickle/15 shadow-sm"
                      : "border-border bg-background hover:border-pickle active:bg-pickle/10"
                  }`}
                >
                  <div className="min-w-0 flex-1">
                    <span className="block font-display text-xl sm:text-2xl leading-tight text-foreground truncate">
                      {c.label}
                    </span>
                    <span className="mt-1 block text-sm sm:text-base text-foreground/70 font-sans">
                      {teamCount} {teamCount === 1 ? "team" : "teams"} &middot; {c.level}
                    </span>
                  </div>

                  <div className="flex flex-col items-end gap-1.5 shrink-0">
                    {isLive && (
                      <span className="inline-flex items-center gap-1.5 rounded-full bg-pickle px-2.5 py-1 text-xs font-bold uppercase tracking-wide text-sand">
                        <span className="h-2 w-2 rounded-full bg-sand animate-pulse" />
                        Playing Now
                      </span>
                    )}
                    <span
                      className={`text-sm font-bold uppercase tracking-wider ${
                        isActive ? "text-pickle" : "text-foreground/60"
                      }`}
                    >
                      {isActive ? "Selected" : "Open"} &rsaquo;
                    </span>
                  </div>
                </button>
              </li>
            );
          })}
        </ul>

        {/* Footer Close */}
        <div className="border-t border-border p-4 pb-[max(1rem,env(safe-area-inset-bottom))] bg-card">
          <button
            type="button"
            onClick={onClose}
            className="w-full min-h-[3.25rem] rounded-xl border-2 border-border bg-charcoal text-sand text-sm font-bold uppercase tracking-wider hover:border-sand/40 cursor-pointer"
          >
            Cancel
          </button>
        </div>
      </div>
    </div>
  );
}
