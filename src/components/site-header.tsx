import { Link, useRouterState } from "@tanstack/react-router";
import { useState, useEffect, useRef } from "react";
import { getAuthenticatedStaff, logoutStaff, type StaffRole } from "@/lib/auth-store";
import { StaffPortalModal } from "./admin/StaffPortalModal";

export function SiteHeader() {
  const [authRole, setAuthRole] = useState<StaffRole | null>(null);
  const [userName, setUserName] = useState<string | null>(null);
  const [showStaffModal, setShowStaffModal] = useState(false);

  const tapCountRef = useRef(0);
  const tapTimerRef = useRef<NodeJS.Timeout | null>(null);

  useEffect(() => {
    const checkAuth = () => {
      const staff = getAuthenticatedStaff();
      if (staff) {
        setAuthRole(staff.role);
        setUserName(staff.name);
      } else {
        setAuthRole(null);
        setUserName(null);
      }
    };

    checkAuth();
    window.addEventListener("storage", checkAuth);
    window.addEventListener("dv_auth_changed", checkAuth);

    const handleOpenPortal = () => setShowStaffModal(true);
    window.addEventListener("dv_open_staff_portal", handleOpenPortal);

    return () => {
      window.removeEventListener("storage", checkAuth);
      window.removeEventListener("dv_auth_changed", checkAuth);
      window.removeEventListener("dv_open_staff_portal", handleOpenPortal);
    };
  }, []);

  const handleLogout = () => {
    logoutStaff();
    setAuthRole(null);
    setUserName(null);
  };

  /**
   * Quadruple-tap detection on Dink Valley logo:
   * Tapping or clicking the club logo 4 times rapidly within 1.8 seconds unlocks the hidden staff portal.
   */
  const handleLogoTap = (e: React.MouseEvent) => {
    tapCountRef.current += 1;
    if (tapTimerRef.current) {
      clearTimeout(tapTimerRef.current);
    }

    if (tapCountRef.current >= 4) {
      e.preventDefault();
      e.stopPropagation();
      tapCountRef.current = 0;
      setShowStaffModal(true);
      return;
    }

    tapTimerRef.current = setTimeout(() => {
      tapCountRef.current = 0;
    }, 1800);
  };

  return (
    <>
      <header className="sticky top-0 z-50 border-b border-border bg-charcoal/95 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
          {/* Logo with Quadruple-Tap Detection */}
          <Link
            to="/"
            onClick={handleLogoTap}
            className="flex items-center gap-2.5 min-w-0 select-none group cursor-pointer"
            title="Dink Valley Pickleball Club"
          >
            <img
              src="/DinkValley.jpg"
              alt="Dink Valley pickleball club logo"
              className="h-9 w-9 flex-shrink-0 rounded-full object-cover sm:h-11 sm:w-11 transition-transform active:scale-95"
            />
            <span className="font-display text-xl leading-none text-sand sm:text-2xl">
              Dink Valley
              <span className="block font-sans text-[0.55rem] uppercase tracking-[0.28em] text-pickle sm:text-[0.6rem]">
                Pickleball Club
              </span>
            </span>
          </Link>

          {/* Desktop nav - Cleaned of public admin/register buttons */}
          <nav className="hidden items-center gap-3 text-sm font-semibold uppercase tracking-wide sm:flex">
            <Link
              to="/"
              activeOptions={{ exact: true }}
              className="rounded px-3 py-2 text-sand/80 transition-colors hover:text-sand"
              activeProps={{ className: "text-sand font-bold" }}
            >
              Tournaments
            </Link>

            {/* Authenticated Staff Badge (Only appears once official logs in via hidden portal) */}
            {authRole && (
              <div className="flex items-center gap-2 pl-2 border-l border-border/60">
                <Link
                  to={authRole === "admin" ? "/admin" : "/umpire"}
                  className="flex items-center gap-2 rounded bg-primary px-3.5 py-2 text-xs font-bold uppercase tracking-wider text-primary-foreground transition-colors hover:bg-brick-deep shadow-sm"
                >
                  <span className="h-2 w-2 rounded-full bg-pickle animate-pulse" />
                  <span>{authRole === "admin" ? "Admin Console" : "Umpire Console"}</span>
                </Link>

                <button
                  onClick={handleLogout}
                  className="px-2.5 py-2 text-xs font-bold uppercase tracking-wider text-sand/60 hover:text-sand transition-colors cursor-pointer"
                  title="Sign out of current account"
                >
                  Sign Out
                </button>
              </div>
            )}
          </nav>

          {/* Mobile nav - Cleaned of public sign-in/register buttons */}
          <div className="flex items-center gap-2 sm:hidden">
            <Link
              to="/"
              activeOptions={{ exact: true }}
              className="rounded px-2.5 py-1.5 text-xs font-bold uppercase tracking-wider text-sand/80 transition-colors hover:text-sand"
              activeProps={{ className: "text-sand" }}
            >
              Tournaments
            </Link>

            {authRole && (
              <div className="flex items-center gap-1.5">
                <Link
                  to={authRole === "admin" ? "/admin" : "/umpire"}
                  className="flex items-center gap-1.5 rounded bg-primary px-2.5 py-1.5 text-xs font-bold uppercase tracking-wider text-primary-foreground transition-colors hover:bg-brick-deep"
                >
                  <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-pulse" />
                  <span>{authRole === "admin" ? "Admin" : "Umpire"}</span>
                </Link>
                <button
                  onClick={handleLogout}
                  className="px-1.5 py-1.5 text-[0.65rem] font-bold uppercase tracking-wider text-sand/50 hover:text-sand transition-colors cursor-pointer"
                >
                  Exit
                </button>
              </div>
            )}
          </div>
        </div>
      </header>

      {/* Hidden Staff Portal Modal */}
      <StaffPortalModal
        isOpen={showStaffModal}
        onClose={() => setShowStaffModal(false)}
      />
    </>
  );
}

export function SiteFooter() {
  const pathname = useRouterState({
    select: (s) => s.location.pathname,
  });
  const isConsole = pathname.startsWith("/admin") || pathname.startsWith("/umpire");

  return (
    <footer
      className={`border-border bg-charcoal py-8 ${
        isConsole ? "mt-0 border-t-0" : "mt-20 border-t"
      }`}
    >
      <div className="mx-auto flex max-w-6xl flex-col sm:flex-row sm:items-center sm:justify-between gap-4 px-5 text-sm text-sand/70">
        <div>
          <span className="font-display text-xl text-sand block">Dink Valley Pickleball Club</span>
          <span>Santiago City, Philippines &middot; Courts open daily 6AM - 10PM</span>
        </div>
        <div className="text-xs text-sand/40 font-mono">
          Tournament Official System &middot; Santiago City
        </div>
      </div>
    </footer>
  );
}
