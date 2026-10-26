/**
 * AdminMobileNav
 * Bottom bar for the Admin Console on mobile (< md breakpoint).
 * Mirrors the 4 sidebar tabs exactly: Draw, Dispatch, Setup, Teams & Payments.
 * Also provides a Sign Out action.
 *
 * Props must be wired to the same state as the desktop sidebar — no logic change.
 */

import { Link } from "@tanstack/react-router";
import {
  Layers,
  Radio,
  Settings,
  Users,
  UserCheck,
  KeyRound,
  Home,
  LogOut,
} from "lucide-react";

type AdminTabKey = "draw" | "dispatch" | "setup" | "teams" | "masterlist" | "access-codes";

interface AdminMobileNavProps {
  activeTab: AdminTabKey;
  onTabChange: (tab: AdminTabKey) => void;
  onLogout: () => void;
}

const ADMIN_TABS: {
  key: AdminTabKey;
  label: string;
  icon: React.ElementType;
}[] = [
    { key: "draw", label: "Draw", icon: Layers },
    { key: "dispatch", label: "Dispatch", icon: Radio },
    { key: "setup", label: "Setup", icon: Settings },
    { key: "teams", label: "Teams", icon: Users },
    { key: "masterlist", label: "Users", icon: UserCheck },
    { key: "access-codes", label: "Codes", icon: KeyRound },
  ];

export function AdminMobileNav({
  activeTab,
  onTabChange,
  onLogout,
}: AdminMobileNavProps) {
  return (
    <nav
      role="navigation"
      aria-label="Admin mobile navigation"
      className="fixed bottom-0 inset-x-0 z-50 md:hidden"
    >
      {/* Gradient fade at top edge */}
      <div className="absolute inset-x-0 -top-4 h-4 bg-gradient-to-t from-charcoal/60 to-transparent pointer-events-none" />

      <div
        className="
          relative
          bg-charcoal/96 backdrop-blur-md
          border-t border-white/10
          grid grid-cols-8 px-0.5
          pb-[env(safe-area-inset-bottom,0.75rem)]
        "
        style={{ boxShadow: "0 -4px 24px rgba(0,0,0,0.5)" }}
      >
        {/* 4 main tab buttons */}
        {ADMIN_TABS.map(({ key, label, icon: Icon }) => {
          const isActive = activeTab === key;

          return (
            <button
              key={key}
              id={`admin-nav-${key}`}
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
                  className="absolute top-0 left-1/2 -translate-x-1/2 h-0.5 w-8 bg-brick rounded-full"
                  style={{ boxShadow: "0 0 6px rgba(185,55,35,0.7)" }}
                />
              )}

              <Icon
                size={20}
                strokeWidth={isActive ? 2.5 : 1.5}
                className={
                  isActive
                    ? "text-brick drop-shadow-[0_0_4px_rgba(185,55,35,0.7)] transition-colors"
                    : "text-sand/50 transition-colors"
                }
              />
              <span
                className={`text-[0.6rem] font-bold uppercase tracking-wider leading-none transition-colors ${isActive ? "text-brick" : "text-sand/50"
                  }`}
              >
                {label}
              </span>
            </button>
          );
        })}

        {/* Back to site */}
        <Link
          to="/"
          id="admin-nav-home"
          aria-label="Back to public site"
          className="relative flex flex-col items-center justify-center gap-1 pt-3 pb-1 cursor-pointer select-none transition-all"
        >
          <Home size={20} strokeWidth={1.5} className="text-sand/50 transition-colors" />
          <span className="text-[0.6rem] font-bold uppercase tracking-wider leading-none text-sand/50">
            Site
          </span>
        </Link>

        {/* Sign Out */}
        <button
          id="admin-nav-logout"
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
