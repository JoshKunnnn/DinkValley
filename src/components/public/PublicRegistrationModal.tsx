import { useState, useEffect } from "react";
import type { Tournament, Category, Team } from "@/data/tournaments";
import { addTeamToCategory } from "@/lib/tournament-store";
import { dbRegisterTeam } from "@/lib/supabase-service";
import { generateUUID } from "@/lib/utils";

interface PublicRegistrationModalProps {
  isOpen: boolean;
  onClose: () => void;
  tournament: Tournament;
  initialCategory?: Category | null;
  onRegistered?: (newTeam: Team) => void;
}

export function PublicRegistrationModal({
  isOpen,
  onClose,
  tournament,
  initialCategory,
  onRegistered,
}: PublicRegistrationModalProps) {
  const [selectedCatId, setSelectedCatId] = useState<string>(
    initialCategory?.id ?? tournament?.categories?.[0]?.id ?? ""
  );

  useEffect(() => {
    if (initialCategory) {
      setSelectedCatId(initialCategory.id);
    } else if (tournament?.categories?.length && !selectedCatId) {
      const first = tournament.categories[0];
      if (first) setSelectedCatId(first.id);
    }
  }, [initialCategory, tournament?.categories, selectedCatId]);

  const [teamName, setTeamName] = useState("");
  const [player1Name, setPlayer1Name] = useState("");
  const [player2Name, setPlayer2Name] = useState("");
  const [club, setClub] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [paymentRef, setPaymentRef] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submittedTeam, setSubmittedTeam] = useState<Team | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen) {
      setTeamName("");
      setPlayer1Name("");
      setPlayer2Name("");
      setClub("");
      setContactEmail("");
      setContactPhone("");
      setPaymentRef("");
      setSubmittedTeam(null);
      setError(null);
    }
  }, [isOpen]);

  if (!isOpen) return null;

  const activeCategory =
    (tournament?.categories || []).find((c) => c.id === selectedCatId) ??
    tournament?.categories?.[0];
  const currentCount = activeCategory?.teams?.length ?? 0;
  const isFull = currentCount >= 32;

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    const cleanTeam = teamName.trim();
    const p1 = player1Name.trim();
    const p2 = player2Name.trim();

    if (!cleanTeam) {
      setError("Please provide a team name.");
      return;
    }
    if (!p1 || !p2) {
      setError("Both Player 1 and Player 2 names are required.");
      return;
    }
    if (isFull) {
      setError("This category has reached maximum capacity (32/32 teams).");
      return;
    }
    if (!activeCategory) {
      setError("Please select a valid division.");
      return;
    }

    const isAlreadyRegistered = (activeCategory.teams || []).some(
      (t) => (t?.name || "").trim().toLowerCase() === cleanTeam.toLowerCase()
    );
    if (isAlreadyRegistered) {
      setError(
        `"${cleanTeam}" is already registered in ${activeCategory.label || "this division"}.`
      );
      return;
    }

    setIsSubmitting(true);

    try {
      const generatedRef = paymentRef.trim() || `GC-${Math.floor(10000000 + Math.random() * 90000000)}`;
      const newTeam: Team = {
        id: generateUUID(),
        name: cleanTeam,
        players: [p1, p2],
        club: club.trim() ? club.trim() : undefined,
        paid: true,
        paymentRef: generatedRef,
        paymentStatus: "Verified",
      };

      // 1. Submit to Supabase
      const rpcResult = await dbRegisterTeam({
        tournamentSlug: tournament.slug,
        categorySlug: activeCategory.id,
        team: newTeam,
      });

      if (!rpcResult.success) {
        setError(rpcResult.error || "Failed to submit registration. Please try again.");
        return;
      }

      if (rpcResult.teamId) {
        newTeam.id = rpcResult.teamId;
      }

      // 2. Add to local tournament store for instant optimistic UI update
      addTeamToCategory(tournament.slug, activeCategory.id, newTeam);

      setSubmittedTeam(newTeam);
      if (onRegistered) {
        onRegistered(newTeam);
      }
    } catch (err: any) {
      setError(err?.message || "Failed to submit registration. Please try again.");
    } finally {
      setIsSubmitting(false);
    }
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/80 backdrop-blur-sm animate-in fade-in">
      <div className="surface-card bg-card border border-border w-full max-w-xl max-h-[92vh] flex flex-col rounded-lg shadow-2xl overflow-hidden">
        {/* Modal Header */}
        <div className="p-4 sm:p-5 border-b border-border bg-charcoal text-sand flex items-center justify-between gap-4">
          <div>
            <span className="text-[0.65rem] font-bold uppercase tracking-[0.24em] text-pickle block">
              Official Team Entry
            </span>
            <h2 className="text-xl sm:text-2xl font-display text-sand mt-0.5">
              Tournament Team Registration
            </h2>
          </div>
          <button
            onClick={onClose}
            className="h-8 w-8 rounded-full border border-sand/20 hover:bg-sand/10 flex items-center justify-center text-sand transition-colors cursor-pointer shrink-0"
            aria-label="Close"
          >
            &times;
          </button>
        </div>

        {/* Confirmation Screen */}
        {submittedTeam ? (
          <div className="p-6 overflow-y-auto space-y-4 text-center">
            <div className="inline-flex p-3 rounded-full bg-pickle/20 text-pickle border border-pickle/40 mx-auto">
              <span className="font-mono font-bold text-xs uppercase tracking-widest">Entry Confirmed</span>
            </div>

            <h3 className="text-2xl font-display text-foreground font-bold">
              Team Registered Successfully
            </h3>
            <p className="text-xs text-muted-foreground max-w-sm mx-auto">
              Your team has been confirmed and placed directly into the official category roster.
            </p>

            <div className="surface-card p-4 text-left border border-border space-y-2 text-xs">
              <div className="flex justify-between border-b border-border/50 pb-1.5">
                <span className="text-muted-foreground uppercase font-mono">Team Name</span>
                <span className="font-bold text-foreground">{submittedTeam.name}</span>
              </div>
              <div className="flex justify-between border-b border-border/50 pb-1.5">
                <span className="text-muted-foreground uppercase font-mono">Division</span>
                <span className="font-semibold text-foreground">{activeCategory?.label} ({activeCategory?.level})</span>
              </div>
              <div className="flex justify-between border-b border-border/50 pb-1.5">
                <span className="text-muted-foreground uppercase font-mono">Players</span>
                <span className="font-semibold text-foreground">{submittedTeam.players.join(" & ")}</span>
              </div>
              {submittedTeam.club && (
                <div className="flex justify-between border-b border-border/50 pb-1.5">
                  <span className="text-muted-foreground uppercase font-mono">Club / Academy</span>
                  <span className="font-semibold text-foreground">{submittedTeam.club}</span>
                </div>
              )}
              <div className="flex justify-between border-b border-border/50 pb-1.5 font-mono">
                <span className="text-muted-foreground uppercase">Reference Code</span>
                <span className="font-bold text-pickle">{submittedTeam.paymentRef}</span>
              </div>
              <div className="flex justify-between font-mono">
                <span className="text-muted-foreground uppercase">Status</span>
                <span className="font-bold text-pickle uppercase">Paid / Confirmed</span>
              </div>
            </div>

            <div className="pt-2">
              <button
                onClick={onClose}
                className="w-full py-2.5 bg-pickle text-sand font-bold text-xs uppercase tracking-widest hover:opacity-90 transition-opacity rounded cursor-pointer"
              >
                Done &middot; Return to Tournament
              </button>
            </div>
          </div>
        ) : (
          <form onSubmit={handleSubmit} className="p-4 sm:p-6 overflow-y-auto space-y-4">
            {error && (
              <div className="p-3 bg-brick/10 border border-brick/40 rounded text-xs text-brick font-medium">
                {error}
              </div>
            )}

            {/* Category Select */}
            <div className="space-y-1.5">
              <label className="text-xs font-bold uppercase tracking-wider text-foreground block">
                Select Division &amp; Category
              </label>
              <select
                value={selectedCatId}
                onChange={(e) => setSelectedCatId(e.target.value)}
                className="w-full bg-charcoal border border-border p-2.5 text-xs text-sand rounded focus:border-pickle focus:outline-none"
              >
                {(tournament?.categories || []).map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} ({c.level} - {c.division}) &middot; {c.teams?.length ?? 0}/32 slots filled
                  </option>
                ))}
              </select>
              {isFull && (
                <p className="text-[0.65rem] text-brick font-bold uppercase tracking-wider">
                  This category is currently full (32 of 32 slots filled).
                </p>
              )}
            </div>

            {/* Team Details */}
            <div className="space-y-3.5 pt-1">
              <div className="grid gap-3 sm:grid-cols-2">
                <div>
                  <label className="text-xs font-bold uppercase tracking-wider text-foreground block mb-1">
                    Team Name *
                  </label>
                  <input
                    type="text"
                    required
                    placeholder="e.g. Metro Dinkers, Kitchen Krushers"
                    value={teamName}
                    onChange={(e) => setTeamName(e.target.value)}
                    className="w-full bg-charcoal border border-border p-2 text-xs text-sand rounded focus:border-pickle focus:outline-none"
                  />
                </div>

                <div>
                  <label className="text-xs font-bold uppercase tracking-wider text-foreground block mb-1">
                    Club or Academy (Optional)
                  </label>
                  <input
                    type="text"
                    placeholder="e.g. Dink Valley, Apex Paddle Club"
                    value={club}
                    onChange={(e) => setClub(e.target.value)}
                    className="w-full bg-charcoal border border-border p-2 text-xs text-sand rounded focus:border-pickle focus:outline-none"
                  />
                </div>
              </div>

              {/* Players Under Team */}
              <div className="space-y-2.5 pt-2 border-t border-border/50">
                <div className="flex items-center justify-between">
                  <span className="text-xs font-bold uppercase tracking-wider text-foreground block">
                    Players Under Team
                  </span>
                  <span className="text-[0.65rem] text-muted-foreground">
                    Both doubles partners required
                  </span>
                </div>

                <div className="grid gap-3 sm:grid-cols-2">
                  <div className="p-3 bg-card border-2 border-border rounded space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="h-5 w-5 rounded-full bg-pickle/20 border border-pickle/40 text-pickle font-mono text-[0.65rem] font-bold flex items-center justify-center shrink-0">
                        P1
                      </span>
                      <label className="text-xs font-bold uppercase tracking-wider text-foreground block">
                        Player 1 Full Name *
                      </label>
                    </div>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Marcus Vance"
                      value={player1Name}
                      onChange={(e) => setPlayer1Name(e.target.value)}
                      className="w-full bg-charcoal border border-border p-2 text-xs text-sand rounded focus:border-pickle focus:outline-none"
                    />
                  </div>

                  <div className="p-3 bg-card border-2 border-border rounded space-y-1.5">
                    <div className="flex items-center gap-1.5">
                      <span className="h-5 w-5 rounded-full bg-pickle/20 border border-pickle/40 text-pickle font-mono text-xs font-bold flex items-center justify-center shrink-0">
                        P2
                      </span>
                      <label className="text-xs font-bold uppercase tracking-wider text-foreground block">
                        Player 2 Full Name *
                      </label>
                    </div>
                    <input
                      type="text"
                      required
                      placeholder="e.g. Elena Rostova"
                      value={player2Name}
                      onChange={(e) => setPlayer2Name(e.target.value)}
                      className="w-full bg-charcoal border border-border p-2 text-xs text-sand rounded focus:border-pickle focus:outline-none"
                    />
                  </div>
                </div>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div>
                <label className="text-xs font-bold uppercase tracking-wider text-foreground block mb-1">
                  Contact Email (Optional)
                </label>
                <input
                  type="email"
                  placeholder="captain@example.com"
                  value={contactEmail}
                  onChange={(e) => setContactEmail(e.target.value)}
                  className="w-full bg-charcoal border border-border p-2 text-xs text-sand rounded focus:border-pickle focus:outline-none"
                />
              </div>
              <div>
                <label className="text-xs font-bold uppercase tracking-wider text-foreground block mb-1">
                  Contact Phone / WhatsApp (Optional)
                </label>
                <input
                  type="tel"
                  placeholder="+63 9XX XXX XXXX"
                  value={contactPhone}
                  onChange={(e) => setContactPhone(e.target.value)}
                  className="w-full bg-charcoal border border-border p-2 text-xs text-sand rounded focus:border-pickle focus:outline-none"
                />
              </div>
            </div>

            {/* Fee & Reference Info */}
            <div className="surface-card p-3.5 border border-border rounded space-y-3 text-xs">
              <div className="flex items-center justify-between text-muted-foreground font-mono uppercase text-[0.65rem]">
                <span>Tournament Entry Fee</span>
                <span className="text-pickle font-bold">{activeCategory?.fee || tournament.entryFee || "PHP 1,000 per team"}</span>
              </div>

              <div>
                <label className="text-[0.65rem] font-bold uppercase tracking-wider text-foreground block mb-1">
                  Payment Reference No. (Optional)
                </label>
                <input
                  type="text"
                  placeholder="e.g. GC-98214309 or bank reference"
                  value={paymentRef}
                  onChange={(e) => setPaymentRef(e.target.value)}
                  className="w-full bg-charcoal border border-border p-1.5 text-xs text-sand rounded font-mono focus:border-pickle focus:outline-none"
                />
              </div>
            </div>

            {/* Actions */}
            <div className="pt-2 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={onClose}
                className="px-4 py-2 border border-border bg-card text-foreground font-semibold text-xs uppercase tracking-wider hover:border-pickle transition-colors rounded cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={isSubmitting || isFull}
                className="px-5 py-2 bg-pickle text-sand font-bold text-xs uppercase tracking-widest hover:opacity-90 transition-opacity rounded cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting ? "Registering..." : "Submit Registration"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
