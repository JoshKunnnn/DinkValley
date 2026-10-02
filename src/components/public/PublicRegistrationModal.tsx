import { useState, useEffect } from "react";
import type { Tournament, Category, Team } from "@/data/tournaments";
import { addPendingRegistration, getUniqueClubTeams, type ExistingClubTeam } from "@/lib/tournament-store";
import { dbSaveTournament } from "@/lib/supabase-service";
import { generateUUID, fileToOptimizedDataUrl } from "@/lib/utils";

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
    initialCategory?.id ?? tournament.categories[0]?.id ?? ""
  );

  useEffect(() => {
    if (initialCategory) {
      setSelectedCatId(initialCategory.id);
    }
  }, [initialCategory]);

  const [teamMode, setTeamMode] = useState<"existing" | "new">("existing");
  const [existingTeams, setExistingTeams] = useState<ExistingClubTeam[]>([]);
  const [selectedExistingTeam, setSelectedExistingTeam] = useState<string>("");
  const [teamSearchQuery, setTeamSearchQuery] = useState<string>("");

  const [teamName, setTeamName] = useState("");
  const [player1Name, setPlayer1Name] = useState("");
  const [player2Name, setPlayer2Name] = useState("");
  const [club, setClub] = useState("");
  const [contactEmail, setContactEmail] = useState("");
  const [contactPhone, setContactPhone] = useState("");
  const [paymentRef, setPaymentRef] = useState("");
  const [receiptDataUrl, setReceiptDataUrl] = useState<string | null>(null);
  const [receiptFileName, setReceiptFileName] = useState<string | null>(null);
  const [isProcessingReceipt, setIsProcessingReceipt] = useState(false);

  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submittedTeam, setSubmittedTeam] = useState<Team | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  useEffect(() => {
    if (isOpen) {
      const allTeams = getUniqueClubTeams();
      setExistingTeams(allTeams);
      setTeamMode(allTeams.length > 0 ? "existing" : "new");
      setSelectedExistingTeam("");
      setTeamSearchQuery("");
      setSubmittedTeam(null);
      setError(null);
      setReceiptDataUrl(null);
      setReceiptFileName(null);
    }
  }, [isOpen]);

  const handleSelectExistingTeam = (tName: string) => {
    setSelectedExistingTeam(tName);
    const found = existingTeams.find((t) => t.name === tName);
    if (found) {
      setTeamName(found.name);
      setClub(found.club || "Dink Valley");
      if (found.players && found.players.length > 0) {
        setPlayer1Name(found.players[0] || "");
      }
      if (found.players && found.players.length > 1) {
        setPlayer2Name(found.players[1] || "");
      }
    }
  };

  const handleSwitchToNewTeam = () => {
    setTeamMode("new");
    setSelectedExistingTeam("");
    setTeamName("");
    setClub("");
    setPlayer1Name("");
    setPlayer2Name("");
  };

  const handleSwitchToExistingTeam = () => {
    setTeamMode("existing");
    if (existingTeams.length > 0 && !selectedExistingTeam && existingTeams[0]) {
      handleSelectExistingTeam(existingTeams[0].name);
    }
  };

  const filteredExistingTeams = existingTeams.filter((t) => {
    if (!teamSearchQuery.trim()) return true;
    const q = teamSearchQuery.toLowerCase();
    const nameMatch = t.name.toLowerCase().includes(q);
    const clubMatch = (t.club || "").toLowerCase().includes(q);
    const playerMatch = t.players.some((p) => p.toLowerCase().includes(q));
    return nameMatch || clubMatch || playerMatch;
  });

  const handleReceiptFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    if (!file.type.startsWith("image/")) {
      setError("Please upload a valid image file (PNG, JPG, or WebP).");
      return;
    }

    setIsProcessingReceipt(true);
    setError(null);

    try {
      const optimized = await fileToOptimizedDataUrl(file);
      setReceiptDataUrl(optimized);
      setReceiptFileName(file.name);
    } catch {
      setError("Failed to process the receipt image. Please try another image file.");
    } finally {
      setIsProcessingReceipt(false);
    }
  };

  const handleRemoveReceipt = () => {
    setReceiptDataUrl(null);
    setReceiptFileName(null);
  };

  if (!isOpen) return null;

  const activeCategory = tournament.categories.find((c) => c.id === selectedCatId) ?? tournament.categories[0];
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
    if (!receiptDataUrl) {
      setError("Please upload your payment receipt or proof of payment screenshot.");
      return;
    }

    const isAlreadyRegistered =
      activeCategory.teams?.some(
        (t) => t.name.trim().toLowerCase() === cleanTeam.toLowerCase()
      ) ||
      (activeCategory.pendingTeams || []).some(
        (t) => t.name.trim().toLowerCase() === cleanTeam.toLowerCase()
      );
    if (isAlreadyRegistered) {
      setError(`"${cleanTeam}" is already registered (or pending approval) in ${activeCategory.label}.`);
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
        paid: false,
        paymentProofUrl: receiptDataUrl,
        paymentRef: generatedRef,
        paymentStatus: "Pending",
      };

      // 1. Add to local and tournament store as pending verification
      const updatedTourney = addPendingRegistration(tournament.slug, activeCategory.id, newTeam);

      // 2. Persist directly to Supabase cloud
      if (updatedTourney) {
        await dbSaveTournament(updatedTourney);
      }

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
              <span className="font-mono font-bold text-xs uppercase tracking-widest">Entry Submitted</span>
            </div>

            <h3 className="text-2xl font-display text-foreground">
              Registration Received
            </h3>
            <p className="text-xs text-muted-foreground max-w-sm mx-auto">
              Your registration and payment receipt have been submitted. An administrator will review and verify your receipt before officially confirming your team in the category roster.
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
              {submittedTeam.paymentProofUrl && (
                <div className="pt-2">
                  <div className="flex items-center justify-between mb-1.5 font-mono text-[0.65rem]">
                    <span className="text-muted-foreground uppercase">Attached Receipt</span>
                    <span className="text-pickle font-bold">Uploaded &middot; Pending Verification</span>
                  </div>
                  <div className="rounded border border-border bg-charcoal/80 p-2 flex items-center justify-center">
                    <img
                      src={submittedTeam.paymentProofUrl}
                      alt="Uploaded payment receipt"
                      className="max-h-40 w-auto rounded object-contain border border-border/60 shadow-sm"
                    />
                  </div>
                </div>
              )}
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
                {tournament.categories.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.label} ({c.level} - {c.division}) &middot; {c.teams.length}/32 slots filled
                  </option>
                ))}
              </select>
              {isFull && (
                <p className="text-[0.65rem] text-brick font-bold uppercase tracking-wider">
                  This category is currently full (32 of 32 slots filled).
                </p>
              )}
            </div>

            {/* Team Details & Existing Team Fetcher */}
            <div className="space-y-3.5 pt-1">
              <div className="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                <label className="text-xs font-bold uppercase tracking-wider text-foreground block">
                  Team Information
                </label>
                {existingTeams.length > 0 && (
                  <div className="grid grid-cols-2 p-0.5 bg-charcoal rounded border border-border text-[0.65rem] font-bold uppercase tracking-wider">
                    <button
                      type="button"
                      onClick={handleSwitchToExistingTeam}
                      className={`px-3 py-1 rounded transition-all cursor-pointer ${
                        teamMode === "existing"
                          ? "bg-pickle text-sand font-bold shadow-xs"
                          : "text-muted-foreground hover:text-sand"
                      }`}
                    >
                      Existing Team
                    </button>
                    <button
                      type="button"
                      onClick={handleSwitchToNewTeam}
                      className={`px-3 py-1 rounded transition-all cursor-pointer ${
                        teamMode === "new"
                          ? "bg-pickle text-sand font-bold shadow-xs"
                          : "text-muted-foreground hover:text-sand"
                      }`}
                    >
                      Create New Team
                    </button>
                  </div>
                )}
              </div>

              {/* Existing Team Selector with Search Filter */}
              {teamMode === "existing" && existingTeams.length > 0 ? (
                <div className="space-y-2.5 bg-card p-3.5 rounded-lg border-2 border-border">
                  <div className="flex items-center justify-between">
                    <span className="text-[0.65rem] font-bold uppercase tracking-wider text-pickle">
                      Select Registered Club Team
                    </span>
                    <span className="text-[0.6rem] font-mono text-muted-foreground">
                      {existingTeams.length} teams available
                    </span>
                  </div>

                  {/* Search query input */}
                  <input
                    type="text"
                    placeholder="Search by team, club, or player name..."
                    value={teamSearchQuery}
                    onChange={(e) => setTeamSearchQuery(e.target.value)}
                    className="w-full bg-charcoal border border-border p-2 text-xs text-sand rounded focus:border-pickle focus:outline-none placeholder:text-muted-foreground/60"
                  />

                  {/* Select team dropdown */}
                  <select
                    value={selectedExistingTeam}
                    onChange={(e) => handleSelectExistingTeam(e.target.value)}
                    className="w-full bg-charcoal border border-border p-2.5 text-xs text-sand rounded focus:border-pickle focus:outline-none font-medium cursor-pointer"
                  >
                    <option value="" disabled>
                      -- Choose a team from directory ({filteredExistingTeams.length} matches) --
                    </option>
                    {filteredExistingTeams.map((t) => (
                      <option key={t.name} value={t.name}>
                        {t.name} ({t.club || "Dink Valley"}) &mdash; {t.players.join(" & ")}
                      </option>
                    ))}
                  </select>

                  {selectedExistingTeam && (
                    <div className="text-[0.65rem] text-pickle font-mono bg-pickle/10 p-2 rounded border border-pickle/30 flex flex-col sm:flex-row sm:items-center justify-between gap-1">
                      <span>Connected: <strong>{teamName}</strong> ({club || "Dink Valley"})</span>
                      <span className="text-muted-foreground">Roster pre-filled below &mdash; confirm or edit</span>
                    </div>
                  )}
                </div>
              ) : (
                /* New Team Custom Fields */
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
              )}

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
                    Contact Email
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
                    Contact Phone / WhatsApp
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

            {/* Payment & Receipt Upload Section */}
            <div className="surface-card p-3.5 border border-border rounded space-y-3 text-xs">
              <div className="flex items-center justify-between text-muted-foreground font-mono uppercase text-[0.65rem]">
                <span>Tournament Entry Fee</span>
                <span className="text-pickle font-bold">{activeCategory?.fee || tournament.entryFee || "PHP 1,000 per team"}</span>
              </div>

              {/* Receipt File Upload */}
              <div className="space-y-1.5">
                <div className="flex items-center justify-between">
                  <label className="text-[0.65rem] font-bold uppercase tracking-wider text-foreground block">
                    Upload Payment Receipt *
                  </label>
                  <span className="text-[0.6rem] font-mono text-pickle">
                    Required for entry
                  </span>
                </div>

                {receiptDataUrl ? (
                  <div className="rounded border border-pickle/40 bg-charcoal/90 p-3 space-y-2">
                    <div className="flex items-center justify-between gap-2">
                      <div className="flex items-center gap-2 min-w-0">
                        <span className="h-2 w-2 rounded-full bg-pickle shrink-0" />
                        <span className="text-[0.7rem] font-mono text-sand truncate">
                          {receiptFileName || "receipt-image.jpg"}
                        </span>
                      </div>
                      <button
                        type="button"
                        onClick={handleRemoveReceipt}
                        className="text-[0.65rem] uppercase font-bold text-brick hover:underline shrink-0 cursor-pointer"
                      >
                        Remove
                      </button>
                    </div>

                    <div className="relative rounded overflow-hidden border border-border/70 bg-black/40 flex items-center justify-center p-2">
                      <img
                        src={receiptDataUrl}
                        alt="Receipt preview"
                        className="max-h-40 w-auto object-contain rounded"
                      />
                    </div>
                  </div>
                ) : (
                  <div>
                    <label className="relative flex flex-col items-center justify-center border-2 border-dashed border-border hover:border-pickle/70 rounded-lg p-4 bg-card hover:bg-pickle/5 transition-colors cursor-pointer text-center group">
                      <input
                        type="file"
                        accept="image/*"
                        onChange={handleReceiptFileChange}
                        disabled={isProcessingReceipt}
                        className="sr-only"
                      />
                      <svg
                        className="h-8 w-8 text-pickle/80 group-hover:text-pickle transition-colors mb-2"
                        fill="none"
                        viewBox="0 0 24 24"
                        stroke="currentColor"
                      >
                        <path
                          strokeLinecap="round"
                          strokeLinejoin="round"
                          strokeWidth={1.8}
                          d="M4 16l4.586-4.586a2 2 0 012.828 0L16 16m-2-2l1.586-1.586a2 2 0 012.828 0L20 14m-6-6h.01M6 20h12a2 2 0 002-2V6a2 2 0 00-2-2H6a2 2 0 00-2 2v12a2 2 0 002 2z"
                        />
                      </svg>
                      <span className="text-xs font-semibold text-sand block">
                        {isProcessingReceipt ? "Processing receipt..." : "Click or tap to upload receipt image"}
                      </span>
                      <span className="text-[0.65rem] text-muted-foreground mt-0.5 block">
                        Screenshot or photo from GCash, Maya, or Bank App (PNG, JPG, WebP)
                      </span>
                    </label>
                  </div>
                )}
              </div>

              {/* Reference Number input */}
              <div>
                <label className="text-[0.65rem] font-bold uppercase tracking-wider text-foreground block mb-1">
                  Reference No. (Optional if clear on receipt)
                </label>
                <input
                  type="text"
                  placeholder="e.g. 109283749812 or GC-98214309"
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
                disabled={isSubmitting || isFull || isProcessingReceipt}
                className="px-5 py-2 bg-pickle text-sand font-bold text-xs uppercase tracking-widest hover:opacity-90 transition-opacity rounded cursor-pointer disabled:opacity-50 disabled:cursor-not-allowed"
              >
                {isSubmitting
                  ? "Registering..."
                  : isProcessingReceipt
                  ? "Processing Image..."
                  : "Submit Registration"}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
