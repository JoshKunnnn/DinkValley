import { createFileRoute, useNavigate, Link, useRouter } from "@tanstack/react-router";
import { useState, useEffect, useMemo } from "react";
import type { Team, Tournament, Category } from "@/data/tournaments";
import { DrawsManager } from "@/components/admin/DrawsManager";
import { BracketDraw } from "@/components/admin/BracketDraw";
import { CourtDispatch } from "@/components/admin/CourtDispatch";
import { TournamentsManager } from "@/components/admin/TournamentsManager";
import { AdminMobileNav } from "@/components/admin/AdminMobileNav";
import {
  useTournamentStore,
  getTournaments,
  addTeamToCategory,
  removeTeamFromCategory,
  updateTeamInTournament,
  bulkSetTeamsInCategory,
  deleteAllTeamsInCategory,
} from "@/lib/tournament-store";
import { generate32Teams } from "@/lib/team-generator";
import {
  type AccessCode,
  getAccessCodes,
  saveAccessCodes,
  generateNewCode,
  revokeCode,
} from "@/lib/access-codes";
import {
  loginWithCredentials,
  getAuthenticatedStaff,
  logoutStaff,
} from "@/lib/auth-store";
import { dbGetAccessCodes } from "@/lib/supabase-service";
import { generateUUID } from "@/lib/utils";
import {
  exportCategoryTeamsToCsv,
  exportTournamentTeamsToCsv,
  exportTournamentGroupedPerCategoryCsv,
  exportAllCategoriesSeparately,
  exportTournamentToExcelWorkbook,
  type CsvExportFilter,
} from "@/lib/csv-export";

export const Route = createFileRoute("/admin")({
  head: () => ({
    meta: [
      { title: "Organizer Console | Dink Valley" },
      {
        name: "description",
        content: "Create events, manage rosters, round robin brackets, and auto-generate randomized tournament draws.",
      },
      { property: "og:title", content: "Dink Valley Organizer Console" },
      {
        property: "og:description",
        content: "Event and bracket management for club organizers.",
      },
    ],
  }),
  component: Admin,
  errorComponent: AdminErrorComponent,
});

function AdminErrorComponent({ error, reset }: { error: Error; reset: () => void }) {
  const router = useRouter();

  const handleClearCacheAndReset = () => {
    try {
      localStorage.removeItem("dv_tournaments");
      localStorage.removeItem("dv_matches");
      localStorage.removeItem("dv_court_stations");
      localStorage.removeItem("dv_dispatch_queue");
    } catch {
      // ignore
    }
    router.invalidate();
    reset();
  };

  return (
    <div className="court-lines flex min-h-[calc(100vh-4rem)] items-center justify-center p-6">
      <div className="surface-card bg-card max-w-lg w-full p-8 border border-brick/40 rounded-xl shadow-xl space-y-5 text-center">
        <span className="text-[0.65rem] uppercase tracking-[0.28em] text-brick font-bold block">
          Admin Console Diagnostics
        </span>
        <h2 className="font-display text-3xl text-foreground">Console Loading Interrupted</h2>
        <p className="text-xs text-muted-foreground">
          An issue occurred while initializing the tournament management view. You can reload or reset your local store.
        </p>

        {error && (
          <div className="p-3 bg-card border-2 border-border rounded text-left text-xs font-mono max-h-36 overflow-auto text-foreground break-all">
            <span className="font-bold text-brick block mb-1">Details: {error.message || String(error)}</span>
            {error.stack && (
              <pre className="text-[0.65rem] text-foreground/80 font-bold whitespace-pre-wrap">{error.stack.slice(0, 300)}</pre>
            )}
          </div>
        )}

        <div className="flex flex-col sm:flex-row gap-3 justify-center pt-2">
          <button
            onClick={() => {
              router.invalidate();
              reset();
            }}
            className="bg-brick px-6 py-2.5 font-display text-xl tracking-wider text-sand hover:bg-brick-deep rounded cursor-pointer transition-all"
          >
            Reload View
          </button>
          <button
            onClick={handleClearCacheAndReset}
            className="border border-border bg-card px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-foreground hover:border-pickle rounded cursor-pointer transition-all"
          >
            Reset Local Cache
          </button>
          <Link
            to="/"
            className="border border-border bg-card px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground rounded flex items-center justify-center transition-all"
          >
            Back Home
          </Link>
        </div>
      </div>
    </div>
  );
}

const levels = ["Beginners", "Novice", "Intermediate", "Advance", "Open"];
const divisions = ["Men's", "Women's", "Mixed"];

type TabKey = "draw" | "dispatch" | "setup" | "teams" | "access-codes";
type DrawSubTab = "bracket-draw" | "brackets";
type SetupSection = "tournaments" | "teams" | "access-codes";

const tabs: { key: TabKey; label: string }[] = [
  { key: "draw", label: "Draw" },
  { key: "dispatch", label: "Dispatch" },
  { key: "setup", label: "Setup" },
  { key: "teams", label: "Teams & Payments" },
  { key: "access-codes", label: "Access Codes" },
];

function Admin() {
  const navigate = useNavigate();
  const { tournaments, isOnline } = useTournamentStore();

  const [isMounted, setIsMounted] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("setup");
  const [drawSubTab, setDrawSubTab] = useState<DrawSubTab>("bracket-draw");
  const [openSetupSections, setOpenSetupSections] = useState<Set<SetupSection>>(
    new Set(["tournaments"])
  );
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [tournamentSlug, setTournamentSlug] = useState<string>("");
  const [categoryId, setCategoryId] = useState<string>("");

  const toggleSetupSection = (section: SetupSection) => {
    setOpenSetupSections((prev) => {
      const next = new Set(prev);
      if (next.has(section)) {
        next.delete(section);
      } else {
        next.add(section);
      }
      return next;
    });
  };

  const [authEmailInput, setAuthEmailInput] = useState("");
  const [authPasswordInput, setAuthPasswordInput] = useState("");
  const [authError, setAuthError] = useState<string | null>(null);
  const [isAuthenticating, setIsAuthenticating] = useState(false);

  useEffect(() => {
    setIsMounted(true);
    if (typeof localStorage !== "undefined") {
      const staff = getAuthenticatedStaff();
      const auth = staff?.role === "admin";
      setIsAuthenticated(auth);
      const list = getTournaments();
      if (list.length > 0) {
        setTournamentSlug(list[0]!.slug);
        if (list[0]!.categories && list[0]!.categories.length > 0) {
          setCategoryId(list[0]!.categories[0]!.id);
        }
        setActiveTab("draw");
      }
    }
  }, []);

  const tournament = tournaments.find((t) => t.slug === tournamentSlug) ?? tournaments[0];
  const category =
    tournament?.categories?.find((c) => c.id === categoryId || (c as any).category_slug === categoryId) ?? tournament?.categories?.[0];

  // Sync tournamentSlug when tournaments change
  useEffect(() => {
    if (tournaments.length > 0) {
      if (!tournamentSlug || !tournaments.some((t) => t.slug === tournamentSlug)) {
        const first = tournaments[0]!;
        setTournamentSlug(first.slug);
        if (first.categories && first.categories.length > 0) {
          setCategoryId(first.categories[0]!.id);
        }
      }
    }
  }, [tournaments, tournamentSlug]);

  // Sync categoryId when tournament categories change
  useEffect(() => {
    if (tournament && tournament.categories && tournament.categories.length > 0) {
      if (
        categoryId !== "all" &&
        (!categoryId || !tournament.categories.some((c) => c.id === categoryId || (c as any).category_slug === categoryId))
      ) {
        setCategoryId(tournament.categories[0]!.id);
      }
    }
  }, [tournament, categoryId]);

  const handleLogout = () => {
    logoutStaff();
    setIsAuthenticated(false);
  };

  const handleAdminGateSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setIsAuthenticating(true);

    const cleanEmail = authEmailInput.trim().toLowerCase();
    const cleanPassword = authPasswordInput.trim();

    if (!cleanEmail || !cleanPassword) {
      setAuthError("Please enter your administrator email and password.");
      setIsAuthenticating(false);
      return;
    }

    const res = await loginWithCredentials(cleanEmail, cleanPassword);
    setIsAuthenticating(false);
    if (!res.success) {
      setAuthError(res.error || "Invalid administrator credentials.");
      return;
    }
    if (res.role !== "admin") {
      setAuthError("This account does not have Tournament Director (Admin) privileges. Please access the Umpire Console.");
      return;
    }
    setIsAuthenticated(true);
  };

  if (!isMounted) {
    return (
      <div className="court-lines flex min-h-[calc(100vh-4rem)] items-center justify-center p-6 text-center">
        <div className="surface-card bg-card max-w-sm w-full p-8 border border-border rounded-xl shadow-lg space-y-4">
          <img
            src="/DinkValley.jpg"
            alt="Dink Valley"
            className="h-16 w-16 mx-auto rounded-full object-cover ring-2 ring-brick"
          />
          <div>
            <span className="text-[0.65rem] uppercase tracking-[0.28em] text-pickle font-bold block">
              Dink Valley System
            </span>
            <h2 className="font-display text-2xl text-foreground mt-1">Loading Organizer Console...</h2>
          </div>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return (
      <div className="court-lines flex min-h-[calc(100vh-4rem)] items-center justify-center p-4 sm:p-6">
        <div className="surface-card bg-card max-w-md w-full p-8 sm:p-10 text-center space-y-5 border border-border rounded-xl shadow-lg">
          <img
            src="/DinkValley.jpg"
            alt="Dink Valley"
            className="h-16 w-16 mx-auto rounded-full object-cover ring-2 ring-brick"
          />
          <div>
            <span className="text-[0.65rem] uppercase tracking-[0.28em] text-pickle font-bold block">
              Restricted Area
            </span>
            <h2 className="font-display text-3xl sm:text-4xl text-foreground mt-1">
              Organizer Gate
            </h2>
            <p className="text-xs text-muted-foreground mt-1.5">
              Authorized Tournament Directors only. Enter your administrator email and password to proceed.
            </p>
          </div>

          {authError && (
            <div className="p-3 bg-brick/15 border border-brick/60 text-brick text-xs font-semibold rounded text-left">
              {authError}
            </div>
          )}

          <form onSubmit={handleAdminGateSubmit} className="space-y-3 pt-2 text-left">
            <div>
              <label className="block text-[0.65rem] uppercase tracking-wider text-muted-foreground font-bold mb-1">
                Administrator Email
              </label>
              <input
                type="email"
                value={authEmailInput}
                onChange={(e) => setAuthEmailInput(e.target.value)}
                placeholder="admin@dinkvalley.com"
                autoFocus
                required
                className="w-full bg-charcoal border border-border px-3.5 py-2.5 text-sand text-sm rounded focus:outline-none focus:border-pickle"
              />
            </div>

            <div>
              <label className="block text-[0.65rem] uppercase tracking-wider text-muted-foreground font-bold mb-1">
                Password
              </label>
              <input
                type="password"
                value={authPasswordInput}
                onChange={(e) => setAuthPasswordInput(e.target.value)}
                placeholder="••••••••"
                required
                className="w-full bg-charcoal border border-border px-3.5 py-2 text-sand text-sm rounded focus:outline-none focus:border-pickle"
              />
            </div>

            <button
              type="submit"
              disabled={isAuthenticating || !authEmailInput.trim() || !authPasswordInput.trim()}
              className="w-full bg-brick py-3 px-6 font-display text-xl tracking-wider text-sand hover:bg-brick-deep transition-all cursor-pointer shadow-md rounded disabled:opacity-50 mt-1"
            >
              {isAuthenticating ? "Authenticating..." : "Sign In & Enter"}
            </button>
          </form>

          <div className="pt-2 border-t border-border/60 flex flex-col gap-2">
            <Link
              to="/"
              className="text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground font-semibold transition-colors"
            >
              &larr; Return to Tournaments
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex flex-1 flex-col md:flex-row items-stretch min-h-full">
      {/* ── Mobile Drawer ── */}
      {mobileMenuOpen && (
        <div
          className="fixed inset-0 z-50 bg-black/60 backdrop-blur-sm md:hidden animate-in fade-in duration-200"
          onClick={() => setMobileMenuOpen(false)}
        >
          <div
            className="flex h-full w-72 flex-col bg-charcoal border-r border-border p-0 shadow-2xl"
            onClick={(e) => e.stopPropagation()}
          >
            {/* Drawer Header */}
            <div className="flex items-center justify-between border-b border-border px-6 py-5">
              <div className="flex items-center gap-3">
                <img
                  src="/DinkValley.jpg"
                  alt="Dink Valley"
                  className="h-10 w-10 rounded-full object-cover ring-2 ring-brick"
                />
                <div>
                  <span className="block font-display text-xl leading-none text-sand">Dink Valley</span>
                  <span className="block text-[0.6rem] uppercase tracking-[0.28em] text-pickle">
                    Admin Console
                  </span>
                </div>
              </div>
              <button
                onClick={() => setMobileMenuOpen(false)}
                className="text-sand hover:text-sand/80 text-xs font-bold uppercase tracking-widest p-1.5 cursor-pointer"
                aria-label="Close menu"
              >
                Close
              </button>
            </div>

            {/* Nav links */}
            <nav className="flex flex-col gap-1 px-3 py-4">
              {tabs.map(({ key, label }) => (
                <button
                  key={key}
                  onClick={() => {
                    setActiveTab(key);
                    setMobileMenuOpen(false);
                  }}
                  className={`flex items-center justify-between rounded px-4 py-3 text-left text-sm font-semibold uppercase tracking-widest transition-colors cursor-pointer ${
                    activeTab === key
                      ? "bg-brick text-sand font-bold"
                      : "text-sand/80 hover:bg-charcoal/60 hover:text-sand"
                  }`}
                >
                  <span>{label}</span>
                </button>
              ))}
            </nav>

            <div className="flex-1" />

            {/* Footer */}
            <div className="border-t border-border px-3 py-4 space-y-1">
              <Link
                to="/"
                className="flex items-center gap-3 rounded px-4 py-3 text-sm font-semibold uppercase tracking-widest text-sand/80 transition-colors hover:text-sand"
              >
                Back to Public Site
              </Link>
              <button
                onClick={handleLogout}
                className="flex w-full items-center gap-3 rounded px-4 py-3 text-left text-sm font-semibold uppercase tracking-widest text-sand/70 transition-colors hover:text-brick cursor-pointer"
              >
                Log Out
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Desktop Sidebar ── */}
      <aside className="hidden md:flex w-64 flex-shrink-0 flex-col border-r border-border bg-charcoal min-h-full">
        {/* Logo/Brand area */}
        <div className="flex items-center gap-3 border-b border-border px-6 py-5">
          <img
            src="/DinkValley.jpg"
            alt="Dink Valley"
            className="h-10 w-10 rounded-full object-cover ring-2 ring-brick"
          />
          <div>
            <span className="block font-display text-xl leading-none text-sand">Dink Valley</span>
            <span className="block text-[0.6rem] uppercase tracking-[0.28em] text-pickle">
              Admin Console
            </span>
          </div>
        </div>

        {/* Nav links */}
        <nav className="flex flex-col gap-1 px-3 py-4">
          {tabs.map(({ key, label }) => (
            <button
              key={key}
              onClick={() => setActiveTab(key)}
              className={`flex items-center justify-between rounded px-4 py-3 text-left text-sm font-semibold uppercase tracking-widest transition-colors cursor-pointer ${
                activeTab === key
                  ? "bg-brick text-sand font-bold"
                  : "text-sand/80 hover:bg-charcoal/60 hover:text-sand"
              }`}
            >
              <span>{label}</span>
            </button>
          ))}
        </nav>

        {/* Spacer */}
        <div className="flex-1" />

        {/* Footer: back to site + logout */}
        <div className="border-t border-border px-3 py-4 space-y-1">
          <Link
            to="/"
            className="flex items-center gap-3 rounded px-4 py-3 text-sm font-semibold uppercase tracking-widest text-sand/80 transition-colors hover:text-sand"
          >
            Back to Public Site
          </Link>
          <button
            onClick={handleLogout}
            className="flex w-full items-center gap-3 rounded px-4 py-3 text-left text-sm font-semibold uppercase tracking-widest text-sand/70 transition-colors hover:text-brick cursor-pointer"
          >
            Log Out
          </button>
        </div>
      </aside>

      {/* ── Main content ── */}
      <div className="flex flex-1 flex-col bg-background min-w-0 border-b border-border">
        {/* Topbar */}
        <header className="flex items-center justify-between gap-2 border-b-2 border-border bg-card px-3 py-3 sm:px-8 sm:py-4">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            {/* Mobile menu button */}
            <button
              onClick={() => setMobileMenuOpen(true)}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded border-2 border-border bg-card text-foreground md:hidden hover:border-pickle transition-colors"
              aria-label="Open navigation drawer"
            >
              <svg className="w-4 h-4 text-foreground" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <div className="min-w-0">
              <h1 className="font-display text-xl leading-tight text-foreground sm:text-3xl md:text-4xl truncate font-bold">
                {activeTab === "draw"
                  ? drawSubTab === "bracket-draw" ? "Bracket Draw" : "Brackets"
                  : tabs.find((t) => t.key === activeTab)?.label}
              </h1>
              <p className="text-[0.65rem] uppercase tracking-widest text-foreground/80 sm:text-xs font-mono font-bold">
                Organizer Console
              </p>
            </div>
          </div>
          <div className="flex items-center gap-2">
            <div className="hidden sm:inline-flex items-center gap-1.5 px-2.5 py-1 text-[0.65rem] font-bold uppercase tracking-wider rounded border border-border bg-card">
              <span
                className={`w-1.5 h-1.5 rounded-full ${
                  isOnline ? "bg-pickle animate-pulse" : "bg-amber-600"
                }`}
              />
              <span className={isOnline ? "text-pickle" : "text-amber-600"}>
                {isOnline ? "Database Live" : "Offline"}
              </span>
            </div>
            <span className="flex-shrink-0 text-[0.6rem] sm:text-xs font-semibold uppercase tracking-widest text-pickle border border-pickle px-2 py-1 sm:px-2.5">
              Admin
            </span>
          </div>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 md:p-8 pb-24 md:pb-8">

          {/* ── DRAW TAB ── */}
          {activeTab === "draw" && (
            <div className="space-y-6">
              {/* Sub-tab toggle — full-width segmented control on mobile, sleek tabs on desktop */}
              <div className="grid grid-cols-2 p-1 bg-card rounded-lg border-2 border-border sm:flex sm:w-auto sm:border-0 sm:bg-transparent sm:p-0 sm:border-b-2 sm:border-border sm:rounded-none sm:gap-1">
                <button
                  onClick={() => setDrawSubTab("bracket-draw")}
                  className={`py-2 px-3 sm:px-5 sm:py-2.5 text-xs font-bold uppercase tracking-widest text-center transition-all cursor-pointer rounded sm:rounded-none sm:border-b-2 ${
                    drawSubTab === "bracket-draw"
                      ? "bg-brick text-white sm:bg-transparent sm:border-brick sm:text-brick font-bold shadow-sm"
                      : "text-foreground hover:text-pickle sm:border-transparent font-bold"
                  }`}
                >
                  Bracket Draw
                </button>
                <button
                  onClick={() => setDrawSubTab("brackets")}
                  className={`py-2 px-3 sm:px-5 sm:py-2.5 text-xs font-bold uppercase tracking-widest text-center transition-all cursor-pointer rounded sm:rounded-none sm:border-b-2 ${
                    drawSubTab === "brackets"
                      ? "bg-brick text-white sm:bg-transparent sm:border-brick sm:text-brick font-bold shadow-sm"
                      : "text-foreground hover:text-pickle sm:border-transparent font-bold"
                  }`}
                >
                  Brackets
                </button>
              </div>

              {/* No tournament guard */}
              {tournaments.length === 0 && (
                <div className="surface-card p-10 sm:p-14 text-center max-w-xl mx-auto border border-border mt-8">
                  <span className="text-xs uppercase tracking-[0.28em] text-pickle font-bold">Setup Required</span>
                  <h3 className="font-display text-3xl text-foreground mt-2">No Tournaments Created Yet</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Create your first tournament in the Setup tab before managing brackets.
                  </p>
                  <button
                    onClick={() => { setActiveTab("setup"); setOpenSetupSections(new Set(["tournaments"])); }}
                    className="mt-6 bg-brick px-6 py-2.5 font-display text-xl tracking-wider text-sand hover:bg-brick-deep transition-colors cursor-pointer"
                  >
                    Go to Setup
                  </button>
                </div>
              )}

              {tournaments.length > 0 && (!tournament || !category) && (
                <div className="surface-card p-10 sm:p-14 text-center max-w-xl mx-auto border border-border mt-8">
                  <span className="text-xs uppercase tracking-[0.28em] text-pickle font-bold">Divisions Required</span>
                  <h3 className="font-display text-3xl text-foreground mt-2">No Divisions Configured</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    The selected tournament has no categories or divisions configured yet.
                  </p>
                  <button
                    onClick={() => { setActiveTab("setup"); setOpenSetupSections(new Set(["tournaments"])); }}
                    className="mt-6 bg-brick px-6 py-2.5 font-display text-xl tracking-wider text-sand hover:bg-brick-deep transition-colors cursor-pointer"
                  >
                    Configure Divisions
                  </button>
                </div>
              )}

              {tournament && category && drawSubTab === "bracket-draw" && (
                <BracketDraw
                  tournament={tournament}
                  category={category}
                  tournaments={tournaments}
                  tournamentSlug={tournamentSlug}
                  setTournamentSlug={(slug) => {
                    setTournamentSlug(slug);
                    const next = tournaments.find((t) => t.slug === slug);
                    if (next?.categories?.[0]) setCategoryId(next.categories[0].id);
                  }}
                  categoryId={categoryId}
                  setCategoryId={setCategoryId}
                />
              )}
              {tournament && category && drawSubTab === "brackets" && (
                <DrawsManager
                  tournament={tournament}
                  category={category}
                  tournaments={tournaments}
                  tournamentSlug={tournamentSlug}
                  setTournamentSlug={(slug) => {
                    setTournamentSlug(slug);
                    const next = tournaments.find((t) => t.slug === slug);
                    if (next?.categories?.[0]) setCategoryId(next.categories[0].id);
                  }}
                  categoryId={categoryId}
                  setCategoryId={setCategoryId}
                  onSwitchToBracketDraw={() => setDrawSubTab("bracket-draw")}
                />
              )}
            </div>
          )}

          {/* ── DISPATCH TAB ── */}
          {activeTab === "dispatch" && (
            <>
              {tournaments.length === 0 && (
                <div className="surface-card p-10 sm:p-14 text-center max-w-xl mx-auto border border-border mt-8">
                  <span className="text-xs uppercase tracking-[0.28em] text-pickle font-bold">Setup Required</span>
                  <h3 className="font-display text-3xl text-foreground mt-2">No Tournaments Created Yet</h3>
                  <button
                    onClick={() => { setActiveTab("setup"); setOpenSetupSections(new Set(["tournaments"])); }}
                    className="mt-6 bg-brick px-6 py-2.5 font-display text-xl tracking-wider text-sand hover:bg-brick-deep transition-colors cursor-pointer"
                  >
                    Go to Setup
                  </button>
                </div>
              )}
              {tournament && category && (
                <CourtDispatch
                  tournament={tournament}
                  category={category}
                  tournaments={tournaments}
                  tournamentSlug={tournamentSlug}
                  setTournamentSlug={(slug) => {
                    setTournamentSlug(slug);
                    const next = tournaments.find((t) => t.slug === slug);
                    if (next?.categories?.[0]) setCategoryId(next.categories[0].id);
                  }}
                  categoryId={categoryId}
                  setCategoryId={setCategoryId}
                />
              )}
            </>
          )}

          {/* ── SETUP TAB (accordion) ── */}
          {activeTab === "setup" && (
            <div className="max-w-4xl space-y-3">
              <div className="mb-2">
                <span className="text-xs uppercase tracking-[0.28em] text-pickle font-bold">Organizer Setup</span>
                <h2 className="font-display text-3xl text-foreground mt-1">Configuration</h2>
              </div>

              {/* Tournaments Section */}
              <div className="border-2 border-border rounded-xl overflow-hidden shadow-xs">
                <button
                  onClick={() => toggleSetupSection("tournaments")}
                  className="w-full flex items-center justify-between px-5 py-4 bg-card hover:bg-card/90 border-b border-border transition-colors cursor-pointer"
                >
                  <span className="text-sm font-bold uppercase tracking-widest text-foreground">Tournaments</span>
                  <svg
                    className={`w-4 h-4 text-foreground transition-transform duration-200 ${openSetupSections.has("tournaments") ? "rotate-180" : ""}`}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {openSetupSections.has("tournaments") && (
                  <div className="p-4 sm:p-6 bg-card">
                    <TournamentsManager
                      activeTournamentSlug={tournamentSlug}
                      onSelectTournament={(slug) => {
                        setTournamentSlug(slug);
                        const found = tournaments.find((t) => t.slug === slug);
                        if (found?.categories?.[0]) setCategoryId(found.categories[0].id);
                      }}
                    />
                  </div>
                )}
              </div>

              {/* Teams & Payments Section */}
              <div className="border-2 border-border rounded-xl overflow-hidden shadow-xs">
                <button
                  onClick={() => toggleSetupSection("teams")}
                  className="w-full flex items-center justify-between px-5 py-4 bg-card hover:bg-card/90 border-b border-border transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold uppercase tracking-widest text-foreground">Teams & Payments</span>
                    {tournament && category && (
                      <span className="text-[0.65rem] font-mono text-foreground font-bold border-2 border-border bg-background px-2 py-0.5 rounded">
                        {category.teams?.length ?? 0} teams
                      </span>
                    )}
                  </div>
                  <svg
                    className={`w-4 h-4 text-foreground transition-transform duration-200 ${openSetupSections.has("teams") ? "rotate-180" : ""}`}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {openSetupSections.has("teams") && (
                  <div className="p-4 sm:p-6 bg-card">
                    {tournament && category ? (
                      <TeamsTab
                        tournament={tournament}
                        category={category}
                        tournaments={tournaments}
                        tournamentSlug={tournamentSlug}
                        setTournamentSlug={(slug) => {
                          setTournamentSlug(slug);
                          const next = tournaments.find((t) => t.slug === slug);
                          if (next?.categories?.[0]) setCategoryId(next.categories[0].id);
                        }}
                        categoryId={categoryId}
                        setCategoryId={setCategoryId}
                      />
                    ) : (
                      <p className="text-sm text-foreground/80 font-bold py-4">
                        Create a tournament with categories first to manage teams.
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Access Codes Section */}
              <div className="border-2 border-border rounded-xl overflow-hidden shadow-xs">
                <button
                  onClick={() => toggleSetupSection("access-codes")}
                  className="w-full flex items-center justify-between px-5 py-4 bg-card hover:bg-card/90 border-b border-border transition-colors cursor-pointer"
                >
                  <span className="text-sm font-bold uppercase tracking-widest text-foreground">Access Codes</span>
                  <svg
                    className={`w-4 h-4 text-foreground transition-transform duration-200 ${openSetupSections.has("access-codes") ? "rotate-180" : ""}`}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {openSetupSections.has("access-codes") && (
                  <div className="p-4 sm:p-6 bg-card">
                    <AccessCodesTab />
                  </div>
                )}
              </div>
            </div>
          )}

          {/* ── TEAMS & PAYMENTS TAB ── */}
          {activeTab === "teams" && (
            <div className="max-w-4xl space-y-4">
              {tournaments.length === 0 && (
                <div className="surface-card p-10 sm:p-14 text-center max-w-xl mx-auto border border-border mt-8">
                  <span className="text-xs uppercase tracking-[0.28em] text-pickle font-bold">Setup Required</span>
                  <h3 className="font-display text-3xl text-foreground mt-2">No Tournaments Created Yet</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    Create your first tournament in the Setup tab before managing teams.
                  </p>
                  <button
                    onClick={() => { setActiveTab("setup"); setOpenSetupSections(new Set(["tournaments"])); }}
                    className="mt-6 bg-brick px-6 py-2.5 font-display text-xl tracking-wider text-sand hover:bg-brick-deep transition-colors cursor-pointer"
                  >
                    Go to Setup
                  </button>
                </div>
              )}

              {tournaments.length > 0 && (!tournament || !category) && (
                <div className="surface-card p-10 sm:p-14 text-center max-w-xl mx-auto border border-border mt-8">
                  <span className="text-xs uppercase tracking-[0.28em] text-pickle font-bold">Divisions Required</span>
                  <h3 className="font-display text-3xl text-foreground mt-2">No Divisions Configured</h3>
                  <p className="mt-2 text-sm text-muted-foreground">
                    The selected tournament has no categories or divisions configured yet.
                  </p>
                  <button
                    onClick={() => { setActiveTab("setup"); setOpenSetupSections(new Set(["tournaments"])); }}
                    className="mt-6 bg-brick px-6 py-2.5 font-display text-xl tracking-wider text-sand hover:bg-brick-deep transition-colors cursor-pointer"
                  >
                    Configure Divisions
                  </button>
                </div>
              )}

              {tournament && category && (
                <TeamsTab
                  tournament={tournament}
                  category={category}
                  tournaments={tournaments}
                  tournamentSlug={tournamentSlug}
                  setTournamentSlug={(slug) => {
                    setTournamentSlug(slug);
                    const next = tournaments.find((t) => t.slug === slug);
                    if (next?.categories?.[0]) setCategoryId(next.categories[0].id);
                  }}
                  categoryId={categoryId}
                  setCategoryId={setCategoryId}
                />
              )}
            </div>
          )}

          {/* ── ACCESS CODES TAB ── */}
          {activeTab === "access-codes" && (
            <div className="max-w-4xl space-y-4">
              <AccessCodesTab />
            </div>
          )}

        </div>
      </div>

      {/* ── Mobile bottom nav (md and below only) ── */}
      <AdminMobileNav
        activeTab={activeTab}
        onTabChange={(tab) => { setActiveTab(tab); }}
        onLogout={handleLogout}
      />
    </div>
  );
}

function TeamsTab({
  tournament,
  category,
  tournaments: tourns,
  tournamentSlug,
  setTournamentSlug,
  categoryId,
  setCategoryId,
}: {
  tournament: Tournament;
  category: Category;
  tournaments: Tournament[];
  tournamentSlug: string;
  setTournamentSlug: (s: string) => void;
  categoryId: string;
  setCategoryId: (s: string) => void;
}) {
  // Local payment state: teamId -> paid boolean
  const [paymentMap, setPaymentMap] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(
      (tournament.categories || []).flatMap((c) =>
        (c.teams || []).map((t) => [t.id, t.paid ?? true])
      )
    )
  );

  const [filter, setFilter] = useState<"all" | "paid" | "unpaid">("all");
  const [teamSearchQuery, setTeamSearchQuery] = useState("");
  const [expandedTeamKeys, setExpandedTeamKeys] = useState<Set<string>>(new Set());

  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [exportNotification, setExportNotification] = useState<string | null>(null);

  const [newTeamName, setNewTeamName] = useState("");
  const [newPlayers, setNewPlayers] = useState("");
  const [targetNewCategory, setTargetNewCategory] = useState<string>(category?.id || tournament.categories?.[0]?.id || "");
  const [teamAddError, setTeamAddError] = useState<string | null>(null);

  const isAllCategories = categoryId === "all";
  const targetCategories = useMemo(() => {
    if (isAllCategories) return tournament.categories || [];
    return (tournament.categories || []).filter((c) => c.id === categoryId);
  }, [tournament, categoryId, isAllCategories]);

  // Rebuild payment map across all tournament categories
  const resolvedMap: Record<string, boolean> = {};

  (tournament.categories || []).forEach((c) => {
    (c.teams || []).forEach((t) => {
      resolvedMap[t.id] = paymentMap[t.id] ?? t.paid ?? true;
    });
  });

  const togglePaid = (id: string, catId?: string) => {
    const targetCatId = catId || (categoryId !== "all" ? categoryId : category.id);
    const nextVal = !resolvedMap[id];
    setPaymentMap((prev) => ({ ...prev, [id]: nextVal }));
    updateTeamInTournament(tournament.slug, targetCatId, id, {
      paid: nextVal,
      paymentStatus: nextVal ? "Verified" : "Unpaid",
    });
  };

  const handleCreateTeam = () => {
    if (!newTeamName.trim()) {
      setTeamAddError("Team name is required.");
      return;
    }
    const playersList = newPlayers.trim()
      ? newPlayers.split("/").map((p) => p.trim()).filter(Boolean)
      : ["Player 1", "Player 2"];
    const id = generateUUID();
    const newTeam: Team = {
      id,
      name: newTeamName.trim(),
      players: playersList,
      club: "Dink Valley",
      paid: true,
      paymentStatus: "Verified",
    };
    const targetCatId = targetNewCategory || (categoryId !== "all" ? categoryId : category.id);
    addTeamToCategory(tournament.slug, targetCatId, newTeam);
    setPaymentMap((prev) => ({ ...prev, [id]: true }));
    setNewTeamName("");
    setNewPlayers("");
    setTeamAddError(null);
  };

  const handleRemoveTeam = (teamId: string, name: string, catId?: string) => {
    const targetCatId = catId || (categoryId !== "all" ? categoryId : category.id);
    const targetCat = tournament.categories.find((c) => c.id === targetCatId) || category;
    if (window.confirm(`Remove team "${name}" from ${targetCat.label}?`)) {
      removeTeamFromCategory(tournament.slug, targetCatId, teamId);
    }
  };

  const handleEditPlayerName = (teamId: string, playerIndex: number, currentName: string, catId?: string) => {
    const targetCatId = catId || (categoryId !== "all" ? categoryId : category.id);
    const targetCat = tournament.categories.find((c) => c.id === targetCatId) || category;
    const updatedName = window.prompt(`Edit name for Player ${playerIndex + 1}:`, currentName);
    if (!updatedName || !updatedName.trim() || updatedName.trim() === currentName) return;

    const team = targetCat.teams.find((t) => t.id === teamId);
    if (!team) return;

    const nextPlayers = [...team.players];
    nextPlayers[playerIndex] = updatedName.trim();

    updateTeamInTournament(tournament.slug, targetCatId, teamId, {
      players: nextPlayers,
    });
  };

  const handleAddPlayerToTeam = (teamId: string, catId?: string) => {
    const targetCatId = catId || (categoryId !== "all" ? categoryId : category.id);
    const targetCat = tournament.categories.find((c) => c.id === targetCatId) || category;
    const newName = window.prompt("Enter player full name to add to this team:");
    if (!newName || !newName.trim()) return;

    const team = targetCat.teams.find((t) => t.id === teamId);
    if (!team) return;

    const nextPlayers = [...team.players, newName.trim()];
    updateTeamInTournament(tournament.slug, targetCatId, teamId, {
      players: nextPlayers,
    });
  };

  const handleRemovePlayerFromTeam = (teamId: string, playerIndex: number, catId?: string) => {
    const targetCatId = catId || (categoryId !== "all" ? categoryId : category.id);
    const targetCat = tournament.categories.find((c) => c.id === targetCatId) || category;
    const team = targetCat.teams.find((t) => t.id === teamId);
    if (!team || team.players.length <= 1) {
      alert("A team must have at least one player.");
      return;
    }

    if (!window.confirm(`Remove "${team.players[playerIndex]}" from ${team.name}?`)) return;

    const nextPlayers = team.players.filter((_, idx) => idx !== playerIndex);
    updateTeamInTournament(tournament.slug, targetCatId, teamId, {
      players: nextPlayers,
    });
  };

  const [undoRoster, setUndoRoster] = useState<{
    action: "populate" | "delete";
    teams: Team[];
    label: string;
    categoryId: string;
  } | null>(null);

  const handleAutoPopulate32Teams = () => {
    const activeCat = categoryId !== "all" ? category : tournament.categories[0];
    if (!activeCat) return;
    const confirmMsg =
      activeCat.teams.length > 0
        ? `Replace current roster in ${activeCat.label} (${activeCat.teams.length} teams) with 32 verified teams?`
        : `Generate and populate 32 verified teams for ${activeCat.label}?`;
    if (!window.confirm(confirmMsg)) return;

    setUndoRoster({
      action: "populate",
      teams: [...activeCat.teams],
      label: `Previous roster (${activeCat.teams.length} teams in ${activeCat.label})`,
      categoryId: activeCat.id,
    });

    const generated = generate32Teams({ verifiedOnly: true });
    bulkSetTeamsInCategory(tournament.slug, activeCat.id, generated);

    const nextPay: Record<string, boolean> = { ...paymentMap };
    generated.forEach((t) => {
      nextPay[t.id] = t.paid ?? true;
    });
    setPaymentMap(nextPay);
  };

  const handleDeleteAllPlayers = () => {
    const activeCat = categoryId !== "all" ? category : tournament.categories[0];
    if (!activeCat || activeCat.teams.length === 0) return;
    if (!window.confirm(`Delete all ${activeCat.teams.length} players and teams from ${activeCat.label}? This will clear the category roster and any bracket draws.`)) return;

    setUndoRoster({
      action: "delete",
      teams: [...activeCat.teams],
      label: `Deleted roster (${activeCat.teams.length} teams in ${activeCat.label})`,
      categoryId: activeCat.id,
    });

    deleteAllTeamsInCategory(tournament.slug, activeCat.id);
    setPaymentMap({});
  };

  const handleUndoRoster = () => {
    if (!undoRoster) return;
    bulkSetTeamsInCategory(tournament.slug, undoRoster.categoryId, undoRoster.teams);

    const nextPay: Record<string, boolean> = {};
    undoRoster.teams.forEach((t) => {
      nextPay[t.id] = t.paid ?? true;
    });
    setPaymentMap(nextPay);
    setUndoRoster(null);
  };

  // Overall Tournament Totals for CSV / Excel exports
  const totalTournTeams = (tournament.categories || []).reduce(
    (sum, c) => sum + (c.teams?.length || 0),
    0
  );
  const totalTournPaid = (tournament.categories || []).reduce(
    (sum, c) => sum + (c.teams || []).filter((t) => resolvedMap[t.id]).length,
    0
  );
  const totalTournUnpaid = Math.max(0, totalTournTeams - totalTournPaid);

  // Current scope counts
  const currentScopeTeamsCount = targetCategories.reduce(
    (sum, c) => sum + (c.teams?.length || 0),
    0
  );
  const currentScopePaidCount = targetCategories.reduce(
    (sum, c) => sum + (c.teams || []).filter((t) => resolvedMap[t.id]).length,
    0
  );
  const currentScopeUnpaidCount = Math.max(0, currentScopeTeamsCount - currentScopePaidCount);

  // Aggregated Team Card Structure
  type TeamDivisionEntry = {
    category: Category;
    team: Team;
  };

  type AggregatedTeam = {
    key: string;
    name: string;
    club?: string | undefined;
    divisions: TeamDivisionEntry[];
    totalPlayers: number;
    allPaid: boolean;
  };

  const aggregatedTeams = useMemo(() => {
    const map = new Map<string, AggregatedTeam>();

    targetCategories.forEach((cat) => {
      (cat.teams || []).forEach((team) => {
        const key = team.name.trim().toLowerCase();
        if (!key) return;

        const isPaid = resolvedMap[team.id] ?? team.paid ?? true;
        const entry: TeamDivisionEntry = {
          category: cat,
          team,
        };

        const existing = map.get(key);
        if (!existing) {
          map.set(key, {
            key,
            name: team.name.trim(),
            club: team.club,
            divisions: [entry],
            totalPlayers: team.players.length,
            allPaid: isPaid,
          });
        } else {
          existing.divisions.push(entry);
          existing.totalPlayers += team.players.length;
          if (team.club && !existing.club) {
            existing.club = team.club;
          }
          if (!isPaid) {
            existing.allPaid = false;
          }
        }
      });
    });

    return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
  }, [targetCategories, resolvedMap]);

  // Filtered aggregated teams
  const visibleAggregatedTeams = useMemo(() => {
    return aggregatedTeams.filter((agg) => {
      if (filter === "paid" && !agg.allPaid) return false;
      if (filter === "unpaid" && agg.allPaid) return false;

      if (teamSearchQuery.trim()) {
        const q = teamSearchQuery.trim().toLowerCase();
        const matchName = agg.name.toLowerCase().includes(q);
        const matchClub = agg.club?.toLowerCase().includes(q) ?? false;
        const matchPlayer = agg.divisions.some((d) =>
          d.team.players.some((p) => p.toLowerCase().includes(q))
        );
        const matchDivision = agg.divisions.some((d) =>
          d.category.label.toLowerCase().includes(q)
        );
        if (!matchName && !matchClub && !matchPlayer && !matchDivision) {
          return false;
        }
      }

      return true;
    });
  }, [aggregatedTeams, filter, teamSearchQuery]);

  const toggleTeamExpanded = (teamKey: string) => {
    setExpandedTeamKeys((prev) => {
      const next = new Set(prev);
      if (next.has(teamKey)) {
        next.delete(teamKey);
      } else {
        next.add(teamKey);
      }
      return next;
    });
  };

  const handleExpandAll = () => {
    setExpandedTeamKeys(new Set(visibleAggregatedTeams.map((t) => t.key)));
  };

  const handleCollapseAll = () => {
    setExpandedTeamKeys(new Set());
  };

  // Export handlers
  const handleExportCategory = (filterType: CsvExportFilter = "all") => {
    try {
      const res = exportCategoryTeamsToCsv(
        tournament,
        category,
        filterType,
        resolvedMap
      );
      setExportNotification(`Exported ${res.count} entries from ${category.label} to ${res.filename}`);
      setIsExportMenuOpen(false);
      setTimeout(() => setExportNotification(null), 5000);
    } catch (err: any) {
      alert("Failed to export CSV: " + (err?.message || "Unknown error"));
    }
  };

  const handleExportTournament = (filterType: CsvExportFilter = "all") => {
    try {
      const res = exportTournamentTeamsToCsv(
        tournament,
        filterType,
        resolvedMap
      );
      setExportNotification(`Exported master roster table (${res.count} entries) to ${res.filename}`);
      setIsExportMenuOpen(false);
      setTimeout(() => setExportNotification(null), 5000);
    } catch (err: any) {
      alert("Failed to export CSV: " + (err?.message || "Unknown error"));
    }
  };

  const handleExportWholeGrouped = (filterType: CsvExportFilter = "all") => {
    try {
      const res = exportTournamentGroupedPerCategoryCsv(
        tournament,
        filterType,
        resolvedMap,
        undefined,
        true
      );
      setExportNotification(
        `Exported whole tournament (${res.count} teams across ${res.categoryCount} categories) to ${res.filename}`
      );
      setIsExportMenuOpen(false);
      setTimeout(() => setExportNotification(null), 5000);
    } catch (err: any) {
      alert("Failed to export CSV: " + (err?.message || "Unknown error"));
    }
  };

  const handleExportBatchSeparately = async (filterType: CsvExportFilter = "all") => {
    try {
      setExportNotification(`Preparing individual CSV files for all ${tournament.categories?.length || 0} categories...`);
      const res = await exportAllCategoriesSeparately(
        tournament,
        filterType,
        resolvedMap
      );
      setExportNotification(
        `Downloaded ${res.totalCategories} separate category files (${res.totalTeams} total teams).`
      );
      setIsExportMenuOpen(false);
      setTimeout(() => setExportNotification(null), 6000);
    } catch (err: any) {
      alert("Failed to export category files: " + (err?.message || "Unknown error"));
    }
  };

  const handleExportExcelWorkbook = async () => {
    try {
      const res = await exportTournamentToExcelWorkbook(
        tournament,
        resolvedMap
      );
      setExportNotification(
        `Generated multi-tab Excel workbook (${res.sheetCount} sheets, ${res.totalTeams} teams) to ${res.filename}`
      );
      setIsExportMenuOpen(false);
      setTimeout(() => setExportNotification(null), 6000);
    } catch (err: any) {
      alert("Failed to export Excel workbook: " + (err?.message || "Unknown error"));
    }
  };

  return (
    <div className="max-w-4xl space-y-6">


      {/* Header and Export Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <span className="text-xs uppercase tracking-[0.28em] text-pickle font-bold">Roster management</span>
          <h2 className="mt-1 font-display text-3xl text-foreground">Teams &amp; Payment Verification</h2>
        </div>

        {/* Export Controls */}
        <div className="flex items-center gap-2 flex-wrap self-start sm:self-auto">
          <button
            type="button"
            onClick={handleExportExcelWorkbook}
            className="inline-flex items-center gap-2 px-4 py-2 bg-pickle hover:opacity-90 text-white text-xs font-mono font-bold uppercase tracking-wider rounded transition-all cursor-pointer shadow-sm"
            title="Download presentable Excel workbook with a dedicated tab for each category"
          >
            <svg className="w-4 h-4 text-white" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <span>Export Excel (.xlsx)</span>
            <span className="bg-black/30 text-white px-1.5 py-0.5 rounded text-[0.65rem] font-bold">
              Tab per Category
            </span>
          </button>

          <button
            type="button"
            onClick={() => handleExportWholeGrouped("all")}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-card border-2 border-border hover:border-pickle text-foreground text-xs font-mono font-bold uppercase tracking-wider rounded transition-all cursor-pointer shadow-sm"
            title="Download whole tournament CSV grouped per category"
          >
            <svg className="w-3.5 h-3.5 text-pickle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <span>Whole CSV</span>
          </button>

          <div className="relative">
            <button
              type="button"
              onClick={() => setIsExportMenuOpen(!isExportMenuOpen)}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-card border-2 border-border hover:border-pickle text-foreground text-xs font-mono font-bold uppercase tracking-wider rounded transition-all cursor-pointer shadow-sm"
              title="More export formats"
            >
              <span>Options</span>
              <svg
                className={`w-3.5 h-3.5 text-foreground transition-transform ${isExportMenuOpen ? "rotate-180" : ""}`}
                fill="none" stroke="currentColor" viewBox="0 0 24 24"
              >
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
              </svg>
            </button>

            {isExportMenuOpen && (
              <>
                <div
                  className="fixed inset-0 z-30"
                  onClick={() => setIsExportMenuOpen(false)}
                />
                <div className="absolute right-0 mt-2 w-80 sm:w-88 bg-card border-2 border-border rounded-lg shadow-2xl p-2 z-40 animate-in fade-in zoom-in-95 space-y-1">
                  <div className="px-3 py-2 border-b-2 border-border">
                    <span className="text-[0.65rem] uppercase font-mono tracking-wider text-pickle font-bold block">
                      Spreadsheet Exports
                    </span>
                    <span className="text-[0.7rem] text-foreground/80 font-medium">
                      Multi-tab Excel workbooks &amp; CSV files
                    </span>
                  </div>

                  <button
                    type="button"
                    onClick={handleExportExcelWorkbook}
                    className="w-full text-left px-3 py-2.5 rounded bg-pickle/15 hover:bg-pickle/25 border border-pickle/40 transition-colors cursor-pointer group"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-foreground group-hover:text-pickle transition-colors">
                        Excel Multi-Tab Workbook (.xlsx)
                      </span>
                      <span className="text-[0.65rem] font-mono bg-pickle text-white font-bold px-1.5 py-0.5 rounded">
                        Tab per Category
                      </span>
                    </div>
                    <span className="text-[0.65rem] text-foreground/80 font-medium block mt-0.5">
                      Overview sheet + individual sheet tabs for all {tournament.categories?.length || 0} categories
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportWholeGrouped("all")}
                    className="w-full text-left px-3 py-2.5 rounded hover:bg-background transition-colors cursor-pointer group"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-foreground group-hover:text-pickle transition-colors">
                        Whole Tournament CSV (Grouped)
                      </span>
                      <span className="text-[0.65rem] font-mono bg-background border border-border px-1.5 py-0.5 rounded text-foreground font-bold">
                        {totalTournTeams} teams
                      </span>
                    </div>
                    <span className="text-[0.65rem] text-foreground/80 font-medium block mt-0.5">
                      Single CSV with category headers &amp; subtotals
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportTournament("all")}
                    className="w-full text-left px-3 py-2.5 rounded hover:bg-background transition-colors cursor-pointer group"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-foreground group-hover:text-pickle transition-colors">
                        Whole Tournament CSV (Flat Table)
                      </span>
                      <span className="text-[0.65rem] font-mono bg-background border border-border px-1.5 py-0.5 rounded text-foreground font-bold">
                        Standard Table
                      </span>
                    </div>
                    <span className="text-[0.65rem] text-foreground/80 font-medium block mt-0.5">
                      Continuous rows for Excel auto-filters &amp; pivot tables
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportBatchSeparately("all")}
                    className="w-full text-left px-3 py-2.5 rounded hover:bg-background transition-colors cursor-pointer group border-t border-border"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-foreground group-hover:text-pickle transition-colors">
                        Batch Export (Separate CSV per Category)
                      </span>
                      <span className="text-[0.65rem] font-mono bg-background border border-border px-1.5 py-0.5 rounded text-foreground font-bold">
                        {tournament.categories?.length || 0} files
                      </span>
                    </div>
                    <span className="text-[0.65rem] text-foreground/80 font-medium block mt-0.5">
                      Downloads individual CSV files for each division in 1 click
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportCategory("all")}
                    className="w-full text-left px-3 py-2.5 rounded hover:bg-background transition-colors cursor-pointer group border-t border-border"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-foreground group-hover:text-pickle transition-colors">
                        Export Current Category Only
                      </span>
                      <span className="text-[0.65rem] font-mono bg-background border border-border px-1.5 py-0.5 rounded text-foreground font-bold">
                        {category.teams.length} teams
                      </span>
                    </div>
                    <span className="text-[0.65rem] text-foreground/80 font-medium block mt-0.5">
                      {category.label} verified &amp; pending entries
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportWholeGrouped("verified-only")}
                    className="w-full text-left px-3 py-2.5 rounded hover:bg-background transition-colors cursor-pointer group"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-pickle">
                        Export Verified Rosters Only
                      </span>
                      <span className="text-[0.65rem] font-mono bg-pickle/20 text-pickle px-1.5 py-0.5 rounded font-bold">
                        {totalTournPaid} paid
                      </span>
                    </div>
                    <span className="text-[0.65rem] text-foreground/80 font-medium block mt-0.5">
                      Confirmed teams ready for bracket draws across all categories
                    </span>
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </div>

      {/* Export notification banner */}
      {exportNotification && (
        <div className="surface-card flex items-center justify-between p-3.5 bg-pickle/15 border-2 border-pickle/40 rounded-lg text-xs animate-in fade-in duration-300">
          <div className="flex items-center gap-2.5">
            <span className="h-2 w-2 rounded-full bg-pickle animate-ping" />
            <span className="text-foreground font-mono font-bold">
              {exportNotification}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setExportNotification(null)}
            className="text-[0.7rem] text-foreground hover:text-brick uppercase tracking-wider font-bold cursor-pointer px-1.5 py-1"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Scope Selector: Tournament & Category */}
      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
        <select
          value={tournamentSlug}
          onChange={(e) => {
            setTournamentSlug(e.target.value);
            setPaymentMap({});
            setFilter("all");
            setUndoRoster(null);
            setExpandedTeamKeys(new Set());
          }}
          className="w-full border-2 border-input bg-card px-3 py-2.5 text-sm focus:border-pickle focus:outline-none font-bold text-foreground rounded-lg shadow-xs"
        >
          {tourns.map((t) => (
            <option key={t.slug} value={t.slug}>{t.name}</option>
          ))}
        </select>
        <select
          value={categoryId}
          onChange={(e) => {
            setCategoryId(e.target.value);
            setPaymentMap({});
            setFilter("all");
            setUndoRoster(null);
            setExpandedTeamKeys(new Set());
          }}
          className="w-full border-2 border-input bg-card px-3 py-2.5 text-sm focus:border-pickle focus:outline-none font-bold text-foreground rounded-lg shadow-xs"
        >
          <option value="all">
            All Divisions &amp; Categories ({totalTournTeams} Teams)
          </option>
          {tournament.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} ({c.teams?.length || 0} teams)
            </option>
          ))}
        </select>
      </div>

      {/* Undo Banner if an action just occurred */}
      {undoRoster && (
        <div className="surface-card flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 bg-pickle/15 border-2 border-pickle/40 rounded-lg text-xs animate-in fade-in duration-300">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-pickle animate-pulse" />
            <span className="text-foreground font-bold">
              {undoRoster.action === "populate"
                ? `Populated 32 teams into roster.`
                : `Deleted all teams from roster.`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleUndoRoster}
              className="px-3 py-1.5 bg-pickle text-white font-bold uppercase tracking-wider text-[0.7rem] rounded hover:opacity-90 transition-opacity cursor-pointer shadow-sm"
            >
              Undo Action ({undoRoster.label})
            </button>
            <button
              type="button"
              onClick={() => setUndoRoster(null)}
              className="text-[0.7rem] text-foreground hover:text-brick uppercase tracking-wider font-bold cursor-pointer px-1.5 py-1"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Quick Staging Actions Bar */}
      <div className="surface-card flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 border-2 border-border rounded-xl">
        <div>
          <span className="text-xs font-bold uppercase tracking-widest text-foreground block">
            Roster Actions &amp; Export
          </span>
          <span className="text-[0.7rem] text-foreground/80 font-medium">
            Auto-populate 32 verified doubles teams, clear rosters, or export to Excel and Google Sheets.
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {undoRoster && (
            <button
              type="button"
              onClick={handleUndoRoster}
              className="px-3.5 py-2 border-2 border-pickle bg-pickle/20 text-pickle hover:bg-pickle hover:text-white font-bold text-xs tracking-wider uppercase rounded transition-all cursor-pointer"
            >
              Undo ({undoRoster.action === "populate" ? "Revert Roster" : "Restore Players"})
            </button>
          )}
          <button
            type="button"
            onClick={handleExportExcelWorkbook}
            className="px-3.5 py-2 border-2 border-pickle bg-pickle/15 text-pickle hover:bg-pickle hover:text-white font-mono font-bold text-xs tracking-wider uppercase rounded transition-all cursor-pointer shadow-xs inline-flex items-center gap-1.5"
            title="Download multi-tab Excel file with a sheet per category"
          >
            <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Export Excel (.xlsx)
          </button>
          <button
            type="button"
            onClick={() => handleExportWholeGrouped("all")}
            className="px-3.5 py-2 border-2 border-border bg-card text-foreground hover:border-pickle hover:text-pickle font-mono font-bold text-xs tracking-wider uppercase rounded transition-all cursor-pointer shadow-xs inline-flex items-center gap-1.5"
            title="Download whole tournament CSV grouped by category"
          >
            <svg className="w-3.5 h-3.5 text-pickle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            Whole CSV
          </button>
          <button
            type="button"
            onClick={() => handleExportCategory("all")}
            className="px-3 py-2 border-2 border-border bg-card text-foreground hover:border-pickle hover:text-pickle font-mono font-bold text-xs tracking-wider uppercase rounded transition-all cursor-pointer shadow-xs"
            title={`Download CSV for ${category.label} only`}
          >
            Export {category.label}
          </button>
          <button
            type="button"
            onClick={handleAutoPopulate32Teams}
            className="px-3.5 py-2 bg-pickle text-white hover:opacity-90 font-bold text-xs tracking-wider uppercase rounded transition-all cursor-pointer shadow-sm"
          >
            Auto-Populate 32 Teams
          </button>
          <button
            type="button"
            onClick={handleDeleteAllPlayers}
            disabled={category.teams.length === 0}
            className={`px-3.5 py-2 border font-bold text-xs tracking-wider uppercase rounded transition-all ${
              category.teams.length > 0
                ? "border-2 border-brick bg-brick/15 text-brick hover:bg-brick hover:text-white cursor-pointer"
                : "border-2 border-border bg-card text-foreground/40 cursor-not-allowed"
            }`}
          >
            Delete All Players {category.teams.length > 0 ? `(${category.teams.length})` : "(0)"}
          </button>
        </div>
      </div>

      {/* Payment Summary Bar */}
      <div className="surface-card p-4 sm:p-6 space-y-4 border-2 border-border rounded-xl">
        <div className="grid grid-cols-3 gap-2 sm:gap-6 divide-x-2 divide-border">
          <div className="text-center px-1">
            <p className="font-display text-3xl sm:text-4xl text-foreground font-bold">
              {currentScopeTeamsCount}
            </p>
            <p className="text-[0.7rem] sm:text-xs uppercase tracking-widest text-foreground/80 font-bold">
              {isAllCategories ? "Total Entries" : "Category Entries"}
            </p>
          </div>
          <div className="text-center px-1">
            <p className="font-display text-3xl sm:text-4xl text-pickle font-bold">
              {currentScopePaidCount}
            </p>
            <p className="text-[0.7rem] sm:text-xs uppercase tracking-widest text-foreground/80 font-bold">
              Paid
            </p>
          </div>
          <div className="text-center px-1">
            <p className="font-display text-3xl sm:text-4xl text-brick font-bold">
              {currentScopeUnpaidCount}
            </p>
            <p className="text-[0.7rem] sm:text-xs uppercase tracking-widest text-foreground/80 font-bold">
              Unpaid
            </p>
          </div>
        </div>

        {/* Full-width progress bar */}
        <div className="pt-2 border-t-2 border-border">
          <div className="mb-1.5 flex justify-between text-xs text-foreground font-bold">
            <span>Payment progress</span>
            <span className="font-mono text-pickle">
              {currentScopeTeamsCount > 0
                ? Math.round((currentScopePaidCount / currentScopeTeamsCount) * 100)
                : 0}
              %
            </span>
          </div>
          <div className="h-2.5 w-full overflow-hidden rounded-full bg-background border border-border">
            <div
              className="h-full rounded-full bg-pickle transition-all duration-500"
              style={{
                width: `${
                  currentScopeTeamsCount > 0
                    ? (currentScopePaidCount / currentScopeTeamsCount) * 100
                    : 0
                }%`,
              }}
            />
          </div>
        </div>
      </div>

      {/* Add team / pair row */}
      <div className="surface-card p-4 sm:p-5 border-2 border-border rounded-xl space-y-4 bg-card shadow-xs">
        <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-border pb-3">
          <div>
            <span className="text-xs font-bold uppercase tracking-widest text-foreground block">
              Register or Add Team
            </span>
            <span className="text-[0.7rem] text-foreground/80 font-mono font-bold">
              {isAllCategories ? "Select division below" : `Adding to ${category.label}`}
            </span>
          </div>

        </div>

        {/* Division target selector */}
        <div className="flex items-center gap-2">
          <label className="text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground whitespace-nowrap">
            Target Division:
          </label>
          <select
            value={targetNewCategory}
            onChange={(e) => setTargetNewCategory(e.target.value)}
            className="flex-1 border-2 border-input bg-background px-3 py-1.5 text-xs font-mono font-bold text-foreground focus:border-pickle focus:outline-none rounded"
          >
            {tournament.categories.map((c) => (
              <option key={c.id} value={c.id}>
                {c.label} ({c.level} · {c.division}) &mdash; {c.teams?.length || 0} teams
              </option>
            ))}
          </select>
        </div>

        {teamAddError && (
          <div className="p-3 rounded-lg bg-brick/15 border border-brick/40 text-xs text-brick font-bold flex items-center justify-between">
            <span>{teamAddError}</span>
            <button
              type="button"
              onClick={() => setTeamAddError(null)}
              className="text-[0.65rem] text-brick hover:text-foreground uppercase cursor-pointer"
            >
              Dismiss
            </button>
          </div>
        )}

        <div className="flex flex-wrap gap-2">
          <input
            value={newTeamName}
            onChange={(e) => setNewTeamName(e.target.value)}
            placeholder="Team name (e.g. Smash Bros)"
            className="flex-1 min-w-[140px] border-2 border-input bg-background px-3 py-2 text-sm text-foreground font-medium focus:border-pickle focus:outline-none rounded"
          />
          <input
            value={newPlayers}
            onChange={(e) => setNewPlayers(e.target.value)}
            placeholder="Player 1 / Player 2"
            className="flex-1 min-w-[160px] border-2 border-input bg-background px-3 py-2 text-sm text-foreground font-medium focus:border-pickle focus:outline-none rounded"
          />
          <button
            type="button"
            onClick={handleCreateTeam}
            className="bg-pickle px-4 py-2 text-xs font-mono font-bold uppercase tracking-wider text-white hover:opacity-90 cursor-pointer shadow-xs whitespace-nowrap rounded"
          >
            + Add Pair
          </button>
        </div>
      </div>

      {/* Filter tabs, Search & Bulk expand */}
      <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-3">
        {/* Status segmented buttons */}
        <div className="grid grid-cols-3 p-1 bg-background rounded-lg border-2 border-border sm:flex sm:bg-transparent sm:border-0 sm:border-b-2 sm:border-border sm:p-0 sm:rounded-none sm:gap-1">
          {(["all", "paid", "unpaid"] as const).map((f) => (
            <button
              key={f}
              onClick={() => setFilter(f)}
              className={`py-2 px-2 sm:px-4 text-[0.7rem] sm:text-xs font-bold uppercase tracking-wider text-center transition-all cursor-pointer rounded sm:rounded-none sm:border-b-2 ${
                filter === f
                  ? "bg-brick text-white sm:bg-transparent sm:border-brick sm:text-brick font-bold shadow-sm"
                  : "text-foreground/80 hover:text-foreground sm:border-transparent font-bold"
              }`}
            >
              {f === "all"
                ? `All (${aggregatedTeams.length})`
                : f === "paid"
                ? `Paid (${aggregatedTeams.filter((t) => t.allPaid).length})`
                : `Unpaid (${aggregatedTeams.filter((t) => !t.allPaid).length})`}
            </button>
          ))}
        </div>

        {/* Search & Bulk expand */}
        <div className="flex items-center gap-2">
          <div className="relative flex-1 sm:w-60">
            <input
              type="text"
              value={teamSearchQuery}
              onChange={(e) => setTeamSearchQuery(e.target.value)}
              placeholder="Search team or player..."
              className="w-full border-2 border-border bg-card text-foreground px-3 py-1.5 text-xs rounded focus:border-pickle focus:outline-none font-mono font-bold placeholder:text-foreground/50"
            />
            {teamSearchQuery && (
              <button
                type="button"
                onClick={() => setTeamSearchQuery("")}
                className="absolute right-2 top-1/2 -translate-y-1/2 text-foreground/70 hover:text-foreground font-bold text-xs"
              >
                &times;
              </button>
            )}
          </div>
          <button
            type="button"
            onClick={
              expandedTeamKeys.size === visibleAggregatedTeams.length
                ? handleCollapseAll
                : handleExpandAll
            }
            className="px-3 py-1.5 text-[0.65rem] font-mono font-bold uppercase tracking-wider border-2 border-border bg-card text-foreground hover:text-pickle hover:border-pickle rounded transition-colors whitespace-nowrap cursor-pointer shadow-xs"
            title="Toggle expand all cards"
          >
            {expandedTeamKeys.size === visibleAggregatedTeams.length && visibleAggregatedTeams.length > 0
              ? "Collapse All"
              : "Expand All"}
          </button>
        </div>
      </div>

      {/* ── Team list: Clickable Collapsed Team Cards by default; clicking reveals division pairs ── */}
      <div className="space-y-3">
        {visibleAggregatedTeams.length === 0 ? (
          <div className="surface-card p-8 text-center text-sm font-semibold text-foreground border-2 border-border rounded-xl bg-card">
            {teamSearchQuery
              ? `No teams matching "${teamSearchQuery}".`
              : "No teams found matching current filters."}
          </div>
        ) : (
          visibleAggregatedTeams.map((teamCard) => {
            const isExpanded = expandedTeamKeys.has(teamCard.key);

            return (
              <div
                key={teamCard.key}
                className="surface-card bg-card border-2 border-border rounded-xl overflow-hidden transition-all duration-200 hover:border-pickle shadow-sm"
              >
                {/* Team Card: Click anywhere on header to toggle expansion */}
                <div
                  role="button"
                  tabIndex={0}
                  onClick={() => toggleTeamExpanded(teamCard.key)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      toggleTeamExpanded(teamCard.key);
                    }
                  }}
                  className="w-full text-left p-4 sm:p-5 flex flex-col md:flex-row md:items-center justify-between gap-3 cursor-pointer group select-none hover:bg-background/40 transition-colors"
                >
                  {/* Left Column: Team Identity & Division Badges */}
                  <div className="space-y-1.5 min-w-0">
                    <div className="flex items-center gap-2.5 flex-wrap">
                      <h4 className="font-display text-2xl sm:text-3xl text-foreground font-bold tracking-tight group-hover:text-pickle transition-colors">
                        {teamCard.name}
                      </h4>
                      {teamCard.club && (
                        <span className="px-2.5 py-0.5 text-xs font-bold uppercase tracking-wider bg-card text-foreground border-2 border-border rounded font-mono">
                          {teamCard.club}
                        </span>
                      )}
                    </div>

                    <div className="flex items-center gap-2 flex-wrap pt-0.5">
                      {teamCard.divisions.map((divEntry) => (
                        <span
                          key={divEntry.category.id}
                          className="px-2 py-0.5 text-xs font-mono rounded bg-pickle/15 border border-pickle/40 text-pickle font-bold"
                        >
                          {divEntry.category.label}
                        </span>
                      ))}
                      <span className="text-xs text-foreground font-mono font-bold">
                        &bull; {teamCard.divisions.length} {teamCard.divisions.length === 1 ? "Division" : "Divisions"} &bull; {teamCard.totalPlayers} Players ({Math.round(teamCard.totalPlayers / 2)} Pairs)
                      </span>
                    </div>
                  </div>

                  {/* Right Column: Overall Status Badge & Expand Indicator */}
                  <div className="flex items-center gap-2.5 shrink-0 self-start md:self-center">
                    {teamCard.allPaid ? (
                      <span className="px-3 py-1 text-xs font-mono font-bold uppercase tracking-wider bg-pickle/15 text-pickle border-2 border-pickle/40 rounded-full inline-flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-pickle" />
                        Paid
                      </span>
                    ) : (
                      <span className="px-3 py-1 text-xs font-mono font-bold uppercase tracking-wider bg-brick/15 text-brick border-2 border-brick/40 rounded-full inline-flex items-center gap-1.5">
                        <span className="h-2 w-2 rounded-full bg-brick" />
                        Unpaid
                      </span>
                    )}

                    <span
                      className={`inline-flex items-center gap-1.5 px-3 py-1.5 text-xs font-mono font-bold uppercase tracking-wider rounded border-2 transition-all ${
                        isExpanded
                          ? "border-pickle bg-pickle text-white font-bold"
                          : "border-2 border-border bg-card text-foreground font-bold hover:border-pickle hover:text-pickle"
                      }`}
                    >
                      <span>{isExpanded ? "Hide Pairs" : "View Pairs"}</span>
                      <svg
                        className={`w-3.5 h-3.5 transition-transform duration-200 ${isExpanded ? "rotate-180" : ""}`}
                        fill="none"
                        stroke="currentColor"
                        viewBox="0 0 24 24"
                      >
                        <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                      </svg>
                    </span>
                  </div>
                </div>

                {/* ── Expanded Content: Division-by-division pairs and players ── */}
                {isExpanded && (
                  <div className="border-t-2 border-border bg-card p-4 sm:p-5 space-y-4 animate-in fade-in duration-200">
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold uppercase tracking-[0.25em] text-pickle block">
                        Division Breakdown &amp; Pairs ({teamCard.divisions.length})
                      </span>
                      <span className="text-xs text-foreground font-mono font-bold">
                        Click division controls to verify or update player rosters
                      </span>
                    </div>

                    <div className="space-y-3.5">
                      {teamCard.divisions.map((divEntry) => {
                        const divTeam = divEntry.team;
                        const divCat = divEntry.category;
                        const isDivPaid = resolvedMap[divTeam.id] ?? divTeam.paid ?? false;

                        return (
                          <div
                            key={divCat.id}
                            className="bg-card border-2 border-border rounded-xl p-4 space-y-3 shadow-xs"
                          >
                            {/* Division Title and Status Header */}
                            <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2.5 pb-2.5 border-b-2 border-border">
                              <div className="flex items-center gap-2 flex-wrap">
                                <span className="font-display text-lg sm:text-xl text-foreground font-bold">
                                  {divCat.label}
                                </span>
                                <span className="px-2 py-0.5 text-xs font-mono font-bold uppercase tracking-wider bg-card border-2 border-border text-foreground rounded">
                                  {divCat.level}
                                </span>
                                <span className="px-2 py-0.5 text-xs font-mono font-bold uppercase tracking-wider bg-card border-2 border-border text-foreground rounded">
                                  {divCat.division}
                                </span>
                                {divCat.fee && (
                                  <span className="px-2 py-0.5 text-xs font-mono text-pickle border-2 border-pickle/40 bg-pickle/15 rounded font-bold">
                                    Fee: {divCat.fee}
                                  </span>
                                )}
                              </div>

                              {/* Division Actions */}
                              <div className="flex items-center gap-2 flex-wrap shrink-0">
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    togglePaid(divTeam.id, divCat.id);
                                  }}
                                  title={isDivPaid ? "Click to set unpaid" : "Click to mark paid"}
                                  className={`rounded-full px-3 py-1 text-xs font-bold uppercase tracking-widest font-mono transition-colors cursor-pointer ${
                                    isDivPaid
                                      ? "bg-pickle/20 text-pickle hover:bg-pickle/30 border-2 border-pickle/40"
                                      : "bg-brick/20 text-brick hover:bg-brick/30 border-2 border-brick/40"
                                  }`}
                                >
                                  {isDivPaid ? "Paid" : "Unpaid"}
                                </button>

                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleRemoveTeam(divTeam.id, divTeam.name, divCat.id);
                                  }}
                                  className="px-2.5 py-1 border-2 border-brick/40 bg-brick/10 text-brick hover:bg-brick hover:text-white text-xs font-mono font-bold uppercase tracking-wider rounded transition-colors cursor-pointer"
                                  title={`Remove from ${divCat.label}`}
                                >
                                  Remove
                                </button>
                              </div>
                            </div>

                            {/* Doubles Pair / Players Grid */}
                            <div className="space-y-2">
                              <div className="flex items-center justify-between">
                                <span className="text-xs font-bold uppercase tracking-wider text-foreground">
                                  Doubles Pair / Players
                                </span>
                                <button
                                  type="button"
                                  onClick={(e) => {
                                    e.stopPropagation();
                                    handleAddPlayerToTeam(divTeam.id, divCat.id);
                                  }}
                                  className="text-xs font-bold uppercase tracking-wider text-pickle hover:underline transition-colors cursor-pointer inline-flex items-center gap-1"
                                >
                                  <span>+ Add Player</span>
                                </button>
                              </div>

                              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                                {divTeam.players.map((playerName, pIdx) => (
                                  <div
                                    key={`${divCat.id}-${divTeam.id}-p-${pIdx}`}
                                    className="flex items-center justify-between gap-2.5 p-3 rounded-lg bg-card border-2 border-border hover:border-pickle transition-colors"
                                  >
                                    <div className="flex items-center gap-2.5 min-w-0">
                                      <span className="h-7 w-7 rounded-full bg-pickle/20 border-2 border-pickle text-pickle font-mono text-xs font-bold flex items-center justify-center shrink-0">
                                        P{pIdx + 1}
                                      </span>
                                      <div className="min-w-0">
                                        <span className="text-sm font-bold text-foreground truncate block">
                                          {playerName}
                                        </span>
                                        <span className="text-[0.65rem] text-foreground font-mono font-bold uppercase tracking-wider block">
                                          {pIdx === 0 ? "Player 1" : pIdx === 1 ? "Player 2" : `Player ${pIdx + 1}`}
                                        </span>
                                      </div>
                                    </div>

                                    <div className="flex items-center gap-1.5 shrink-0">
                                      <button
                                        type="button"
                                        onClick={(e) => {
                                          e.stopPropagation();
                                          handleEditPlayerName(divTeam.id, pIdx, playerName, divCat.id);
                                        }}
                                        className="text-xs px-2.5 py-1 font-bold uppercase tracking-wider text-foreground hover:text-pickle border-2 border-border bg-card rounded hover:border-pickle transition-colors cursor-pointer font-mono"
                                        title="Edit Player Name"
                                      >
                                        Edit
                                      </button>
                                      {divTeam.players.length > 2 && (
                                        <button
                                          type="button"
                                          onClick={(e) => {
                                            e.stopPropagation();
                                            handleRemovePlayerFromTeam(divTeam.id, pIdx, divCat.id);
                                          }}
                                          className="text-xs px-2 py-1 text-brick hover:bg-brick hover:text-white rounded border border-brick/40 transition-colors cursor-pointer font-bold"
                                          title="Remove Player"
                                        >
                                          &times;
                                        </button>
                                      )}
                                    </div>
                                  </div>
                                ))}
                              </div>
                            </div>
                          </div>
                        );
                      })}
                    </div>

                    {/* Bottom collapse button */}
                    <div className="pt-2 flex justify-end">
                      <button
                        type="button"
                        onClick={() => toggleTeamExpanded(teamCard.key)}
                        className="text-xs font-mono font-bold uppercase tracking-wider text-foreground hover:text-pickle inline-flex items-center gap-1.5 cursor-pointer px-3 py-1.5 rounded-lg border-2 border-border hover:border-pickle bg-card transition-colors shadow-xs"
                      >
                        <span>Collapse Team Card</span>
                        <svg className="w-3.5 h-3.5 rotate-180" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                          <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2.5} d="M19 9l-7 7-7-7" />
                        </svg>
                      </button>
                    </div>
                  </div>
                )}
              </div>
            );
          })
        )}
      </div>
    </div>
  );
}



/* ────────────────────────────────────────────────
   Shared Field component
──────────────────────────────────────────────── */
function Field({
  label,
  placeholder,
  type = "text",
}: {
  label: string;
  placeholder?: string;
  type?: string;
}) {
  return (
    <label className="block text-sm">
      <span className="mb-1 block text-xs font-bold uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      <input
        type={type}
        placeholder={placeholder}
        className="w-full border border-input bg-background px-3 py-2 focus:border-pickle focus:outline-none transition-colors"
      />
    </label>
  );
}

/* ────────────────────────────────────────────────
   Access Codes Tab -- Generator & Verification Keys
──────────────────────────────────────────────── */
function AccessCodesTab() {
  const [codes, setCodes] = useState<AccessCode[]>(() => getAccessCodes());
  const [role, setRole] = useState<"admin" | "umpire">("admin");
  const [customCode, setCustomCode] = useState("");
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);
  const [recentlyGenerated, setRecentlyGenerated] = useState<string | null>(null);

  useEffect(() => {
    dbGetAccessCodes().then((serverCodes) => {
      if (serverCodes && serverCodes.length > 0) {
        const local = getAccessCodes();
        const codeMap = new Map<string, AccessCode>();
        local.forEach((c) => codeMap.set(c.code.toUpperCase(), c));
        serverCodes.forEach((sc) => {
          const upper = sc.code.toUpperCase();
          codeMap.set(upper, {
            id: sc.id,
            code: upper,
            role: sc.role as "admin" | "umpire",
            createdAt: sc.created_at ? sc.created_at.split("T")[0] : new Date().toISOString().split("T")[0],
            createdBy: sc.created_by_name || "Admin",
            isUsed: Boolean(sc.used_at),
            usedBy: sc.used_by_email || undefined,
          });
        });
        const merged = Array.from(codeMap.values());
        setCodes(merged);
        saveAccessCodes(merged);
      }
    });
  }, []);

  const handleGenerate = (e: React.FormEvent) => {
    e.preventDefault();
    const cleanCustom = customCode.trim().toUpperCase();
    const newEntry = generateNewCode(role, cleanCustom || undefined, "Admin Director");
    setCodes(getAccessCodes());
    setCustomCode("");
    setRecentlyGenerated(newEntry.code);
    navigator.clipboard.writeText(newEntry.code).catch(() => {});
    setTimeout(() => setRecentlyGenerated(null), 5000);
  };

  const handleRevoke = (id: string) => {
    const updated = revokeCode(id);
    setCodes(updated);
  };

  const handleCopy = (id: string, codeStr: string) => {
    navigator.clipboard.writeText(codeStr);
    setCopiedCodeId(id);
    setTimeout(() => setCopiedCodeId(null), 2000);
  };

  const activeCount = codes.filter((c) => !c.isUsed).length;
  const usedCount = codes.filter((c) => c.isUsed).length;

  return (
    <div className="max-w-4xl space-y-6">
      <div>
        <span className="text-xs uppercase tracking-[0.28em] text-pickle font-bold">
          Security &amp; Access Control
        </span>
        <h2 className="mt-1 font-display text-3xl sm:text-4xl text-foreground">
          Registration Access Codes
        </h2>
        <p className="text-xs sm:text-sm text-muted-foreground mt-1">
          Generate single-use or multi-use verification codes so only authorized umpires and directors can create accounts.
        </p>
      </div>

      {/* Code Generator Card */}
      <form onSubmit={handleGenerate} className="surface-card p-6 border-2 border-pickle/40 space-y-4">
        <h3 className="font-display text-2xl text-foreground">Generate New Access Code</h3>

        <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
          <div>
            <label className="block text-xs font-bold uppercase tracking-widest text-muted-foreground mb-1">
              Target Account Role
            </label>
            <select
              value={role}
              onChange={(e) => setRole(e.target.value as "admin" | "umpire")}
              className="w-full border border-input bg-background px-3 py-2 text-sm focus:border-pickle focus:outline-none font-medium"
            >
              <option value="umpire">Umpire / Official</option>
              <option value="admin">Admin / Director</option>
            </select>
          </div>

          <div>
            <label className="block text-xs font-bold uppercase tracking-widest text-muted-foreground mb-1">
              Custom Code (Optional)
            </label>
            <input
              type="text"
              value={customCode}
              onChange={(e) => setCustomCode(e.target.value)}
              placeholder="e.g. UMP-9821 or leave blank for auto"
              className="w-full border border-input bg-background px-3 py-2 text-sm uppercase font-mono focus:border-pickle focus:outline-none"
            />
          </div>

          <div className="flex items-end">
            <button
              type="submit"
              className="w-full bg-pickle text-sand font-display text-xl tracking-widest py-2.5 hover:opacity-90 transition-opacity cursor-pointer shadow-md"
            >
              Generate Code
            </button>
          </div>
        </div>

        {recentlyGenerated && (
          <div className="mt-2 p-3 bg-pickle/20 border border-pickle text-xs text-pickle font-bold flex items-center justify-between">
            <span>
              Generated code <span className="font-mono text-sand underline">{recentlyGenerated}</span> for {role === "admin" ? "Admin / Director" : "Umpire / Official"}. Copied to clipboard!
            </span>
            <span className="text-[0.65rem] text-sand/70 uppercase tracking-widest">Ready for Registration</span>
          </div>
        )}
      </form>

      {/* Access Codes Summary */}
      <div className="surface-card flex items-center gap-6 px-6 py-4 border border-border">
        <div className="text-center">
          <p className="font-display text-4xl text-foreground">{codes.length}</p>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Total Generated</p>
        </div>
        <div className="h-10 w-px bg-border" />
        <div className="text-center">
          <p className="font-display text-4xl text-pickle">{activeCount}</p>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Active &amp; Ready</p>
        </div>
        <div className="h-10 w-px bg-border" />
        <div className="text-center">
          <p className="font-display text-4xl text-brick">{usedCount}</p>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Used / Redeemed</p>
        </div>
      </div>

      {/* Access Codes Table */}
      <div className="surface-card p-0 overflow-hidden border-2 border-border rounded-xl shadow-xs">
        <div className="bg-card px-6 py-4 flex items-center justify-between border-b-2 border-border">
          <span className="text-xs font-bold uppercase tracking-widest text-foreground">
            Generated Access Codes Registry
          </span>
          <span className="text-[0.65rem] font-mono text-foreground font-bold bg-background border border-border px-2 py-0.5 rounded">
            {codes.length} codes
          </span>
        </div>

        <div className="divide-y-2 divide-border overflow-x-auto">
          {codes.map((c) => (
            <div
              key={c.id}
              className={`flex items-center justify-between gap-4 px-6 py-4 text-xs ${
                c.isUsed ? "bg-card opacity-60" : "bg-card"
              }`}
            >
              <div className="flex items-center gap-4 min-w-0">
                <span className="font-mono text-lg font-bold text-foreground tracking-wider bg-card px-3 py-1 border-2 border-border rounded shadow-xs">
                  {c.code}
                </span>

                <div>
                  <div className="flex items-center gap-2">
                    <span
                      className={`font-bold uppercase tracking-widest px-2 py-0.5 text-[0.6rem] rounded ${
                        c.role === "admin"
                          ? "bg-brick/20 text-brick border border-brick/40"
                          : "bg-pickle/20 text-pickle border border-pickle/40"
                      }`}
                    >
                      {c.role === "admin" ? "Admin Code" : "Umpire Code"}
                    </span>

                    <span
                      className={`font-bold uppercase tracking-widest text-[0.6rem] ${
                        c.isUsed ? "text-brick font-bold" : "text-pickle font-bold"
                      }`}
                    >
                      {c.isUsed ? `Used by ${c.usedBy}` : "Active"}
                    </span>
                  </div>
                  <span className="block text-[0.65rem] text-foreground/80 font-bold mt-0.5">
                    Created on {c.createdAt} by {c.createdBy}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => handleCopy(c.id, c.code)}
                  className="px-3 py-1.5 border-2 border-border bg-card text-foreground text-[0.65rem] font-bold uppercase tracking-widest hover:border-pickle hover:text-pickle transition-colors cursor-pointer rounded shadow-xs"
                >
                  {copiedCodeId === c.id ? "Copied!" : "Copy Code"}
                </button>

                <button
                  onClick={() => handleRevoke(c.id)}
                  className="px-2.5 py-1.5 text-xs font-bold uppercase tracking-widest text-brick hover:bg-brick/10 transition-colors cursor-pointer"
                >
                  Revoke
                </button>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
