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
} from "@/lib/tournament-store";
import {
  type AccessCode,
  getAccessCodes,
  generateNewCode,
  revokeCode,
} from "@/lib/access-codes";

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

type TabKey = "bracket-draw" | "brackets" | "court-dispatch" | "teams" | "access-codes" | "tournaments";

const tabs: { key: TabKey; label: string }[] = [
  { key: "bracket-draw", label: "Bracket Draw (MAIN)" },
  { key: "brackets", label: "Brackets" },
  { key: "court-dispatch", label: "Court Dispatch (4 Courts)" },
  { key: "teams", label: "Teams & Payments" },
  { key: "access-codes", label: "Access Codes" },
  { key: "tournaments", label: "Tournaments" },
];

function Admin() {
  const navigate = useNavigate();
  const { tournaments } = useTournamentStore();

  const [isMounted, setIsMounted] = useState(false);
  const [isAuthenticated, setIsAuthenticated] = useState(false);
  const [activeTab, setActiveTab] = useState<TabKey>("tournaments");
  const [mobileMenuOpen, setMobileMenuOpen] = useState(false);
  const [tournamentSlug, setTournamentSlug] = useState<string>("");
  const [categoryId, setCategoryId] = useState<string>("");

  useEffect(() => {
    setIsMounted(true);
    if (typeof localStorage !== "undefined") {
      const auth = localStorage.getItem("mock_auth") === "true";
      setIsAuthenticated(auth);
      const list = getTournaments();
      if (list.length > 0) {
        setTournamentSlug(list[0]!.slug);
        if (list[0]!.categories && list[0]!.categories.length > 0) {
          setCategoryId(list[0]!.categories[0]!.id);
        }
        setActiveTab("bracket-draw");
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
    localStorage.removeItem("mock_auth");
    localStorage.removeItem("mock_admin_name");
    setIsAuthenticated(false);
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
          <span className="text-[0.65rem] uppercase tracking-[0.28em] text-pickle font-bold">
            Tournament Desk
          </span>
          <h2 className="font-display text-3xl sm:text-4xl text-foreground mt-1">
            Organizer Console
          </h2>
          <p className="text-sm text-muted-foreground">
            Sign in as an organizer to create events, manage rosters, configure divisions, and dispatch matches across Courts 1 to 4.
          </p>
          <div className="pt-2 flex flex-col gap-3">
            <button
              onClick={() => {
                localStorage.setItem("mock_auth", "true");
                localStorage.setItem("mock_admin_name", "Tournament Director");
                setIsAuthenticated(true);
              }}
              className="w-full bg-brick py-3.5 px-6 font-display text-2xl tracking-widest text-sand hover:bg-brick-deep transition-all cursor-pointer shadow-md rounded"
            >
              Unlock Organizer Console
            </button>
            <Link
              to="/login"
              className="text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground font-semibold pt-1 transition-colors"
            >
              Sign In with Custom Account &rarr;
            </Link>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="flex min-h-[calc(100vh-4rem)] flex-col md:flex-row">
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
                  className={`flex items-center rounded px-4 py-3 text-left text-sm font-semibold uppercase tracking-widest transition-colors cursor-pointer ${activeTab === key
                      ? "bg-brick text-sand"
                      : "text-sand/80 hover:bg-charcoal/60 hover:text-sand"
                    }`}
                >
                  {label}
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
      <aside className="hidden md:flex w-64 flex-shrink-0 flex-col border-r border-border bg-charcoal">
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
              className={`flex items-center rounded px-4 py-3 text-left text-sm font-semibold uppercase tracking-widest transition-colors cursor-pointer ${activeTab === key
                  ? "bg-brick text-sand"
                  : "text-sand/80 hover:bg-charcoal/60 hover:text-sand"
                }`}
            >
              {label}
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
      <div className="flex flex-1 flex-col bg-background min-w-0">
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
                {tabs.find((t) => t.key === activeTab)?.label}
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
        <main className="flex-1 overflow-y-auto p-4 sm:p-6 md:p-8">
          {activeTab === "tournaments" && (
            <TournamentsManager
              activeTournamentSlug={tournamentSlug}
              onSelectTournament={(slug) => {
                setTournamentSlug(slug);
                const found = tournaments.find((t) => t.slug === slug);
                if (found && found.categories && found.categories[0]) {
                  setCategoryId(found.categories[0].id);
                }
              }}
            />
          )}

          {activeTab !== "tournaments" && activeTab !== "access-codes" && tournaments.length === 0 && (
            <div className="surface-card p-10 sm:p-14 text-center max-w-xl mx-auto border border-border mt-8">
              <span className="text-xs uppercase tracking-[0.28em] text-pickle font-bold">
                Setup Required
              </span>
              <h3 className="font-display text-3xl text-foreground mt-2">No Tournaments Created Yet</h3>
              <p className="mt-2 text-sm text-muted-foreground">
                Please create your first tournament before managing brackets, teams, and court dispatch.
              </p>
              <button
                onClick={() => setActiveTab("tournaments")}
                className="mt-6 bg-brick px-6 py-2.5 font-display text-xl tracking-wider text-sand hover:bg-brick-deep transition-colors cursor-pointer"
              >
                Go to Tournament Creator
              </button>
            </div>
          )}

          {activeTab !== "tournaments" &&
            activeTab !== "access-codes" &&
            tournaments.length > 0 &&
            (!tournament || !category || !tournament.categories || tournament.categories.length === 0) && (
              <div className="surface-card p-10 sm:p-14 text-center max-w-xl mx-auto border border-border mt-8">
                <span className="text-xs uppercase tracking-[0.28em] text-pickle font-bold">
                  Divisions Required
                </span>
                <h3 className="font-display text-3xl text-foreground mt-2">No Divisions Configured</h3>
                <p className="mt-2 text-sm text-muted-foreground">
                  The selected tournament has no categories or divisions configured yet.
                </p>
                <button
                  onClick={() => setActiveTab("tournaments")}
                  className="mt-6 bg-brick px-6 py-2.5 font-display text-xl tracking-wider text-sand hover:bg-brick-deep transition-colors cursor-pointer"
                >
                  Configure Divisions
                </button>
              </div>
            )}

          {tournament && category && activeTab === "teams" && (
            <TeamsTab
              tournament={tournament}
              category={category}
              tournaments={tournaments}
              tournamentSlug={tournamentSlug}
              setTournamentSlug={(slug) => {
                setTournamentSlug(slug);
                const next = tournaments.find((t) => t.slug === slug);
                if (next?.categories?.[0]) {
                  setCategoryId(next.categories[0].id);
                }
              }}
              categoryId={categoryId}
              setCategoryId={(id) => {
                setCategoryId(id);
              }}
            />
          )}
          {tournament && category && activeTab === "brackets" && (
            <DrawsManager
              tournament={tournament}
              category={category}
              tournaments={tournaments}
              tournamentSlug={tournamentSlug}
              setTournamentSlug={(slug) => {
                setTournamentSlug(slug);
                const next = tournaments.find((t) => t.slug === slug);
                if (next?.categories?.[0]) {
                  setCategoryId(next.categories[0].id);
                }
              }}
              categoryId={categoryId}
              setCategoryId={(id) => {
                setCategoryId(id);
              }}
              onSwitchToBracketDraw={() => setActiveTab("bracket-draw")}
            />
          )}
          {tournament && category && activeTab === "bracket-draw" && (
            <BracketDraw
              tournament={tournament}
              category={category}
              tournaments={tournaments}
              tournamentSlug={tournamentSlug}
              setTournamentSlug={(slug) => {
                setTournamentSlug(slug);
                const next = tournaments.find((t) => t.slug === slug);
                if (next?.categories?.[0]) {
                  setCategoryId(next.categories[0].id);
                }
              }}
              categoryId={categoryId}
              setCategoryId={(id) => {
                setCategoryId(id);
              }}
            />
          )}
          {tournament && category && activeTab === "court-dispatch" && (
            <CourtDispatch
              tournament={tournament}
              category={category}
              tournaments={tournaments}
              tournamentSlug={tournamentSlug}
              setTournamentSlug={(slug) => {
                setTournamentSlug(slug);
                const next = tournaments.find((t) => t.slug === slug);
                if (next?.categories?.[0]) {
                  setCategoryId(next.categories[0].id);
                }
              }}
              categoryId={categoryId}
              setCategoryId={(id) => {
                setCategoryId(id);
              }}
            />
          )}
          {activeTab === "access-codes" && <AccessCodesTab />}
        </main>
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
              {isPaid ? "Mark Unpaid" : "Verify & Mark Paid"}
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
  const [filter, setFilter] = useState<"all" | "paid" | "unpaid">("all");

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
    const id = `team-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
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

  const currentTeams = category.teams || [];
  const paidCount = currentTeams.filter((t) => resolvedMap[t.id]).length;
  const unpaidCount = currentTeams.length - paidCount;

  const visibleTeams = currentTeams.filter((t) => {
    if (filter === "paid") return resolvedMap[t.id];
    if (filter === "unpaid") return !resolvedMap[t.id];
    return true;
  });

  return (
    <div className="max-w-3xl space-y-6">
      {/* Modal for viewing attachment photo */}
      {selectedModalTeam && (
        <PaymentProofModal
          team={selectedModalTeam}
          isPaid={resolvedMap[selectedModalTeam.id] ?? false}
          proofUrl={resolvedProofs[selectedModalTeam.id] ?? ""}
          onClose={() => setSelectedModalTeam(null)}
          onTogglePaid={() => togglePaid(selectedModalTeam.id)}
          onUpdateProof={(url) => updateProof(selectedModalTeam.id, url)}
        />
      )}

      <div>
        <span className="text-xs uppercase tracking-[0.28em] text-pickle">Roster management</span>
        <h2 className="mt-1 font-display text-3xl text-foreground">Teams &amp; Payment Verification</h2>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap gap-3">
        <select
          value={tournamentSlug}
          onChange={(e) => {
            setTournamentSlug(e.target.value);
            setPaymentMap({});
            setProofMap({});
            setFilter("all");
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
          }}
          className="border border-input bg-background px-3 py-2 text-sm focus:border-pickle focus:outline-none font-medium"
        >
          {tournament.categories.map((c) => (
            <option key={c.id} value={c.id}>{c.label}</option>
          ))}
        </select>
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
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Paid</p>
        </div>
        <div className="h-10 w-px bg-border" />
        <div className="text-center">
          <p className="font-display text-4xl text-brick">{unpaidCount}</p>
          <p className="text-xs uppercase tracking-widest text-muted-foreground">Unpaid</p>
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
        {(["all", "paid", "unpaid"] as const).map((f) => (
          <button
            key={f}
            onClick={() => setFilter(f)}
            className={`px-4 py-2 text-xs font-bold uppercase tracking-widest transition-colors cursor-pointer ${filter === f
                ? "border-b-2 border-brick text-foreground font-bold"
                : "text-muted-foreground hover:text-foreground"
              }`}
          >
            {f === "all" ? `All (${category.teams.length})` : f === "paid" ? `Verified Paid (${paidCount})` : `Unpaid (${unpaidCount})`}
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
                      title={isPaid ? "Click to mark unpaid" : "Click to mark paid"}
                      className={`flex-shrink-0 rounded-full px-3 py-1 text-xs font-bold uppercase tracking-widest transition-colors cursor-pointer ${isPaid
                          ? "bg-pickle/20 text-pickle hover:bg-pickle/30 border border-pickle/40"
                          : "bg-brick/20 text-brick hover:bg-brick/30 border border-brick/40"
                        }`}
                    >
                      {isPaid ? "Paid" : "Unpaid"}
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
                      className="text-xs font-bold uppercase tracking-widest text-muted-foreground transition-colors hover:text-destructive p-1 cursor-pointer"
                    >
                      Remove
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
