import { createFileRoute, useNavigate, Link, useRouter } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import type { Team, Tournament, Category } from "@/data/tournaments";
import { DrawsManager } from "@/components/admin/DrawsManager";
import { BracketDraw } from "@/components/admin/BracketDraw";
import { CourtDispatch } from "@/components/admin/CourtDispatch";
import { TournamentsManager } from "@/components/admin/TournamentsManager";
import {
  useTournamentStore,
  getTournaments,
  addTeamToCategory,
  removeTeamFromCategory,
  updateTeamInTournament,
  bulkSetTeamsInCategory,
  deleteAllTeamsInCategory,
  approvePendingRegistration,
  rejectPendingRegistration,
} from "@/lib/tournament-store";
import { generate32Teams } from "@/lib/team-generator";
import {
  type AccessCode,
  getAccessCodes,
  generateNewCode,
  revokeCode,
} from "@/lib/access-codes";
import {
  loginWithAccessCode,
  loginWithCredentials,
  getAuthenticatedStaff,
  logoutStaff,
} from "@/lib/auth-store";
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
          <div className="p-3 bg-muted/60 border border-border rounded text-left text-xs font-mono max-h-36 overflow-auto text-foreground break-all">
            <span className="font-bold text-brick block mb-1">Details: {error.message || String(error)}</span>
            {error.stack && (
              <pre className="text-[0.65rem] text-muted-foreground whitespace-pre-wrap">{error.stack.slice(0, 300)}</pre>
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

type TabKey = "draw" | "dispatch" | "setup" | "teams";
type DrawSubTab = "bracket-draw" | "brackets";
type SetupSection = "tournaments" | "teams" | "access-codes";

const tabs: { key: TabKey; label: string }[] = [
  { key: "draw", label: "Draw" },
  { key: "dispatch", label: "Dispatch" },
  { key: "setup", label: "Setup" },
  { key: "teams", label: "Teams & Payments" },
];

function Admin() {
  const navigate = useNavigate();
  const { tournaments } = useTournamentStore();

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

  const [authCodeInput, setAuthCodeInput] = useState("");
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
    tournament?.categories?.find((c) => c.id === categoryId) ?? tournament?.categories?.[0];

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
      if (!categoryId || !tournament.categories.some((c) => c.id === categoryId)) {
        setCategoryId(tournament.categories[0]!.id);
      }
    }
  }, [tournament, categoryId]);

  const handleLogout = () => {
    logoutStaff();
    setIsAuthenticated(false);
  };

  const handleAdminGateSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setAuthError(null);
    setIsAuthenticating(true);

    const cleanInput = authCodeInput.trim();
    if (!cleanInput) {
      setAuthError("Please enter an Admin Access Code or email address.");
      setIsAuthenticating(false);
      return;
    }

    if (cleanInput.includes("@")) {
      const res = loginWithCredentials(cleanInput, authPasswordInput);
      setIsAuthenticating(false);
      if (!res.success) {
        setAuthError(res.error || "Invalid credentials.");
        return;
      }
      if (res.role !== "admin") {
        setAuthError("This account is designated for Match Officials. Please access the Umpire Console.");
        return;
      }
      setIsAuthenticated(true);
      return;
    }

    const res = loginWithAccessCode(cleanInput);
    setIsAuthenticating(false);
    if (!res.success) {
      setAuthError(res.error || "Invalid access code.");
      return;
    }
    if (res.role !== "admin") {
      setAuthError("This access code is designated for Match Officials. Please access the Umpire Console.");
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
              Authorized Tournament Directors only. Enter your Admin Access Code or administrator credentials to proceed.
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
                Admin Access Code or Email
              </label>
              <input
                type="text"
                value={authCodeInput}
                onChange={(e) => setAuthCodeInput(e.target.value)}
                placeholder="e.g. DV-ADMIN or admin@dinkvalley.com"
                autoFocus
                required
                className="w-full bg-charcoal border border-border px-3.5 py-2.5 text-sand text-sm font-mono uppercase tracking-wider rounded focus:outline-none focus:border-pickle"
              />
            </div>

            {authCodeInput.includes("@") && (
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
            )}

            <button
              type="submit"
              disabled={isAuthenticating || !authCodeInput.trim()}
              className="w-full bg-brick py-3 px-6 font-display text-xl tracking-wider text-sand hover:bg-brick-deep transition-all cursor-pointer shadow-md rounded disabled:opacity-50 mt-1"
            >
              {isAuthenticating ? "Verifying Authorization..." : "Authenticate & Enter"}
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
              {tabs.map(({ key, label }) => {
                const totalPendingForTab =
                  key === "teams"
                    ? tournament?.categories?.reduce((acc, c) => acc + (c.pendingTeams?.length || 0), 0) || 0
                    : 0;

                return (
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
                    {totalPendingForTab > 0 && (
                      <span className="px-2 py-0.5 text-[0.65rem] font-bold font-mono bg-brick text-sand rounded-full animate-pulse">
                        {totalPendingForTab}
                      </span>
                    )}
                  </button>
                );
              })}
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
          {tabs.map(({ key, label }) => {
            const totalPendingForTab =
              key === "teams"
                ? tournament?.categories?.reduce((acc, c) => acc + (c.pendingTeams?.length || 0), 0) || 0
                : 0;

            return (
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
                {totalPendingForTab > 0 && (
                  <span className="px-2 py-0.5 text-[0.65rem] font-bold font-mono bg-brick text-sand rounded-full animate-pulse">
                    {totalPendingForTab}
                  </span>
                )}
              </button>
            );
          })}
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
        <header className="flex items-center justify-between gap-2 border-b border-border bg-charcoal/30 px-3 py-3 sm:px-8 sm:py-4">
          <div className="flex min-w-0 items-center gap-2 sm:gap-3">
            {/* Mobile menu button */}
            <button
              onClick={() => setMobileMenuOpen(true)}
              className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded border border-border bg-charcoal text-sand md:hidden hover:border-pickle transition-colors"
              aria-label="Open navigation drawer"
            >
              <svg className="w-4 h-4 text-sand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M4 6h16M4 12h16M4 18h16" />
              </svg>
            </button>
            <div className="min-w-0">
              <h1 className="font-display text-xl leading-tight text-foreground sm:text-3xl md:text-4xl truncate">
                {activeTab === "draw"
                  ? drawSubTab === "bracket-draw" ? "Bracket Draw" : "Brackets"
                  : tabs.find((t) => t.key === activeTab)?.label}
              </h1>
              <p className="text-[0.6rem] uppercase tracking-widest text-muted-foreground sm:text-xs">
                Organizer Console
              </p>
            </div>
          </div>
          <span className="flex-shrink-0 text-[0.6rem] sm:text-xs font-semibold uppercase tracking-widest text-pickle border border-pickle px-2 py-1 sm:px-2.5">
            Admin
          </span>
        </header>

        {/* Content */}
        <div className="flex-1 overflow-y-auto p-4 sm:p-6 md:p-8">

          {/* ── DRAW TAB ── */}
          {activeTab === "draw" && (
            <div className="space-y-6">
              {/* Sub-tab toggle */}
              <div className="flex gap-1 border-b border-border">
                <button
                  onClick={() => setDrawSubTab("bracket-draw")}
                  className={`px-5 py-2.5 text-xs font-bold uppercase tracking-widest border-b-2 transition-all cursor-pointer ${
                    drawSubTab === "bracket-draw"
                      ? "border-brick text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground"
                  }`}
                >
                  Bracket Draw
                </button>
                <button
                  onClick={() => setDrawSubTab("brackets")}
                  className={`px-5 py-2.5 text-xs font-bold uppercase tracking-widest border-b-2 transition-all cursor-pointer ${
                    drawSubTab === "brackets"
                      ? "border-brick text-foreground"
                      : "border-transparent text-muted-foreground hover:text-foreground"
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
              <div className="border border-border overflow-hidden">
                <button
                  onClick={() => toggleSetupSection("tournaments")}
                  className="w-full flex items-center justify-between px-5 py-4 bg-charcoal hover:bg-charcoal/80 transition-colors cursor-pointer"
                >
                  <span className="text-sm font-bold uppercase tracking-widest text-sand">Tournaments</span>
                  <svg
                    className={`w-4 h-4 text-sand/70 transition-transform duration-200 ${openSetupSections.has("tournaments") ? "rotate-180" : ""}`}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {openSetupSections.has("tournaments") && (
                  <div className="p-4 sm:p-6 border-t border-border bg-background">
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
              <div className="border border-border overflow-hidden">
                <button
                  onClick={() => toggleSetupSection("teams")}
                  className="w-full flex items-center justify-between px-5 py-4 bg-charcoal hover:bg-charcoal/80 transition-colors cursor-pointer"
                >
                  <div className="flex items-center gap-3">
                    <span className="text-sm font-bold uppercase tracking-widest text-sand">Teams & Payments</span>
                    {tournament && category && (
                      <span className="text-[0.65rem] font-mono text-sand/60 border border-border px-2 py-0.5">
                        {category.teams?.length ?? 0} verified
                      </span>
                    )}
                    {tournament && (() => {
                      const totalPending = tournament.categories.reduce(
                        (sum, c) => sum + (c.pendingTeams?.length ?? 0),
                        0
                      );
                      if (totalPending > 0) {
                        return (
                          <span className="text-[0.65rem] font-mono font-bold bg-brick text-sand px-2 py-0.5 rounded animate-pulse">
                            {totalPending} Pending Review
                          </span>
                        );
                      }
                      return null;
                    })()}
                  </div>
                  <svg
                    className={`w-4 h-4 text-sand/70 transition-transform duration-200 ${openSetupSections.has("teams") ? "rotate-180" : ""}`}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {openSetupSections.has("teams") && (
                  <div className="p-4 sm:p-6 border-t border-border bg-background">
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
                      <p className="text-sm text-muted-foreground py-4">
                        Create a tournament with categories first to manage teams.
                      </p>
                    )}
                  </div>
                )}
              </div>

              {/* Access Codes Section */}
              <div className="border border-border overflow-hidden">
                <button
                  onClick={() => toggleSetupSection("access-codes")}
                  className="w-full flex items-center justify-between px-5 py-4 bg-charcoal hover:bg-charcoal/80 transition-colors cursor-pointer"
                >
                  <span className="text-sm font-bold uppercase tracking-widest text-sand">Access Codes</span>
                  <svg
                    className={`w-4 h-4 text-sand/70 transition-transform duration-200 ${openSetupSections.has("access-codes") ? "rotate-180" : ""}`}
                    fill="none" stroke="currentColor" viewBox="0 0 24 24"
                  >
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M19 9l-7 7-7-7" />
                  </svg>
                </button>
                {openSetupSections.has("access-codes") && (
                  <div className="p-4 sm:p-6 border-t border-border bg-background">
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

        </div>
      </div>
    </div>
  );
}

/* ────────────────────────────────────────────────
   Teams Tab -- Payment Proof Verification & Photo Attachments
──────────────────────────────────────────────── */

function PaymentProofModal({
  team,
  isPaid,
  proofUrl,
  onClose,
  onTogglePaid,
  onUpdateProof,
}: {
  team: Team;
  isPaid: boolean;
  proofUrl: string;
  onClose: () => void;
  onTogglePaid: () => void;
  onUpdateProof: (newUrl: string) => void;
}) {
  const handleFileChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) {
      const reader = new FileReader();
      reader.onload = (evt) => {
        if (evt.target?.result) {
          onUpdateProof(evt.target.result as string);
        }
      };
      reader.readAsDataURL(file);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/95 backdrop-blur-sm p-4">
      <div className="surface-card border-2 border-pickle/50 max-w-md w-full p-6 space-y-5">
        <div className="flex items-center justify-between border-b border-border pb-3">
          <div>
            <span className="block text-[0.6rem] uppercase tracking-[0.28em] font-bold text-pickle">
              Payment Attachment Proof
            </span>
            <h3 className="font-display text-2xl text-foreground mt-0.5">{team.name}</h3>
            <p className="text-xs text-foreground/70">{team.players.join(" & ")}</p>
          </div>
          <button
            onClick={onClose}
            className="text-xs font-bold uppercase tracking-widest text-foreground/70 hover:text-foreground p-1 cursor-pointer"
          >
            Close
          </button>
        </div>

        {/* Attachment Image Preview */}
        <div className="space-y-2">
          <div className="relative rounded overflow-hidden border border-border bg-charcoal flex items-center justify-center min-h-[260px]">
            {proofUrl ? (
              <img
                src={proofUrl}
                alt={`Payment proof for ${team.name}`}
                className="max-h-[320px] w-full object-contain"
              />
            ) : (
              <div className="p-8 text-center text-xs text-foreground/50">
                No photo attachment uploaded yet.
              </div>
            )}
          </div>
        </div>

        {/* Details & Actions */}
        <div className="space-y-3 bg-charcoal/50 p-3 border border-border/60 text-xs">
          <div className="flex justify-between">
            <span className="text-foreground/70 font-semibold">Ref Number:</span>
            <span className="font-mono text-sand font-bold">{team.paymentRef ?? "GC-98214309"}</span>
          </div>
          <div className="flex justify-between">
            <span className="text-foreground/70 font-semibold">Verification Status:</span>
            <span className={`font-bold uppercase tracking-wider ${isPaid ? "text-pickle" : "text-brick"}`}>
              {isPaid ? "Verified Paid" : "Pending Verification"}
            </span>
          </div>
        </div>

        {/* Action Controls */}
        <div className="space-y-2">
          <div className="flex gap-2">
            <button
              onClick={() => {
                onTogglePaid();
              }}
              className={`flex-1 py-3 font-display text-lg tracking-widest transition-all cursor-pointer ${
                isPaid
                  ? "bg-brick text-sand hover:bg-brick-deep"
                  : "bg-pickle text-sand hover:opacity-90"
              }`}
            >
              {isPaid ? "Mark as Pending" : "Verify & Mark Paid"}
            </button>

            <label className="flex-shrink-0 px-4 py-3 border border-border bg-charcoal text-sand text-xs font-bold uppercase tracking-widest hover:border-sand cursor-pointer inline-flex items-center justify-center">
              <span>Attach Photo</span>
              <input
                type="file"
                accept="image/*"
                onChange={handleFileChange}
                className="hidden"
              />
            </label>
          </div>
        </div>
      </div>
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
    Object.fromEntries((category.teams || []).map((t) => [t.id, t.paid ?? false]))
  );

  // Local proof photos: teamId -> image url
  const [proofMap, setProofMap] = useState<Record<string, string>>(() =>
    Object.fromEntries(
      (category.teams || []).map((t) => [t.id, t.paymentProofUrl ?? ""])
    )
  );

  const [selectedModalTeam, setSelectedModalTeam] = useState<Team | null>(null);
  const [filter, setFilter] = useState<"all" | "paid" | "pending">("all");
  const [isExportMenuOpen, setIsExportMenuOpen] = useState(false);
  const [exportNotification, setExportNotification] = useState<string | null>(null);

  const [newTeamName, setNewTeamName] = useState("");
  const [newPlayers, setNewPlayers] = useState("");
  const [teamAddError, setTeamAddError] = useState<string | null>(null);

  // Rebuild payment map when category changes
  const resolvedMap: Record<string, boolean> = {};
  const resolvedProofs: Record<string, string> = {};

  (category.teams || []).forEach((t) => {
    resolvedMap[t.id] = paymentMap[t.id] ?? t.paid ?? false;
    resolvedProofs[t.id] = proofMap[t.id] ?? t.paymentProofUrl ?? "";
  });

  const togglePaid = (id: string) => {
    const nextVal = !resolvedMap[id];
    setPaymentMap((prev) => ({ ...prev, [id]: nextVal }));
    updateTeamInTournament(tournament.slug, category.id, id, {
      paid: nextVal,
      paymentStatus: nextVal ? "Verified" : "Pending",
    });
  };

  const updateProof = (id: string, url: string) => {
    setProofMap((prev) => ({ ...prev, [id]: url }));
    updateTeamInTournament(tournament.slug, category.id, id, {
      paymentProofUrl: url,
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
      paid: false,
      paymentStatus: "Pending",
    };
    addTeamToCategory(tournament.slug, category.id, newTeam);
    setNewTeamName("");
    setNewPlayers("");
    setTeamAddError(null);
  };

  const handleRemoveTeam = (teamId: string, name: string) => {
    if (window.confirm(`Remove team "${name}" from this category?`)) {
      removeTeamFromCategory(tournament.slug, category.id, teamId);
    }
  };

  const [undoRoster, setUndoRoster] = useState<{
    action: "populate" | "delete";
    teams: Team[];
    label: string;
  } | null>(null);

  const handleAutoPopulate32Teams = () => {
    const confirmMsg =
      category.teams.length > 0
        ? `Replace current roster (${category.teams.length} teams) with 32 verified teams?`
        : "Generate and populate 32 verified teams for this category?";
    if (!window.confirm(confirmMsg)) return;

    setUndoRoster({
      action: "populate",
      teams: [...category.teams],
      label: `Previous roster (${category.teams.length} teams)`,
    });

    const generated = generate32Teams({ verifiedOnly: true });
    bulkSetTeamsInCategory(tournament.slug, category.id, generated);

    const nextPay: Record<string, boolean> = {};
    const nextProof: Record<string, string> = {};
    generated.forEach((t) => {
      nextPay[t.id] = t.paid ?? true;
      if (t.paymentProofUrl) nextProof[t.id] = t.paymentProofUrl;
    });
    setPaymentMap(nextPay);
    setProofMap(nextProof);
  };

  const handleDeleteAllPlayers = () => {
    if (category.teams.length === 0) return;
    if (!window.confirm(`Delete all ${category.teams.length} players and teams from ${category.label}? This will clear the category roster and any bracket draws.`)) return;

    setUndoRoster({
      action: "delete",
      teams: [...category.teams],
      label: `Deleted roster (${category.teams.length} teams)`,
    });

    deleteAllTeamsInCategory(tournament.slug, category.id);
    setPaymentMap({});
    setProofMap({});
  };

  const handleUndoRoster = () => {
    if (!undoRoster) return;
    bulkSetTeamsInCategory(tournament.slug, category.id, undoRoster.teams);

    const nextPay: Record<string, boolean> = {};
    const nextProof: Record<string, string> = {};
    undoRoster.teams.forEach((t) => {
      nextPay[t.id] = t.paid ?? true;
      if (t.paymentProofUrl) nextProof[t.id] = t.paymentProofUrl;
    });
    setPaymentMap(nextPay);
    setProofMap(nextProof);
    setUndoRoster(null);
  };

  const pendingTeams = category.pendingTeams || [];

  const handleApprovePending = (teamId: string) => {
    approvePendingRegistration(tournament.slug, category.id, teamId);
    if (selectedModalTeam?.id === teamId) {
      setSelectedModalTeam(null);
    }
  };

  const handleRejectPending = (teamId: string, teamName: string) => {
    if (window.confirm(`Decline and reject registration for "${teamName}"?`)) {
      rejectPendingRegistration(tournament.slug, category.id, teamId);
      if (selectedModalTeam?.id === teamId) {
        setSelectedModalTeam(null);
      }
    }
  };

  const currentTeams = category.teams || [];
  const paidCount = currentTeams.filter((t) => resolvedMap[t.id]).length;
  const pendingCount = (category.pendingTeams?.length ?? 0) + (currentTeams.length - paidCount);
  const categoryTotal = currentTeams.length + (category.pendingTeams?.length ?? 0);

  const totalTournTeams = (tournament.categories || []).reduce(
    (sum, c) => sum + (c.teams?.length || 0) + (c.pendingTeams?.length || 0),
    0
  );
  const totalTournPending = (tournament.categories || []).reduce(
    (sum, c) =>
      sum +
      (c.pendingTeams?.length || 0) +
      (c.teams || []).filter((t) => !t.paid && t.paymentStatus !== "Verified").length,
    0
  );
  const totalTournVerified = Math.max(0, totalTournTeams - totalTournPending);

  const handleExportCategory = (filterType: CsvExportFilter = "all") => {
    try {
      const res = exportCategoryTeamsToCsv(
        tournament,
        category,
        filterType,
        resolvedMap,
        resolvedProofs
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
        resolvedMap,
        resolvedProofs
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
        resolvedProofs,
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
        resolvedMap,
        resolvedProofs
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

  const handleExportExcelWorkbook = () => {
    try {
      const res = exportTournamentToExcelWorkbook(
        tournament,
        resolvedMap,
        resolvedProofs
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

  const visibleTeams = currentTeams.filter((t) => {
    if (filter === "paid") return resolvedMap[t.id];
    if (filter === "pending") return !resolvedMap[t.id];
    return true;
  });

  return (
    <div className="max-w-4xl space-y-6">
      {/* Modal for viewing attachment photo */}
      {selectedModalTeam && (
        <PaymentProofModal
          team={selectedModalTeam}
          isPaid={resolvedMap[selectedModalTeam.id] ?? false}
          proofUrl={resolvedProofs[selectedModalTeam.id] || selectedModalTeam.paymentProofUrl || ""}
          onClose={() => setSelectedModalTeam(null)}
          onTogglePaid={() => {
            const isPending = pendingTeams.some((pt) => pt.id === selectedModalTeam.id);
            if (isPending) {
              handleApprovePending(selectedModalTeam.id);
            } else {
              togglePaid(selectedModalTeam.id);
            }
          }}
          onUpdateProof={(url) => updateProof(selectedModalTeam.id, url)}
        />
      )}

      {/* Header and Export Toolbar */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <span className="text-xs uppercase tracking-[0.28em] text-pickle font-bold">Roster management</span>
          <h2 className="mt-1 font-display text-3xl text-foreground">Teams &amp; Payment Verification</h2>
        </div>

        {/* Export Controls (Excel Multi-Tab + Whole Tournament CSV + Options) */}
        <div className="flex items-center gap-2 flex-wrap self-start sm:self-auto">
          {/* Main Primary Button: Excel Multi-Tab (.xlsx) with Tab Per Category */}
          <button
            type="button"
            onClick={handleExportExcelWorkbook}
            className="inline-flex items-center gap-2 px-4 py-2 bg-pickle hover:opacity-90 text-sand text-xs font-mono font-bold uppercase tracking-wider rounded transition-all cursor-pointer shadow-sm"
            title="Download presentable Excel workbook with a dedicated tab for each category"
          >
            <svg className="w-4 h-4 text-sand" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <span>Export Excel (.xlsx)</span>
            <span className="bg-black/25 text-sand px-1.5 py-0.5 rounded text-[0.65rem] font-bold">
              Tab per Category
            </span>
          </button>

          {/* Quick Whole CSV Action */}
          <button
            type="button"
            onClick={() => handleExportWholeGrouped("all")}
            className="inline-flex items-center gap-1.5 px-3 py-2 bg-charcoal border border-border hover:border-pickle text-sand text-xs font-mono uppercase tracking-wider rounded transition-all cursor-pointer shadow-sm"
            title="Download whole tournament CSV grouped per category"
          >
            <svg className="w-3.5 h-3.5 text-pickle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
            </svg>
            <span>Whole CSV</span>
          </button>

          {/* Options Dropdown */}
          <div className="relative">
            <button
              type="button"
              onClick={() => setIsExportMenuOpen(!isExportMenuOpen)}
              className="inline-flex items-center gap-1.5 px-3 py-2 bg-charcoal border border-border hover:border-pickle text-sand text-xs font-mono uppercase tracking-wider rounded transition-all cursor-pointer shadow-sm"
              title="More export formats"
            >
              <span>Options</span>
              <svg
                className={`w-3.5 h-3.5 text-muted-foreground transition-transform ${isExportMenuOpen ? "rotate-180" : ""}`}
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
                <div className="absolute right-0 mt-2 w-80 sm:w-88 bg-charcoal border border-border rounded-lg shadow-2xl p-2 z-40 animate-in fade-in zoom-in-95 space-y-1">
                  <div className="px-3 py-2 border-b border-border/60">
                    <span className="text-[0.65rem] uppercase font-mono tracking-wider text-pickle font-bold block">
                      Spreadsheet Exports
                    </span>
                    <span className="text-[0.7rem] text-muted-foreground">
                      Multi-tab Excel workbooks &amp; CSV files
                    </span>
                  </div>

                  {/* Multi-Tab Excel Option */}
                  <button
                    type="button"
                    onClick={handleExportExcelWorkbook}
                    className="w-full text-left px-3 py-2.5 rounded bg-pickle/10 hover:bg-pickle/20 border border-pickle/30 transition-colors cursor-pointer group"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-bold text-sand group-hover:text-pickle transition-colors">
                        Excel Multi-Tab Workbook (.xlsx)
                      </span>
                      <span className="text-[0.65rem] font-mono bg-pickle text-sand font-bold px-1.5 py-0.5 rounded">
                        Tab per Category
                      </span>
                    </div>
                    <span className="text-[0.65rem] text-muted-foreground block mt-0.5">
                      Overview sheet + individual sheet tabs for all {tournament.categories?.length || 0} categories
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportWholeGrouped("all")}
                    className="w-full text-left px-3 py-2.5 rounded hover:bg-background/40 transition-colors cursor-pointer group"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-sand group-hover:text-pickle transition-colors">
                        Whole Tournament CSV (Grouped)
                      </span>
                      <span className="text-[0.65rem] font-mono bg-border/60 px-1.5 py-0.5 rounded text-sand/80">
                        {totalTournTeams} teams
                      </span>
                    </div>
                    <span className="text-[0.65rem] text-muted-foreground block mt-0.5">
                      Single CSV with category headers &amp; subtotals
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportTournament("all")}
                    className="w-full text-left px-3 py-2.5 rounded hover:bg-background/40 transition-colors cursor-pointer group"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-sand group-hover:text-pickle transition-colors">
                        Whole Tournament CSV (Flat Table)
                      </span>
                      <span className="text-[0.65rem] font-mono bg-border/60 px-1.5 py-0.5 rounded text-sand/80">
                        Standard Table
                      </span>
                    </div>
                    <span className="text-[0.65rem] text-muted-foreground block mt-0.5">
                      Continuous rows for Excel auto-filters &amp; pivot tables
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportBatchSeparately("all")}
                    className="w-full text-left px-3 py-2.5 rounded hover:bg-background/40 transition-colors cursor-pointer group border-t border-border/40"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-sand group-hover:text-pickle transition-colors">
                        Batch Export (Separate CSV per Category)
                      </span>
                      <span className="text-[0.65rem] font-mono bg-border/60 px-1.5 py-0.5 rounded text-sand/80">
                        {tournament.categories?.length || 0} files
                      </span>
                    </div>
                    <span className="text-[0.65rem] text-muted-foreground block mt-0.5">
                      Downloads individual CSV files for each division in 1 click
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportCategory("all")}
                    className="w-full text-left px-3 py-2.5 rounded hover:bg-background/40 transition-colors cursor-pointer group border-t border-border/40"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-sand group-hover:text-pickle transition-colors">
                        Export Current Category Only
                      </span>
                      <span className="text-[0.65rem] font-mono bg-border/60 px-1.5 py-0.5 rounded text-sand/80">
                        {categoryTotal} teams
                      </span>
                    </div>
                    <span className="text-[0.65rem] text-muted-foreground block mt-0.5">
                      {category.label} verified &amp; pending entries
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportWholeGrouped("pending-only")}
                    className="w-full text-left px-3 py-2.5 rounded hover:bg-background/40 transition-colors cursor-pointer group border-t border-border/40"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-brick">
                        Export Pending Queue Only
                      </span>
                      <span className="text-[0.65rem] font-mono bg-brick/20 text-brick px-1.5 py-0.5 rounded font-bold">
                        {totalTournPending} pending
                      </span>
                    </div>
                    <span className="text-[0.65rem] text-muted-foreground block mt-0.5">
                      Entries requiring payment verification across all categories
                    </span>
                  </button>

                  <button
                    type="button"
                    onClick={() => handleExportWholeGrouped("verified-only")}
                    className="w-full text-left px-3 py-2.5 rounded hover:bg-background/40 transition-colors cursor-pointer group"
                  >
                    <div className="flex items-center justify-between">
                      <span className="text-xs font-semibold text-pickle">
                        Export Verified Rosters Only
                      </span>
                      <span className="text-[0.65rem] font-mono bg-pickle/20 text-pickle px-1.5 py-0.5 rounded font-bold">
                        {totalTournVerified} verified
                      </span>
                    </div>
                    <span className="text-[0.65rem] text-muted-foreground block mt-0.5">
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
        <div className="surface-card flex items-center justify-between p-3.5 bg-pickle/15 border border-pickle/40 rounded text-xs animate-in fade-in duration-300">
          <div className="flex items-center gap-2.5">
            <span className="h-2 w-2 rounded-full bg-pickle animate-ping" />
            <span className="text-foreground font-mono font-medium">
              {exportNotification}
            </span>
          </div>
          <button
            type="button"
            onClick={() => setExportNotification(null)}
            className="text-[0.7rem] text-muted-foreground hover:text-foreground uppercase tracking-wider font-semibold cursor-pointer px-1.5 py-1"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select
          value={tournamentSlug}
          onChange={(e) => {
            setTournamentSlug(e.target.value);
            setPaymentMap({});
            setProofMap({});
            setFilter("all");
            setUndoRoster(null);
          }}
          className="border border-input bg-background px-3 py-2 text-sm focus:border-pickle focus:outline-none font-medium"
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
            setProofMap({});
            setFilter("all");
            setUndoRoster(null);
          }}
          className="border border-input bg-background px-3 py-2 text-sm focus:border-pickle focus:outline-none font-medium"
        >
          {tournament.categories.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} {c.pendingTeams && c.pendingTeams.length > 0 ? `(${c.pendingTeams.length} Pending)` : ""}
            </option>
          ))}
        </select>
      </div>

      {/* ── Pending Registrations Queue (Awaiting Verification) ── */}
      {pendingTeams.length > 0 && (
        <div className="surface-card p-5 border-2 border-brick/40 rounded-lg space-y-4 bg-brick/5 animate-in fade-in">
          <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-2 border-b border-brick/20 pb-3">
            <div className="flex items-center gap-2.5">
              <span className="h-2.5 w-2.5 rounded-full bg-brick animate-ping shrink-0" />
              <div>
                <span className="text-[0.65rem] font-bold uppercase tracking-[0.24em] text-brick block font-mono">
                  Action Required
                </span>
                <h3 className="font-display text-xl sm:text-2xl text-foreground mt-0.5">
                  Pending Registrations ({pendingTeams.length})
                </h3>
              </div>
            </div>
            <span className="text-xs font-mono text-muted-foreground">
              Awaiting admin approval before entering {category.label}
            </span>
          </div>

          <div className="space-y-3">
            {pendingTeams.map((pt) => (
              <div
                key={pt.id}
                className="surface-card bg-card p-4 border border-border rounded flex flex-col md:flex-row md:items-center justify-between gap-4 shadow-sm"
              >
                <div className="flex items-start gap-3.5 min-w-0">
                  {pt.paymentProofUrl ? (
                    <button
                      type="button"
                      onClick={() => setSelectedModalTeam(pt)}
                      className="relative group shrink-0 h-16 w-16 rounded overflow-hidden border border-border bg-charcoal cursor-pointer"
                      title="Click to zoom receipt"
                    >
                      <img
                        src={pt.paymentProofUrl}
                        alt="Receipt"
                        className="h-full w-full object-cover group-hover:scale-110 transition-transform"
                      />
                      <div className="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center text-[0.6rem] font-mono text-sand font-bold">
                        View
                      </div>
                    </button>
                  ) : (
                    <div className="h-16 w-16 rounded border border-border/60 bg-muted/30 flex items-center justify-center text-[0.6rem] font-mono text-muted-foreground text-center p-1 shrink-0">
                      No receipt
                    </div>
                  )}

                  <div className="min-w-0 space-y-1">
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="font-display text-lg text-foreground font-bold leading-tight">
                        {pt.name}
                      </span>
                      <span className="px-2 py-0.5 text-[0.6rem] font-mono bg-brick/15 text-brick border border-brick/40 rounded font-bold uppercase tracking-wider">
                        Pending Verification
                      </span>
                    </div>
                    <div className="text-xs text-foreground/80 font-medium">
                      {pt.players.join(" & ")}
                    </div>
                    {pt.club && (
                      <div className="text-[0.65rem] text-muted-foreground font-mono">
                        Club: {pt.club}
                      </div>
                    )}
                    <div className="text-[0.65rem] text-muted-foreground font-mono">
                      Ref: <span className="text-pickle font-bold">{pt.paymentRef || "None"}</span>
                    </div>
                  </div>
                </div>

                {/* Actions */}
                <div className="flex items-center gap-2 shrink-0 self-end md:self-center">
                  {pt.paymentProofUrl && (
                    <button
                      type="button"
                      onClick={() => setSelectedModalTeam(pt)}
                      className="px-3 py-2 border border-border bg-charcoal text-sand text-xs font-mono uppercase tracking-wider rounded hover:border-pickle transition-colors cursor-pointer"
                    >
                      View Receipt
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => handleRejectPending(pt.id, pt.name)}
                    className="px-3 py-2 border border-brick/40 text-brick hover:bg-brick/10 text-xs font-mono uppercase tracking-wider rounded transition-colors cursor-pointer"
                  >
                    Decline
                  </button>
                  <button
                    type="button"
                    onClick={() => handleApprovePending(pt.id)}
                    className="px-4 py-2 bg-pickle text-sand text-xs font-bold uppercase tracking-widest hover:opacity-90 transition-opacity rounded cursor-pointer shadow-sm"
                  >
                    Approve &amp; Add to Category
                  </button>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Undo Banner if an action just occurred */}
      {undoRoster && (
        <div className="surface-card flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-3.5 bg-pickle/15 border border-pickle/40 rounded text-xs animate-in fade-in duration-300">
          <div className="flex items-center gap-2">
            <span className="h-2 w-2 rounded-full bg-pickle animate-pulse" />
            <span className="text-foreground font-medium">
              {undoRoster.action === "populate"
                ? `Populated 32 teams into ${category.label}.`
                : `Deleted all teams from ${category.label}.`}
            </span>
          </div>
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={handleUndoRoster}
              className="px-3 py-1.5 bg-pickle text-sand font-bold uppercase tracking-wider text-[0.7rem] rounded hover:opacity-90 transition-opacity cursor-pointer shadow-sm"
            >
              Undo Action ({undoRoster.label})
            </button>
            <button
              type="button"
              onClick={() => setUndoRoster(null)}
              className="text-[0.7rem] text-muted-foreground hover:text-foreground uppercase tracking-wider font-semibold cursor-pointer px-1.5 py-1"
            >
              Dismiss
            </button>
          </div>
        </div>
      )}

      {/* Quick Staging Actions Bar */}
      <div className="surface-card flex flex-col sm:flex-row sm:items-center justify-between gap-3 p-4 border border-border">
        <div>
          <span className="text-xs font-bold uppercase tracking-widest text-foreground block">
            Roster Actions &amp; Export
          </span>
          <span className="text-[0.7rem] text-muted-foreground">
            Auto-populate 32 verified doubles teams, clear rosters, or export to Excel and Google Sheets.
          </span>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {undoRoster && (
            <button
              type="button"
              onClick={handleUndoRoster}
              className="px-3.5 py-2 border border-pickle bg-pickle/20 text-pickle hover:bg-pickle hover:text-sand font-bold text-xs tracking-wider uppercase rounded transition-all cursor-pointer"
            >
              Undo ({undoRoster.action === "populate" ? "Revert Roster" : "Restore Players"})
            </button>
          )}
          <button
            type="button"
            onClick={handleExportExcelWorkbook}
            className="px-3.5 py-2 border border-pickle bg-pickle/15 text-pickle hover:bg-pickle hover:text-sand font-mono font-bold text-xs tracking-wider uppercase rounded transition-all cursor-pointer shadow-xs inline-flex items-center gap-1.5"
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
            className="px-3.5 py-2 border border-border bg-charcoal text-sand hover:border-pickle hover:text-pickle font-mono font-semibold text-xs tracking-wider uppercase rounded transition-all cursor-pointer shadow-xs inline-flex items-center gap-1.5"
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
            className="px-3 py-2 border border-border/70 bg-background text-foreground/80 hover:text-foreground hover:border-pickle font-mono text-xs tracking-wider uppercase rounded transition-all cursor-pointer shadow-xs"
            title={`Download CSV for ${category.label} only`}
          >
            Export {category.label}
          </button>
          <button
            type="button"
            onClick={handleAutoPopulate32Teams}
            className="px-3.5 py-2 bg-pickle text-sand hover:opacity-90 font-semibold text-xs tracking-wider uppercase rounded transition-all cursor-pointer shadow-sm"
          >
            Auto-Populate 32 Teams
          </button>
          <button
            type="button"
            onClick={handleDeleteAllPlayers}
            disabled={category.teams.length === 0}
            className={`px-3.5 py-2 border font-semibold text-xs tracking-wider uppercase rounded transition-all ${
              category.teams.length > 0
                ? "border-brick bg-brick/15 text-brick hover:bg-brick hover:text-sand cursor-pointer"
                : "border-border/60 bg-muted/40 text-muted-foreground/40 cursor-not-allowed"
            }`}
          >
            Delete All Players {category.teams.length > 0 ? `(${category.teams.length})` : "(0)"}
          </button>
        </div>
      </div>

      {/* Payment Summary Bar */}
      <div className="surface-card flex items-center gap-6 px-6 py-4">
        <div className="text-center">
          <p className="font-display text-4xl text-foreground">{category.teams.length}</p>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Total</p>
        </div>
        <div className="h-10 w-px bg-border" />
        <div className="text-center">
          <p className="font-display text-4xl text-pickle">{paidCount}</p>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Verified</p>
        </div>
        <div className="h-10 w-px bg-border" />
        <div className="text-center">
          <p className="font-display text-4xl text-brick">{pendingCount}</p>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Pending</p>
        </div>
        {/* Progress bar */}
        <div className="flex-1">
          <div className="mb-1 flex justify-between text-xs text-muted-foreground">
            <span>Verification progress</span>
            <span>{category.teams.length > 0 ? Math.round((paidCount / category.teams.length) * 100) : 0}%</span>
          </div>
          <div className="h-2 w-full overflow-hidden rounded-full bg-border">
            <div
              className="h-full rounded-full bg-pickle transition-all duration-500"
              style={{ width: `${category.teams.length > 0 ? (paidCount / category.teams.length) * 100 : 0}%` }}
            />
          </div>
        </div>
      </div>

      {/* Add team row */}
      <div className="space-y-2">
        <div className="flex flex-wrap gap-2">
          <input
            value={newTeamName}
            onChange={(e) => setNewTeamName(e.target.value)}
            placeholder="Team name (e.g. Smash Bros)"
            className="flex-1 border border-input bg-background px-3 py-2 text-sm focus:border-pickle focus:outline-none"
          />
          <input
            value={newPlayers}
            onChange={(e) => setNewPlayers(e.target.value)}
            placeholder="Player 1 / Player 2"
            className="flex-1 border border-input bg-background px-3 py-2 text-sm focus:border-pickle focus:outline-none"
          />
          <button
            onClick={handleCreateTeam}
            className="bg-pickle px-4 py-2 text-sm font-semibold text-sand hover:opacity-90 cursor-pointer"
          >
            + Add Team
          </button>
        </div>
        {teamAddError && (
          <p className="text-xs text-brick font-semibold">{teamAddError}</p>
        )}
      </div>

      {/* Filter tabs */}
      <div className="flex gap-1 border-b border-border">
        {(["all", "paid", "pending"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 text-xs font-bold uppercase tracking-widest transition-colors cursor-pointer ${filter === f
                ? "border-b-2 border-brick text-foreground font-bold"
                : "text-muted-foreground hover:text-foreground"
              }`}
          >
            {f === "all" ? `All (${category.teams.length})` : f === "paid" ? `Verified (${paidCount})` : `Pending (${pendingCount})`}
          </button>
        ))}
      </div>

      {/* Team list with attachment photo verification */}
      <div className="surface-card overflow-hidden p-0">
        {visibleTeams.length === 0 ? (
          <p className="px-6 py-8 text-sm text-muted-foreground">No teams in this filter.</p>
        ) : (
          <ul className="divide-y divide-border">
            {visibleTeams.map((t) => {
              const isPaid = resolvedMap[t.id] ?? false;
              const proof = resolvedProofs[t.id];

              return (
                <li key={t.id} className="flex flex-col sm:flex-row sm:items-center justify-between gap-3 px-6 py-4">
                  <div className="flex items-center gap-3 min-w-0">
                    {/* Payment toggle badge */}
                    <button
                      onClick={() => togglePaid(t.id)}
                      title={isPaid ? "Click to set pending" : "Click to mark verified"}
                      className={`flex-shrink-0 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-widest transition-colors cursor-pointer ${isPaid
                          ? "bg-pickle/20 text-pickle hover:bg-pickle/30 border border-pickle/40"
                          : "bg-brick/20 text-brick hover:bg-brick/30 border border-brick/40"
                        }`}
                    >
                      {isPaid ? "Verified" : "Pending"}
                    </button>

                    {/* Team info */}
                    <div className="min-w-0 flex-1">
                      <span className="font-semibold text-foreground truncate block">{t.name}</span>
                      <span className="block text-xs text-muted-foreground truncate">
                        {t.players.join(" & ")}
                      </span>
                    </div>
                  </div>

                  {/* Attachment Photo Action */}
                  <div className="flex items-center gap-2 self-start sm:self-auto">
                    <button
                      onClick={() => setSelectedModalTeam(t)}
                      className="inline-flex items-center gap-1.5 px-3 py-1.5 border border-border bg-charcoal text-sand text-[0.65rem] font-bold uppercase tracking-widest hover:border-pickle hover:text-pickle transition-colors cursor-pointer"
                    >
                      {proof ? (
                        <>
                          <span className="h-2 w-2 rounded-full bg-pickle" />
                          <span>View Receipt Photo</span>
                        </>
                      ) : (
                        <>
                          <span className="h-2 w-2 rounded-full bg-brick" />
                          <span>Attach Photo</span>
                        </>
                      )}
                    </button>

                    <button
                      onClick={() => handleRemoveTeam(t.id, t.name)}
                      className="px-2.5 py-1.5 border border-brick/40 bg-brick/10 text-brick hover:bg-brick hover:text-sand text-[0.65rem] font-bold uppercase tracking-widest transition-colors rounded cursor-pointer"
                    >
                      Delete Team
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
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
  const [role, setRole] = useState<"admin" | "umpire">("umpire");
  const [customCode, setCustomCode] = useState("");
  const [copiedCodeId, setCopiedCodeId] = useState<string | null>(null);

  const handleGenerate = (e: React.FormEvent) => {
    e.preventDefault();
    generateNewCode(role, customCode, "Admin Director");
    setCodes(getAccessCodes());
    setCustomCode("");
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
      <div className="surface-card p-0 overflow-hidden border border-border">
        <div className="bg-charcoal px-6 py-4 flex items-center justify-between border-b border-border">
          <span className="text-xs font-bold uppercase tracking-widest text-sand">
            Generated Access Codes Registry
          </span>
          <span className="text-[0.65rem] font-mono text-sand/80 font-bold">
            {codes.length} codes
          </span>
        </div>

        <div className="divide-y divide-border overflow-x-auto">
          {codes.map((c) => (
            <div
              key={c.id}
              className={`flex items-center justify-between gap-4 px-6 py-4 text-xs ${
                c.isUsed ? "bg-charcoal/20 opacity-70" : "bg-background"
              }`}
            >
              <div className="flex items-center gap-4 min-w-0">
                <span className="font-mono text-lg font-bold text-foreground tracking-wider bg-charcoal/60 px-3 py-1 border border-border">
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
                  <span className="block text-[0.65rem] text-muted-foreground mt-0.5">
                    Created on {c.createdAt} by {c.createdBy}
                  </span>
                </div>
              </div>

              <div className="flex items-center gap-2 flex-shrink-0">
                <button
                  onClick={() => handleCopy(c.id, c.code)}
                  className="px-3 py-1.5 border border-border bg-charcoal text-sand text-[0.65rem] font-bold uppercase tracking-widest hover:border-sand transition-colors cursor-pointer"
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
