import { useState } from "react";
import { Link } from "@tanstack/react-router";
import type { Tournament, Category, CategoryId } from "@/data/tournaments";
import {
  useTournamentStore,
  slugify,
  type NewTournamentInput,
} from "@/lib/tournament-store";
import {
  exportTournamentTeamsToCsv,
  exportTournamentGroupedPerCategoryCsv,
  exportTournamentToExcelWorkbook,
} from "@/lib/csv-export";

interface TournamentsManagerProps {
  onSelectTournament?: (slug: string) => void;
  activeTournamentSlug?: string;
}

type PresetCategory = {
  label: string;
  level: Category["level"];
  division: Category["division"];
  defaultFee: string;
};

const PRESET_CATEGORIES: PresetCategory[] = [
  { label: "Open Championship", level: "Open", division: "Open", defaultFee: "PHP 1,500 per team" },
  { label: "Open Mixed Doubles", level: "Open", division: "Mixed", defaultFee: "PHP 1,200 per team" },
  { label: "Advance Men's Doubles", level: "Advance", division: "Men's", defaultFee: "PHP 1,000 per team" },
  { label: "Intermediate Women's Doubles", level: "Intermediate", division: "Women's", defaultFee: "PHP 900 per team" },
  { label: "Novice Mixed Doubles", level: "Novice", division: "Mixed", defaultFee: "PHP 800 per team" },
  { label: "Beginners Men's Doubles", level: "Beginners", division: "Men's", defaultFee: "PHP 700 per team" },
];

export function TournamentsManager({
  onSelectTournament,
  activeTournamentSlug,
}: TournamentsManagerProps) {
  const { tournaments, addTournament, updateTournament, deleteTournament } = useTournamentStore();

  const [viewMode, setViewMode] = useState<"create" | "list">(() =>
    tournaments.length === 0 ? "create" : "list"
  );

  // Form state
  const [name, setName] = useState("");
  const [slug, setSlug] = useState("");
  const [tagline, setTagline] = useState("");
  const [venue, setVenue] = useState("");
  const [city, setCity] = useState("Santiago City");
  const [startDate, setStartDate] = useState("");
  const [endDate, setEndDate] = useState("");
  const [customDate, setCustomDate] = useState("");
  const [format, setFormat] = useState("Round robin pools, top 4 advance to playoffs");
  const [status, setStatus] = useState<Tournament["status"]>("Registration open");

  // Rules state
  const [rules, setRules] = useState<string[]>([
    "Games to 11, win by 2. Playoff finals to 15.",
    "Facility constraint: strictly 4 courts active at a time. Other matches wait in Queue.",
    "Players must report courtside within 5 minutes of dispatch call.",
  ]);
  const [newRule, setNewRule] = useState("");

  // Categories state
  const [selectedCategories, setSelectedCategories] = useState<Category[]>([
    {
      id: "open-champ",
      label: "Open Championship",
      level: "Open",
      division: "Open",
      fee: "PHP 1,500 per team",
      teams: [],
      pools: [],
      standings: [],
      playoffs: [],
    },
    {
      id: "nov-mixed",
      label: "Novice Mixed Doubles",
      level: "Novice",
      division: "Mixed",
      fee: "PHP 800 per team",
      teams: [],
      pools: [],
      standings: [],
      playoffs: [],
    },
  ]);

  // Custom category input
  const [customCategoryLabel, setCustomCategoryLabel] = useState("");
  const [customLevel, setCustomLevel] = useState<Category["level"]>("Intermediate");
  const [customDivision, setCustomDivision] = useState<Category["division"]>("Men's");
  const [customFee, setCustomFee] = useState("PHP 1,000 per team");

  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const handleNameChange = (val: string) => {
    setName(val);
    setSlug(slugify(val));
  };

  const handleTogglePreset = (preset: PresetCategory) => {
    const id = slugify(`${preset.level}-${preset.division}-${preset.label}`);
    const exists = selectedCategories.some((c) => c.label === preset.label);
    if (exists) {
      setSelectedCategories((prev) => prev.filter((c) => c.label !== preset.label));
    } else {
      setSelectedCategories((prev) => [
        ...prev,
        {
          id,
          label: preset.label,
          level: preset.level,
          division: preset.division,
          fee: preset.defaultFee,
          teams: [],
          pools: [],
          standings: [],
          playoffs: [],
        },
      ]);
    }
  };

  const handleAddCustomCategory = () => {
    if (!customCategoryLabel.trim()) return;
    const label = customCategoryLabel.trim();
    const id = slugify(`${customLevel}-${customDivision}-${label}-${Date.now().toString(36)}`);
    setSelectedCategories((prev) => [
      ...prev,
      {
        id,
        label,
        level: customLevel,
        division: customDivision,
        fee: customFee.trim() || undefined,
        teams: [],
        pools: [],
        standings: [],
        playoffs: [],
      },
    ]);
    setCustomCategoryLabel("");
    setCustomFee("PHP 1,000 per team");
  };

  const handleUpdateCategoryFee = (id: CategoryId, fee: string) => {
    setSelectedCategories((prev) =>
      prev.map((c) => (c.id === id ? { ...c, fee } : c))
    );
  };

  const handleRemoveCategory = (id: CategoryId) => {
    setSelectedCategories((prev) => prev.filter((c) => c.id !== id));
  };

  const handleAddRule = () => {
    if (!newRule.trim()) return;
    setRules((prev) => [...prev, newRule.trim()]);
    setNewRule("");
  };

  const handleRemoveRule = (index: number) => {
    setRules((prev) => prev.filter((_, i) => i !== index));
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (!name.trim()) {
      setError("Tournament name is required.");
      return;
    }

    if (selectedCategories.length === 0) {
      setError("Please add or select at least one division/category.");
      return;
    }

    let dateString = customDate.trim();
    if (!dateString && startDate) {
      dateString = endDate && endDate !== startDate ? `${startDate} to ${endDate}` : startDate;
    }
    if (!dateString) {
      dateString = "TBD";
    }

    const payload: NewTournamentInput = {
      name: name.trim(),
      slug: slug.trim() || slugify(name),
      tagline: tagline.trim() || `${name.trim()} Tournament at Dink Valley`,
      status,
      date: dateString,
      venue: venue.trim() || "Santiago City",
      city: city.trim() || "Santiago City",
      format: format.trim(),
      categories: selectedCategories,
      rules,
    };

    const created = addTournament(payload);
    setNotice(`Tournament "${created.name}" created successfully.`);
    if (onSelectTournament) {
      onSelectTournament(created.slug);
    }

    // Reset form
    setName("");
    setSlug("");
    setTagline("");
    setVenue("");
    setCity("Santiago City");
    setStartDate("");
    setEndDate("");
    setCustomDate("");
    setViewMode("list");
  };

  const handleDelete = (tourneySlug: string, tourneyName: string) => {
    if (window.confirm(`Are you sure you want to delete "${tourneyName}"? This action cannot be undone.`)) {
      deleteTournament(tourneySlug);
      setNotice(`Tournament "${tourneyName}" removed.`);
    }
  };

  const handleStatusChange = (tourneySlug: string, newStatus: Tournament["status"]) => {
    updateTournament(tourneySlug, { status: newStatus });
    setNotice(`Status updated to ${newStatus}.`);
  };

  return (
    <div className="space-y-6">
      {/* Top Header & Mode Toggle */}
      <div className="flex flex-col gap-4 sm:flex-row sm:items-center sm:justify-between border-b border-border pb-5">
        <div>
          <span className="text-xs font-bold uppercase tracking-[0.28em] text-pickle">
            Tournament Desk
          </span>
          <h2 className="font-display text-3xl sm:text-4xl text-foreground mt-1">
            Tournament Management
          </h2>
          <p className="text-sm text-muted-foreground mt-1">
            Create, configure, and manage tournaments, category divisions, and facility play rules.
          </p>
        </div>

        <div className="flex items-center gap-2">
          <button
            onClick={() => setViewMode("list")}
            className={`px-4 py-2 text-xs font-bold uppercase tracking-widest transition-all cursor-pointer rounded border ${
              viewMode === "list"
                ? "bg-foreground text-background border-foreground shadow-xs"
                : "bg-card text-foreground/80 border-border hover:border-foreground/40 hover:text-foreground"
            }`}
          >
            All Tournaments ({tournaments.length})
          </button>
          <button
            onClick={() => setViewMode("create")}
            className={`px-4 py-2 text-xs font-bold uppercase tracking-widest transition-all cursor-pointer rounded border ${
              viewMode === "create"
                ? "bg-brick text-sand border-brick shadow-xs hover:bg-brick-deep"
                : "bg-card text-foreground/80 border-border hover:border-foreground/40 hover:text-foreground"
            }`}
          >
            + Create Tournament
          </button>
        </div>
      </div>

      {/* Notifications */}
      {notice && (
        <div className="bg-pickle/15 border border-pickle/40 rounded-lg p-4 text-xs font-bold uppercase tracking-wider text-pickle flex items-center justify-between shadow-xs">
          <span>{notice}</span>
          <button
            onClick={() => setNotice(null)}
            className="text-pickle hover:text-foreground cursor-pointer ml-4 font-semibold"
          >
            Dismiss
          </button>
        </div>
      )}

      {error && (
        <div className="bg-brick/15 border border-brick/40 rounded-lg p-4 text-xs font-bold uppercase tracking-wider text-brick flex items-center justify-between shadow-xs">
          <span>{error}</span>
          <button
            onClick={() => setError(null)}
            className="text-brick hover:text-foreground cursor-pointer ml-4 font-semibold"
          >
            Dismiss
          </button>
        </div>
      )}

      {/* ── CREATE TOURNAMENT VIEW ── */}
      {viewMode === "create" && (
        <div className="surface-card p-6 sm:p-8 space-y-6 max-w-4xl bg-card border border-border rounded-xl shadow-sm">
          <div className="border-b border-border pb-4">
            <span className="text-[0.65rem] uppercase tracking-[0.28em] text-pickle font-bold">
              New Event Setup
            </span>
            <h3 className="font-display text-3xl sm:text-4xl text-foreground mt-0.5">
              Create Tournament
            </h3>
            <p className="text-sm text-muted-foreground mt-1">
              Configure event details, entry fees, and division brackets. All tournament matches are scheduled strictly across Courts 1 to 4.
            </p>
          </div>

          <form onSubmit={handleSubmit} className="space-y-6">
            {/* Name & Slug */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-foreground mb-1.5">
                  Tournament Name <span className="text-brick">*</span>
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => handleNameChange(e.target.value)}
                  placeholder="e.g. Dink Valley Open 2026"
                  required
                  className="w-full rounded-md border border-input bg-background/60 px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-pickle focus:ring-2 focus:ring-pickle/20 focus:bg-background focus:outline-none transition-all shadow-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-foreground mb-1.5">
                  URL Slug
                </label>
                <input
                  type="text"
                  value={slug}
                  onChange={(e) => setSlug(slugify(e.target.value))}
                  placeholder="e.g. dink-valley-open-2026"
                  className="w-full rounded-md border border-input bg-background/60 px-3.5 py-2.5 text-sm font-mono text-foreground placeholder:text-muted-foreground/60 focus:border-pickle focus:ring-2 focus:ring-pickle/20 focus:bg-background focus:outline-none transition-all shadow-xs"
                />
              </div>
            </div>

            {/* Tagline */}
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-foreground mb-1.5">
                Tagline / Description
              </label>
              <input
                type="text"
                value={tagline}
                onChange={(e) => setTagline(e.target.value)}
                placeholder="e.g. Flagship weekend of pool play and knockout fire"
                className="w-full rounded-md border border-input bg-background/60 px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-pickle focus:ring-2 focus:ring-pickle/20 focus:bg-background focus:outline-none transition-all shadow-xs"
              />
            </div>

            {/* Venue & City */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-5">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-foreground mb-1.5">
                  Venue
                </label>
                <input
                  type="text"
                  value={venue}
                  onChange={(e) => setVenue(e.target.value)}
                  placeholder="Santiago City"
                  className="w-full rounded-md border border-input bg-background/60 px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-pickle focus:ring-2 focus:ring-pickle/20 focus:bg-background focus:outline-none transition-all shadow-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-foreground mb-1.5">
                  City
                </label>
                <input
                  type="text"
                  value={city}
                  onChange={(e) => setCity(e.target.value)}
                  placeholder="Santiago City"
                  className="w-full rounded-md border border-input bg-background/60 px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-pickle focus:ring-2 focus:ring-pickle/20 focus:bg-background focus:outline-none transition-all shadow-xs"
                />
              </div>
            </div>

            {/* Dates */}
            <div className="grid grid-cols-1 sm:grid-cols-3 gap-4">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-foreground mb-1.5">
                  Start Date
                </label>
                <input
                  type="date"
                  value={startDate}
                  onChange={(e) => setStartDate(e.target.value)}
                  className="w-full rounded-md border border-input bg-background/60 px-3 py-2 text-sm text-foreground focus:border-pickle focus:ring-2 focus:ring-pickle/20 focus:bg-background focus:outline-none transition-all shadow-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-foreground mb-1.5">
                  End Date
                </label>
                <input
                  type="date"
                  value={endDate}
                  onChange={(e) => setEndDate(e.target.value)}
                  className="w-full rounded-md border border-input bg-background/60 px-3 py-2 text-sm text-foreground focus:border-pickle focus:ring-2 focus:ring-pickle/20 focus:bg-background focus:outline-none transition-all shadow-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-foreground mb-1.5">
                  Or Custom Date Text
                </label>
                <input
                  type="text"
                  value={customDate}
                  onChange={(e) => setCustomDate(e.target.value)}
                  placeholder="e.g. March 14-15, 2026"
                  className="w-full rounded-md border border-input bg-background/60 px-3.5 py-2 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-pickle focus:ring-2 focus:ring-pickle/20 focus:bg-background focus:outline-none transition-all shadow-xs"
                />
              </div>
            </div>

            {/* Format & Status */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-foreground mb-1.5">
                  Format
                </label>
                <input
                  type="text"
                  value={format}
                  onChange={(e) => setFormat(e.target.value)}
                  placeholder="Round robin pools, top 4 advance"
                  className="w-full rounded-md border border-input bg-background/60 px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-pickle focus:ring-2 focus:ring-pickle/20 focus:bg-background focus:outline-none transition-all shadow-xs"
                />
              </div>
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-foreground mb-1.5">
                  Status
                </label>
                <select
                  value={status}
                  onChange={(e) => setStatus(e.target.value as Tournament["status"])}
                  className="w-full rounded-md border border-input bg-background/60 px-3.5 py-2.5 text-sm text-foreground focus:border-pickle focus:ring-2 focus:ring-pickle/20 focus:bg-background focus:outline-none transition-all shadow-xs font-medium"
                >
                  <option value="Registration open">Registration open</option>
                  <option value="Live">Live</option>
                  <option value="Completed">Completed</option>
                </select>
              </div>
            </div>

            {/* Categories & Divisions Builder */}
            <div className="border-t border-border pt-6 space-y-4">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-pickle">
                  Divisions Configuration
                </span>
                <h4 className="font-display text-2xl sm:text-3xl text-foreground mt-0.5">
                  Tournament Categories ({selectedCategories.length})
                </h4>
                <p className="text-xs text-muted-foreground">
                  Each category has its own pricing, kept private for administrative operations.
                </p>
              </div>

              {/* Preset Checkboxes */}
              <div>
                <span className="block text-xs uppercase tracking-wider text-foreground/80 mb-2 font-bold">
                  Quick Presets:
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-2 md:grid-cols-3 gap-2.5">
                  {PRESET_CATEGORIES.map((preset) => {
                    const isChecked = selectedCategories.some((c) => c.label === preset.label);
                    return (
                      <label
                        key={preset.label}
                        onClick={() => handleTogglePreset(preset)}
                        className={`flex items-center gap-3 p-3 rounded-lg border text-xs cursor-pointer transition-all ${
                          isChecked
                            ? "bg-pickle/15 border-pickle text-foreground shadow-xs ring-1 ring-pickle/40"
                            : "bg-background/80 border-border text-foreground/80 hover:border-foreground/30 hover:bg-background"
                        }`}
                      >
                        <input
                          type="checkbox"
                          checked={isChecked}
                          onChange={() => {}}
                          className="accent-pickle h-4 w-4 rounded"
                        />
                        <div className="min-w-0">
                          <span className="block font-bold text-foreground truncate">{preset.label}</span>
                          <span className="block text-[0.7rem] text-muted-foreground mt-0.5">
                            {preset.level} · {preset.division} · {preset.defaultFee}
                          </span>
                        </div>
                      </label>
                    );
                  })}
                </div>
              </div>

              {/* Add Custom Category */}
              <div className="p-4 rounded-lg border border-border bg-muted/40 space-y-3">
                <span className="block text-xs uppercase tracking-wider text-foreground font-bold">
                  + Add Custom Division &amp; Pricing
                </span>
                <div className="grid grid-cols-1 sm:grid-cols-5 gap-3 items-end">
                  <div className="sm:col-span-2">
                    <label className="block text-[0.65rem] uppercase tracking-wider text-muted-foreground mb-1 font-semibold">
                      Division Label
                    </label>
                    <input
                      type="text"
                      value={customCategoryLabel}
                      onChange={(e) => setCustomCategoryLabel(e.target.value)}
                      placeholder="e.g. 50+ Masters Doubles"
                      className="w-full rounded border border-input bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-pickle focus:ring-1 focus:ring-pickle focus:outline-none shadow-xs"
                    />
                  </div>
                  <div>
                    <label className="block text-[0.65rem] uppercase tracking-wider text-muted-foreground mb-1 font-semibold">
                      Skill Level
                    </label>
                    <select
                      value={customLevel}
                      onChange={(e) => setCustomLevel(e.target.value as Category["level"])}
                      className="w-full rounded border border-input bg-background px-2 py-2 text-xs text-foreground focus:border-pickle focus:ring-1 focus:ring-pickle focus:outline-none shadow-xs font-medium"
                    >
                      <option value="Beginners">Beginners</option>
                      <option value="Novice">Novice</option>
                      <option value="Intermediate">Intermediate</option>
                      <option value="Advance">Advance</option>
                      <option value="Open">Open</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[0.65rem] uppercase tracking-wider text-muted-foreground mb-1 font-semibold">
                      Division Type
                    </label>
                    <select
                      value={customDivision}
                      onChange={(e) => setCustomDivision(e.target.value as Category["division"])}
                      className="w-full rounded border border-input bg-background px-2 py-2 text-xs text-foreground focus:border-pickle focus:ring-1 focus:ring-pickle focus:outline-none shadow-xs font-medium"
                    >
                      <option value="Men's">Men's</option>
                      <option value="Women's">Women's</option>
                      <option value="Mixed">Mixed</option>
                      <option value="Open">Open</option>
                    </select>
                  </div>
                  <div>
                    <label className="block text-[0.65rem] uppercase tracking-wider text-muted-foreground mb-1 font-semibold">
                      Category Fee
                    </label>
                    <input
                      type="text"
                      value={customFee}
                      onChange={(e) => setCustomFee(e.target.value)}
                      placeholder="PHP 1,000 per team"
                      className="w-full rounded border border-input bg-background px-3 py-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-pickle focus:ring-1 focus:ring-pickle focus:outline-none shadow-xs font-medium"
                    />
                  </div>
                </div>
                <button
                  type="button"
                  onClick={handleAddCustomCategory}
                  className="px-4 py-2 rounded text-xs font-bold uppercase tracking-wider bg-pickle text-sand hover:opacity-90 transition-all cursor-pointer shadow-xs"
                >
                  Add Division
                </button>
              </div>

              {/* Selected Categories List with Per-Category Pricing */}
              <div>
                <div className="flex items-center justify-between mb-2">
                  <span className="block text-xs uppercase tracking-wider text-foreground/80 font-bold">
                    Categories &amp; Division Fees ({selectedCategories.length}):
                  </span>
                  <span className="text-[0.65rem] text-muted-foreground">
                    Fees are stored privately for administration
                  </span>
                </div>
                {selectedCategories.length === 0 ? (
                  <p className="text-xs text-brick font-semibold">
                    No categories selected. Please choose or add at least one category.
                  </p>
                ) : (
                  <div className="grid grid-cols-1 sm:grid-cols-2 gap-2.5">
                    {selectedCategories.map((c) => (
                      <div
                        key={c.id}
                        className="flex items-center justify-between gap-3 border border-border bg-background p-2.5 rounded-lg text-xs text-foreground shadow-xs"
                      >
                        <div className="min-w-0 flex-1">
                          <span className="font-bold text-foreground block truncate">{c.label}</span>
                          <span className="text-[0.65rem] font-bold text-pickle uppercase">
                            {c.level} · {c.division}
                          </span>
                        </div>
                        <div className="flex items-center gap-2 flex-shrink-0">
                          <label className="text-[0.65rem] uppercase tracking-wider text-muted-foreground font-semibold">
                            Fee:
                          </label>
                          <input
                            type="text"
                            value={c.fee || ""}
                            onChange={(e) => handleUpdateCategoryFee(c.id, e.target.value)}
                            placeholder="No fee set"
                            className="w-28 sm:w-32 rounded border border-input bg-card px-2 py-1 text-xs text-foreground focus:border-pickle focus:outline-none font-medium"
                          />
                          <button
                            type="button"
                            onClick={() => handleRemoveCategory(c.id)}
                            className="text-muted-foreground hover:text-brick text-sm cursor-pointer ml-1 font-bold p-1"
                            title="Remove category"
                          >
                            x
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </div>

            {/* Rules Section */}
            <div className="border-t border-border pt-6 space-y-4">
              <div>
                <span className="text-xs font-bold uppercase tracking-wider text-pickle">
                  Facility Rules
                </span>
                <h4 className="font-display text-2xl text-foreground mt-0.5">Event Rules</h4>
              </div>

              <div className="space-y-2">
                {rules.map((rule, idx) => (
                  <div
                    key={idx}
                    className="flex items-center justify-between border border-border bg-background/80 px-3.5 py-2.5 rounded-md text-xs text-foreground shadow-xs"
                  >
                    <span>{rule}</span>
                    <button
                      type="button"
                      onClick={() => handleRemoveRule(idx)}
                      className="text-muted-foreground hover:text-brick text-xs font-bold uppercase ml-3 cursor-pointer"
                    >
                      Remove
                    </button>
                  </div>
                ))}
              </div>

              <div className="flex gap-2">
                <input
                  type="text"
                  value={newRule}
                  onChange={(e) => setNewRule(e.target.value)}
                  placeholder="Add a new tournament rule..."
                  className="flex-1 rounded-md border border-input bg-background px-3.5 py-2 text-xs text-foreground placeholder:text-muted-foreground/60 focus:border-pickle focus:ring-1 focus:ring-pickle focus:outline-none shadow-xs"
                />
                <button
                  type="button"
                  onClick={handleAddRule}
                  className="px-4 py-2 rounded-md text-xs font-bold uppercase tracking-wider border border-border bg-card text-foreground hover:border-pickle hover:text-pickle transition-all cursor-pointer shadow-xs"
                >
                  Add Rule
                </button>
              </div>
            </div>

            {/* Submit Button */}
            <div className="pt-4 border-t border-border flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setViewMode("list")}
                className="px-5 py-2.5 text-xs font-bold uppercase tracking-widest border border-border bg-card text-foreground/80 hover:text-foreground hover:border-foreground/30 rounded-md cursor-pointer transition-all"
              >
                Cancel
              </button>
              <button
                type="submit"
                className="bg-brick px-8 py-3 rounded-md font-display text-2xl tracking-widest text-sand hover:bg-brick-deep shadow-md hover:shadow-lg transition-all cursor-pointer"
              >
                Create Tournament
              </button>
            </div>
          </form>
        </div>
      )}

      {/* ── ALL TOURNAMENTS LIST VIEW ── */}
      {viewMode === "list" && (
        <div className="space-y-4">
          {tournaments.length === 0 ? (
            <div className="surface-card p-12 text-center border border-border rounded-xl shadow-sm bg-card">
              <span className="text-xs uppercase tracking-[0.28em] text-pickle font-bold">
                Clean Slate
              </span>
              <h3 className="font-display text-3xl sm:text-4xl text-foreground mt-2">
                No Tournaments Created Yet
              </h3>
              <p className="mt-2 text-sm text-muted-foreground max-w-md mx-auto">
                No tournaments have been added. Start by creating your first tournament to configure divisions, draw brackets, and dispatch matches to Courts 1–4.
              </p>
              <button
                onClick={() => setViewMode("create")}
                className="mt-6 bg-brick px-7 py-3 rounded-md font-display text-2xl tracking-widest text-sand hover:bg-brick-deep shadow-md transition-all cursor-pointer"
              >
                + Create Tournament
              </button>
            </div>
          ) : (
            <div className="grid gap-4">
              {tournaments.map((t) => {
                const isSelected = activeTournamentSlug === t.slug;
                return (
                  <div
                    key={t.slug}
                    className={`surface-card p-6 rounded-xl border transition-all ${
                      isSelected
                        ? "border-pickle/80 ring-1 ring-pickle/40 shadow-md bg-card"
                        : "border-border hover:border-foreground/30 bg-card shadow-xs"
                    }`}
                  >
                    <div className="flex flex-col gap-4 sm:flex-row sm:items-start sm:justify-between">
                      <div className="space-y-1.5 min-w-0">
                        <div className="flex items-center gap-2.5 flex-wrap">
                          <h3 className="font-display text-2xl sm:text-3xl text-foreground leading-tight">
                            {t.name}
                          </h3>
                          <span
                            className={`px-2.5 py-0.5 rounded text-[0.65rem] font-bold uppercase tracking-widest ${
                              t.status === "Live"
                                ? "bg-pickle/15 text-pickle border border-pickle/40"
                                : t.status === "Registration open"
                                ? "bg-muted text-foreground/80 border border-border"
                                : "bg-muted text-muted-foreground"
                            }`}
                          >
                            {t.status}
                          </span>
                          {isSelected && (
                            <span className="px-2.5 py-0.5 rounded text-[0.65rem] font-bold uppercase tracking-widest bg-brick/15 text-brick border border-brick/40">
                              Active in Console
                            </span>
                          )}
                        </div>
                        <p className="text-sm text-muted-foreground">{t.tagline}</p>

                        <div className="flex flex-wrap gap-x-5 gap-y-1.5 text-xs text-muted-foreground pt-1.5">
                          <span>
                            <strong className="text-foreground font-semibold">Dates:</strong> {t.date}
                          </span>
                          <span>
                            <strong className="text-foreground font-semibold">Venue:</strong> {t.venue}
                          </span>
                          <span>
                            <strong className="text-foreground font-semibold">Pricing:</strong> Category-based (Internal)
                          </span>
                        </div>
                      </div>

                      {/* Quick Status Control */}
                      <div className="flex items-center gap-2 flex-shrink-0">
                        <label className="text-[0.65rem] uppercase tracking-wider text-muted-foreground font-bold">
                          Status:
                        </label>
                        <select
                          value={t.status}
                          onChange={(e) =>
                            handleStatusChange(t.slug, e.target.value as Tournament["status"])
                          }
                          className="rounded border border-border bg-background px-3 py-1.5 text-xs text-foreground focus:border-pickle focus:outline-none font-medium shadow-xs"
                        >
                          <option value="Registration open">Registration open</option>
                          <option value="Live">Live</option>
                          <option value="Completed">Completed</option>
                        </select>
                      </div>
                    </div>

                    {/* Categories Bar */}
                    <div className="mt-5 pt-3.5 border-t border-border flex flex-col sm:flex-row sm:items-center justify-between gap-3 text-xs">
                      <div className="flex items-center gap-2 flex-wrap">
                        <span className="text-[0.65rem] uppercase tracking-wider text-pickle font-bold">
                          Categories ({t.categories?.length || 0}):
                        </span>
                        {t.categories?.map((c) => (
                          <span
                            key={c.id}
                            className="bg-muted/50 border border-border px-2.5 py-1 rounded text-[0.7rem] text-foreground/80 font-medium"
                          >
                            {c.label} {c.fee ? `· ${c.fee}` : ""} ({c.teams?.length || 0} teams)
                          </span>
                        ))}
                      </div>

                      <div className="flex items-center gap-2 flex-shrink-0">
                        <button
                          type="button"
                          onClick={() => exportTournamentToExcelWorkbook(t)}
                          className="px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wider border border-pickle bg-pickle/15 text-pickle hover:bg-pickle hover:text-sand transition-all cursor-pointer shadow-xs inline-flex items-center gap-1.5 font-mono"
                          title="Export multi-tab Excel workbook with a tab per category"
                        >
                          <svg className="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M9 17v-2m3 2v-4m3 4v-6m2 10H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                          Export Excel
                        </button>
                        <button
                          type="button"
                          onClick={() => exportTournamentGroupedPerCategoryCsv(t, "all")}
                          className="px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wider border border-border bg-charcoal text-sand hover:border-pickle hover:text-pickle transition-all cursor-pointer shadow-xs inline-flex items-center gap-1.5 font-mono"
                          title="Export whole tournament grouped per category to CSV"
                        >
                          <svg className="w-3.5 h-3.5 text-pickle" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                            <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M12 10v6m0 0l-3-3m3 3l3-3m2 8H7a2 2 0 01-2-2V5a2 2 0 012-2h5.586a1 1 0 01.707.293l5.414 5.414a1 1 0 01.293.707V19a2 2 0 01-2 2z" />
                          </svg>
                          CSV
                        </button>
                        {onSelectTournament && (
                          <button
                            onClick={() => onSelectTournament(t.slug)}
                            className="px-3.5 py-1.5 rounded text-xs font-bold uppercase tracking-wider bg-pickle/15 border border-pickle/40 text-pickle hover:bg-pickle hover:text-sand transition-all cursor-pointer shadow-xs"
                          >
                            Select for Brackets
                          </button>
                        )}
                        <Link
                          to="/tournaments/$slug"
                          params={{ slug: t.slug }}
                          className="px-3.5 py-1.5 rounded text-xs font-bold uppercase tracking-wider border border-border bg-background text-foreground/80 hover:text-foreground hover:border-foreground/30 transition-all shadow-xs"
                        >
                          Public Page
                        </Link>
                        <button
                          onClick={() => handleDelete(t.slug, t.name)}
                          className="px-3 py-1.5 rounded text-xs font-bold uppercase tracking-wider border border-brick/30 text-brick hover:bg-brick/10 transition-all cursor-pointer"
                        >
                          Delete
                        </button>
                      </div>
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
