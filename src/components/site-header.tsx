import { Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";

export function SiteHeader() {
  const [authRole, setAuthRole] = useState<"admin" | "umpire" | null>(null);
  const [userName, setUserName] = useState<string | null>(null);

  useEffect(() => {
    const checkAuth = () => {
      if (typeof window === "undefined") return;
      const isAdmin = localStorage.getItem("mock_auth") === "true";
      const isUmpire = localStorage.getItem("mock_umpire_auth") === "true";

      if (isAdmin) {
        setAuthRole("admin");
        setUserName(localStorage.getItem("mock_admin_name") ?? "Organizer");
      } else if (isUmpire) {
        setAuthRole("umpire");
        setUserName(localStorage.getItem("mock_umpire_name") ?? "Official");
      } else {
        setAuthRole(null);
        setUserName(null);
      }
    };

    checkAuth();
    window.addEventListener("storage", checkAuth);
    const interval = setInterval(checkAuth, 2000);

    return () => {
      window.removeEventListener("storage", checkAuth);
      clearInterval(interval);
    };
  }, []);

  const handleLogout = () => {
    localStorage.removeItem("mock_auth");
    localStorage.removeItem("mock_admin_name");
    localStorage.removeItem("mock_umpire_auth");
    localStorage.removeItem("mock_umpire_name");
    setAuthRole(null);
    setUserName(null);
  };

  return (
    <header className="sticky top-0 z-50 border-b border-border bg-charcoal/95 backdrop-blur">
      <div className="mx-auto flex max-w-6xl items-center justify-between gap-4 px-4 py-3">
        {/* Logo */}
        <Link to="/" className="flex items-center gap-2.5 min-w-0">
          <img
            src="/DinkValley.jpg"
            alt="Dink Valley pickleball club logo"
            className="h-9 w-9 flex-shrink-0 rounded-full object-cover sm:h-11 sm:w-11"
          />
          <span className="font-display text-xl leading-none text-sand sm:text-2xl">
            Dink Valley
            <span className="block font-sans text-[0.55rem] uppercase tracking-[0.28em] text-pickle sm:text-[0.6rem]">
              Pickleball Club
            </span>
          </span>
        </Link>

        {/* Desktop nav */}
        <nav className="hidden items-center gap-2 text-sm font-semibold uppercase tracking-wide sm:flex">
          <Link
            to="/"
            activeOptions={{ exact: true }}
            className="rounded px-3 py-2 text-sand/80 transition-colors hover:text-sand"
            activeProps={{ className: "text-sand font-bold" }}
          >
            Tournaments
          </Link>

          {authRole ? (
            <div className="flex items-center gap-2">
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
          ) : (
            <div className="flex items-center gap-2">
              <Link
                to="/admin"
                className="rounded border border-border px-3.5 py-2 text-xs font-bold uppercase tracking-wider text-sand/80 hover:text-sand hover:border-pickle transition-colors"
                activeProps={{ className: "border-pickle text-sand font-bold" }}
              >
                Admin Console
              </Link>
              <Link
                to="/login"
                className="rounded border border-border px-3.5 py-2 text-xs font-bold uppercase tracking-wider text-sand/80 hover:text-sand hover:border-pickle transition-colors"
                activeProps={{ className: "border-pickle text-sand font-bold" }}
              >
                Sign In
              </Link>
              <Link
                to="/register"
                className="rounded bg-primary px-4 py-2 text-xs font-bold uppercase tracking-wider text-primary-foreground transition-colors hover:bg-brick-deep shadow-sm cursor-pointer"
                activeProps={{ className: "bg-brick-deep ring-1 ring-pickle" }}
              >
                Register
              </Link>
            </div>
          )}
        </nav>

        {/* Mobile nav - compact buttons */}
        <div className="flex items-center gap-2 sm:hidden">
          <Link
            to="/"
            activeOptions={{ exact: true }}
            className="rounded px-2.5 py-1.5 text-xs font-bold uppercase tracking-wider text-sand/80 transition-colors hover:text-sand"
            activeProps={{ className: "text-sand" }}
          >
            Tournaments
          </Link>

          {authRole ? (
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
          ) : (
            <div className="flex items-center gap-1.5">
              <Link
                to="/login"
                className="rounded border border-border px-2 py-1.5 text-[0.65rem] font-bold uppercase tracking-wider text-sand/80 hover:text-sand"
              >
                Sign In
              </Link>
              <Link
                to="/register"
                className="rounded bg-primary px-2.5 py-1.5 text-[0.65rem] font-bold uppercase tracking-wider text-primary-foreground transition-colors hover:bg-brick-deep"
              >
                Register
              </Link>
            </div>
          )}
        </div>
      </div>
    </header>
  );
}

export function SiteFooter() {
  return (
    <footer className="mt-20 border-t border-border bg-charcoal py-8">
      <div className="mx-auto flex max-w-6xl flex-col sm:flex-row sm:items-center sm:justify-between gap-4 px-5 text-sm text-sand/70">
        <div>
          <span className="font-display text-xl text-sand block">Dink Valley Pickleball Club</span>
          <span>Santiago City, Philippines &middot; Courts open daily 6AM - 10PM</span>
        </div>
        <div className="flex flex-wrap items-center gap-4">
          <Link
            to="/register"
            className="text-xs uppercase tracking-widest text-pickle hover:text-pickle/80 transition-colors font-mono font-bold"
          >
            Register Official &rarr;
          </Link>
          <Link
            to="/login"
            className="text-xs uppercase tracking-widest text-sand/60 hover:text-sand transition-colors font-mono"
          >
            Staff Sign In &rarr;
          </Link>
        </div>
      </div>
    </footer>
  );
}
