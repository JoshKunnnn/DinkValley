/**
 * UmpireMobileNav
 * Bottom bar for the Umpire Console on mobile (< sm breakpoint).
 * Mirrors the 3 horizontal tabs: Live Console, Tournament Desk, Live Scoreboard.
 * Also provides Sign Out.
 *
 * Props must be wired to the same state as the existing horizontal tabs — no logic change.
 */

import {
  Swords,
  LayoutDashboard,
  Tv2,
  LogOut,
} from "lucide-react";

type UmpireTab = "desk" | "console" | "scoreboard";

interface UmpireMobileNavProps {
  activeTab: UmpireTab;
  onTabChange: (tab: UmpireTab) => void;
  selectedMatchCourt?: string | null;
  onLogout: () => void;
}

const UMPIRE_TABS: {
  key: UmpireTab;
  label: string;
  icon: React.ElementType;
}[] = [
  { key: "desk", label: "Desk", icon: LayoutDashboard },
  { key: "console", label: "Console", icon: Swords },
  { key: "scoreboard", label: "Scores", icon: Tv2 },
];

export function UmpireMobileNav({
  activeTab,
  onTabChange,
  selectedMatchCourt,
  onLogout,
}: UmpireMobileNavProps) {
  return (
    <nav
      role="navigation"
      aria-label="Umpire mobile navigation"
      className="fixed bottom-0 inset-x-0 z-50 sm:hidden"
    >
      {/* Gradient fade at top edge */}
      <div className="absolute inset-x-0 -top-4 h-4 bg-gradient-to-t from-charcoal/60 to-transparent pointer-events-none" />

      <div
        className="
          relative
          bg-charcoal/96 backdrop-blur-md
          border-t border-white/10
          grid grid-cols-4
          pb-[env(safe-area-inset-bottom,0.75rem)]
        "
        style={{ boxShadow: "0 -4px 24px rgba(0,0,0,0.5)" }}
      >
        {UMPIRE_TABS.map(({ key, label, icon: Icon }) => {
          const isActive = activeTab === key;
          // Show assigned court badge when a match is selected in console tab
          const showCourtBadge = key === "console" && selectedMatchCourt && isActive;

          return (
            <button
              key={key}
              id={`umpire-nav-${key}`}
              aria-label={label}
              aria-pressed={isActive}
              onClick={() => {
                onTabChange(key);
                window.scrollTo({ top: 0, behavior: "smooth" });
              }}
              className="relative flex flex-col items-center justify-center gap-1 pt-3 pb-1 cursor-pointer select-none transition-all"
            >
              {/* Active pill indicator */}
              {isActive && (
                <span
                  className="absolute top-0 left-1/2 -translate-x-1/2 h-0.5 w-8 bg-pickle rounded-full"
                  style={{ boxShadow: "0 0 6px rgba(34,197,94,0.7)" }}
                />
              )}

              {/* Court badge on Console tab */}
              {showCourtBadge && (
                <span className="absolute top-2 right-[calc(50%-1.25rem)] px-1 h-4 flex items-center justify-center bg-pickle/20 border border-pickle/40 text-pickle text-[0.5rem] font-bold font-mono rounded-sm">
                  {selectedMatchCourt}
                </span>
              )}

              <Icon
                size={20}
                strokeWidth={isActive ? 2.5 : 1.5}
                className={
                  isActive
                    ? "text-pickle drop-shadow-[0_0_4px_rgba(34,197,94,0.7)] transition-colors"
                    : "text-sand/50 transition-colors"
                }
              />
              <span
                className={`text-[0.6rem] font-bold uppercase tracking-wider leading-none transition-colors ${
                  isActive ? "text-pickle" : "text-sand/50"
                }`}
              >
                {label}
              </span>
            </button>
          );
        })}

        {/* Sign Out */}
        <button
          id="umpire-nav-logout"
          aria-label="Sign out"
          onClick={onLogout}
          className="relative flex flex-col items-center justify-center gap-1 pt-3 pb-1 cursor-pointer select-none transition-all"
        >
          <LogOut size={20} strokeWidth={1.5} className="text-sand/40 hover:text-brick transition-colors" />
          <span className="text-[0.6rem] font-bold uppercase tracking-wider leading-none text-sand/40">
            Exit
          </span>
        </button>
      </div>
    </nav>
  );
}
