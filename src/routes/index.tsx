import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useMemo, useRef, useCallback } from "react";
import { useTournamentStore } from "@/lib/tournament-store";
import { useMatchStore } from "@/lib/match-store";
import { dbGetTournaments } from "@/lib/supabase-service";
import type { Tournament } from "@/data/tournaments";
import { CategorySheet } from "@/components/public/CategorySheet";
import {
  ChevronDown,
  ChevronUp,
  ChevronLeft,
  ChevronRight,
  MapPin,
  Navigation,
  ExternalLink,
  Clock,
  Wifi,
  ShoppingBag,
  Droplets,
  Users,
  MonitorPlay,
  ArrowRight,
  Trophy,
  Calendar,
  ShieldCheck,
  Activity,
  Layers,
  CheckCircle2,
  Sparkles,
} from "lucide-react";
import { FacilityCarousel } from "@/components/FacilityCarousel";
import { QualificationsCarousel } from "@/components/public/QualificationsCarousel";

export const Route = createFileRoute("/")({
  loader: async () => {
    try {
      return await dbGetTournaments();
    } catch {
      return [];
    }
  },
  head: () => ({
    meta: [
      { title: "Dink Valley Tournaments | Brackets, Schedules & Results" },
      {
        name: "description",
        content:
          "Pick a Dink Valley pickleball tournament to see categories, pool standings and playoff brackets in Santiago City.",
      },
      { property: "og:title", content: "Dink Valley Tournaments" },
      {
        property: "og:description",
        content: "Categories, pool standings and playoff brackets for every Dink Valley event in Santiago City.",
      },
    ],
  }),
  component: Index,
});

function getTournamentStatusDisplay(status: string) {
  const s = (status || "").toLowerCase();
  if (s.includes("live") || s.includes("play")) {
    return {
      label: "Playing Now",
      style: "bg-pickle text-sand border-pickle",
      dot: true,
      filterKey: "live",
    };
  }
  if (s.includes("complete") || s.includes("finish")) {
    return {
      label: "Finished",
      style: "bg-charcoal text-sand/75 border-border",
      dot: false,
      filterKey: "finished",
    };
  }
  return {
    label: "Open for Sign-up",
    style: "bg-brick text-sand border-brick",
    dot: false,
    filterKey: "open",
  };
}

/* ── FAQ Data (Free of Emojis and Emoticons) ── */
const FAQS = [
  {
    q: "How do I register for a tournament?",
    a: "Browse the tournaments section below, select your desired event, and choose your preferred division. You will be prompted to enter player details and submit proof of payment via GCash or bank transfer. Once reviewed by our tournament desk, your registration status is updated to Verified.",
  },
  {
    q: "What is the entry fee and payment process?",
    a: "Entry fees vary by tournament and category. Official payment instructions are displayed during registration. Please upload your transaction reference or receipt to guarantee your roster slot before the registration deadline.",
  },
  {
    q: "How is player classification determined if I do not have a DUPR rating?",
    a: "If you do not yet have an official DUPR rating, you may self-declare in accordance with our Category Qualifications guidelines below. The tournament committee reserves the authority to review and adjust category placement during warm-up observation on Day 1 to ensure competitive integrity.",
  },
  {
    q: "What is the tournament format?",
    a: "Standard Dink Valley tournaments feature a round-robin pool play phase to establish rankings, followed by a single-elimination playoff bracket. Playoff matches are typically best-of-3 games to 11 points, win by 2.",
  },
  {
    q: "Can I enter multiple categories in the same tournament?",
    a: "Yes. Players are permitted to register across distinct divisions (for example, Open Doubles and 40+ Mixed), provided the schedule allows and separate entry fees are paid. Double registration within the same skill rating is not permitted.",
  },
  {
    q: "What happens if a match is interrupted due to injury or withdrawal?",
    a: "In the event of an unavoidable mid-match withdrawal, a walkover is recorded in favor of the opposing team. Match regulations are governed strictly by the Tournament Director and certified match officials.",
  },
  {
    q: "Are outside refreshments permitted in the facility?",
    a: "Personal sealed hydration bottles and electrolyte packs are permitted. Outside prepared meals are not allowed in the court area. Dink Valley operates a fully stocked refreshment and hydration counter on site.",
  },
  {
    q: "Where is Dink Valley located?",
    a: "Dink Valley Pickleball Club is located at C. Ebersole St (near 3 I. Ancheta St), Santiago City, 3311 Isabela, Philippines.",
  },
];

/* ── Facility Amenities Data (Free of Emojis and Emoticons) ── */
const AMENITIES = [
  {
    icon: Activity,
    title: "Open Play & Tournaments",
    tag: "Court Sessions",
    desc: "Open for booked training sessions, practice drills, and official tournament league play.",
  },
  {
    icon: Trophy,
    title: "Center Court Stadium",
    tag: "Championship Court",
    desc: "Elevated umpire station, broadcast LED illumination, and spectator corridors.",
  },
  {
    icon: Users,
    title: "Spectator Bleachers",
    tag: "Viewing Zones",
    desc: "Comfortable viewing zones offering complete line of sight for all 4 tournament courts.",
  },
  {
    icon: ShoppingBag,
    title: "Pro Equipment & Shop",
    tag: "Gear & Apparel",
    desc: "Performance paddle demos, tournament-approved balls, grips, and club apparel.",
  },
  {
    icon: Droplets,
    title: "Hydration & Staging Lounge",
    tag: "Player Recovery",
    desc: "Air-conditioned player recovery lounge with dedicated hydration and refreshment counter.",
  },
  {
    icon: MonitorPlay,
    title: "Live Match Monitors",
    tag: "Digital Dispatch",
    desc: "Digital court dispatch screens providing real-time match status and tournament brackets.",
  },
];

function AmenitiesCarousel() {
  const [index, setIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const touchStartX = useRef<number | null>(null);
  const touchEndX = useRef<number | null>(null);

  const total = AMENITIES.length;
  const current = AMENITIES[index]!;
  const Icon = current.icon;

  const next = useCallback(() => {
    setIndex((prev) => (prev + 1) % total);
  }, [total]);

  const prev = useCallback(() => {
    setIndex((prev) => (prev - 1 + total) % total);
  }, [total]);

  useEffect(() => {
    if (isPaused) return;
    const interval = setInterval(next, 4500);
    return () => clearInterval(interval);
  }, [isPaused, next]);

  const handleTouchStart = (e: React.TouchEvent) => {
    setIsPaused(true);
    const touch = e.targetTouches[0];
    if (touch) {
      touchStartX.current = touch.clientX;
    }
    touchEndX.current = null;
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const touch = e.targetTouches[0];
    if (touch) {
      touchEndX.current = touch.clientX;
    }
  };

  const handleTouchEnd = () => {
    if (touchStartX.current === null || touchEndX.current === null) {
      setIsPaused(false);
      return;
    }
    const distance = touchStartX.current - touchEndX.current;
    if (distance > 45) {
      next();
    } else if (distance < -45) {
      prev();
    }
    touchStartX.current = null;
    touchEndX.current = null;
    setIsPaused(false);
  };

  return (
    <div>
      {/* Mobile (<md): Interactive Swipeable Carousel (Minimizes vertical height significantly) */}
      <div
        className="md:hidden relative rounded-2xl border-2 border-border bg-charcoal/90 p-4 sm:p-5 shadow-lg select-none"
        onMouseEnter={() => setIsPaused(true)}
        onMouseLeave={() => setIsPaused(false)}
        onTouchStart={handleTouchStart}
        onTouchMove={handleTouchMove}
        onTouchEnd={handleTouchEnd}
      >
        <div className="flex items-center justify-between gap-2 border-b border-white/10 pb-3 mb-3">
          <div className="flex items-center gap-2.5">
            <div className="h-9 w-9 rounded-lg bg-pickle/15 border border-pickle/30 flex items-center justify-center shrink-0">
              <Icon size={18} className="text-pickle" />
            </div>
            <div>
              <span className="text-[0.65rem] font-bold uppercase tracking-wider text-pickle font-mono block">
                {current.tag}
              </span>
              <h3 className="font-display text-lg text-sand leading-tight">
                {current.title}
              </h3>
            </div>
          </div>
          <span className="text-xs font-mono text-sand/50 shrink-0">
            {index + 1} / {total}
          </span>
        </div>

        <p className="text-xs text-sand/80 leading-relaxed min-h-[2.5rem]">
          {current.desc}
        </p>

        {/* Carousel Controls */}
        <div className="mt-3 pt-3 border-t border-white/10 flex items-center justify-between">
          {/* Dot Indicators */}
          <div className="flex items-center gap-1.5">
            {AMENITIES.map((_, i) => (
              <button
                key={i}
                type="button"
                onClick={() => setIndex(i)}
                aria-label={`Go to amenity ${i + 1}`}
                className={`h-2 transition-all rounded-full cursor-pointer ${
                  i === index ? "w-6 bg-pickle" : "w-2 bg-sand/25 hover:bg-sand/40"
                }`}
              />
            ))}
          </div>

          {/* Navigation Buttons (Touch Friendly) */}
          <div className="flex items-center gap-1">
            <button
              type="button"
              onClick={prev}
              aria-label="Previous amenity"
              className="h-10 w-10 flex items-center justify-center rounded-lg border border-border bg-charcoal hover:bg-card text-sand hover:text-pickle transition-colors cursor-pointer active:scale-95"
            >
              <ChevronLeft size={18} />
            </button>
            <button
              type="button"
              onClick={next}
              aria-label="Next amenity"
              className="h-10 w-10 flex items-center justify-center rounded-lg border border-border bg-charcoal hover:bg-card text-sand hover:text-pickle transition-colors cursor-pointer active:scale-95"
            >
              <ChevronRight size={18} />
            </button>
          </div>
        </div>
      </div>

      {/* Desktop (md+): Compact 3-Column Grid */}
      <div className="hidden md:grid md:grid-cols-3 gap-3.5">
        {AMENITIES.map(({ icon: AmenityIcon, title, desc, tag }) => (
          <div
            key={title}
            className="p-4 rounded-xl border-2 border-border bg-charcoal/90 flex flex-col justify-between space-y-2 hover:border-pickle/60 transition-colors"
          >
            <div className="flex items-center gap-3">
              <div className="h-9 w-9 rounded-lg bg-pickle/15 border border-pickle/30 flex items-center justify-center shrink-0">
                <AmenityIcon size={18} className="text-pickle" />
              </div>
              <div>
                <span className="text-[0.65rem] font-bold uppercase tracking-wider text-pickle/90 font-mono block">
                  {tag}
                </span>
                <h3 className="font-display text-lg text-sand leading-snug">
                  {title}
                </h3>
              </div>
            </div>
            <p className="text-xs text-sand/70 leading-relaxed">
              {desc}
            </p>
          </div>
        ))}
      </div>
    </div>
  );
}

function Index() {
  const loaderTournaments = Route.useLoaderData();
  const { tournaments } = useTournamentStore();
  const displayTournaments =
    tournaments.length > 0 ? tournaments : (loaderTournaments ?? []);
  
  const [openFaq, setOpenFaq] = useState<number | null>(null);
  const [statusFilter, setStatusFilter] = useState<"all" | "open" | "live" | "finished">("all");
  const [selectedTournament, setSelectedTournament] = useState<Tournament | null>(null);

  const navigate = useNavigate();
  const { matches } = useMatchStore();

  const liveCategoryIds = useMemo(() => {
    const set = new Set<string>();
    matches.forEach((m) => {
      if (m.status === "live" && m.categoryId) {
        set.add(m.categoryId);
      }
    });
    return set;
  }, [matches]);

  const filteredTournaments = useMemo(() => {
    if (statusFilter === "all") return displayTournaments;
    return displayTournaments.filter((t) => {
      const s = getTournamentStatusDisplay(t.status);
      return s.filterKey === statusFilter;
    });
  }, [displayTournaments, statusFilter]);

  useEffect(() => {
    let timer: NodeJS.Timeout | null = null;
    if (typeof window !== "undefined" && window.location.hash) {
      const targetId = window.location.hash.replace("#", "");
      timer = setTimeout(() => {
        const el = document.getElementById(targetId);
        if (el) {
          el.scrollIntoView({ behavior: "smooth", block: "start" });
        }
      }, 150);
    }
    return () => {
      if (timer) clearTimeout(timer);
    };
  }, []);

  return (
    <div className="min-h-screen bg-background text-foreground flex flex-col">
      {/* ── 1. HERO SECTION (High Athletic Impact, Hero-Centric) ── */}
      <section className="court-lines relative overflow-hidden bg-charcoal border-b border-border">
        {/* Ambient glow accents */}
        <div
          className="absolute -top-32 right-0 w-96 h-96 pointer-events-none rounded-full blur-3xl opacity-25"
          style={{ background: "radial-gradient(circle, var(--pickle) 0%, transparent 70%)" }}
        />
        <div
          className="absolute -bottom-32 left-0 w-96 h-96 pointer-events-none rounded-full blur-3xl opacity-20"
          style={{ background: "radial-gradient(circle, var(--brick) 0%, transparent 70%)" }}
        />

        <div className="relative mx-auto max-w-6xl px-4 py-12 sm:px-6 sm:py-16 md:py-20 lg:py-24">
          <div className="grid items-center gap-10 md:grid-cols-[1.3fr_0.9fr] lg:gap-14">
            {/* Left Headline & CTAs */}
            <div>
              {/* Badge */}
              <div className="inline-flex items-center gap-2 rounded-full border border-pickle/40 bg-pickle/10 px-3.5 py-1 text-xs font-bold uppercase tracking-[0.25em] text-pickle">
                <span className="h-2 w-2 rounded-full bg-pickle animate-pulse" />
                <span>Season 2026 Official Circuit</span>
                <span className="text-sand/40">&middot;</span>
                <span className="text-sand/80 font-mono text-[0.7rem]">Santiago City</span>
              </div>

              {/* Main Headline */}
              <h1 className="mt-5 font-display text-5xl leading-[0.92] text-sand sm:text-6xl md:text-7xl lg:text-8xl tracking-tight">
                Play The Valley.
                <br />
                <span className="text-pickle drop-shadow-[0_2px_16px_rgba(98,197,98,0.3)]">
                  Own The Bracket.
                </span>
              </h1>

              {/* Description */}
              <p className="mt-5 max-w-xl text-base text-sand/80 sm:text-lg leading-relaxed">
                Santiago City's premier pickleball facility. Experience tournament-grade cushioned acrylic courts, real-time live match dispatch, digital bracket tracking, and competitive divisions from Beginners to Open.
              </p>

              {/* Action Buttons */}
              <div className="mt-8 flex flex-col sm:flex-row items-stretch sm:items-center gap-3.5">
                <a
                  href="#tournaments"
                  className="inline-flex items-center justify-center gap-2.5 rounded bg-primary px-7 py-4 font-display text-xl sm:text-2xl tracking-wider text-primary-foreground hover:bg-brick-deep active:scale-[0.98] transition-all shadow-lg hover:shadow-brick/30 cursor-pointer text-center"
                >
                  <span>Explore Tournaments</span>
                  <ArrowRight size={20} />
                </a>

                <a
                  href="#facility"
                  className="inline-flex items-center justify-center gap-2 rounded border-2 border-border/80 bg-charcoal/70 hover:bg-card hover:border-pickle px-6 py-3.5 font-display text-lg sm:text-xl tracking-wider text-sand transition-all cursor-pointer text-center"
                >
                  <MapPin size={18} className="text-pickle" />
                  <span>The Valley Facility</span>
                </a>
              </div>

              {/* Core Metrics Strip */}
              <div className="mt-10 pt-6 border-t border-white/10 grid grid-cols-3 gap-4 text-left">
                <div>
                  <span className="block font-display text-2xl sm:text-3xl text-sand leading-none font-bold">4</span>
                  <span className="text-[0.65rem] sm:text-xs uppercase tracking-wider text-sand/65 font-semibold mt-1 block">
                    Tournament Courts
                  </span>
                </div>
                <div>
                  <span className="block font-display text-2xl sm:text-3xl text-pickle leading-none font-bold">100%</span>
                  <span className="text-[0.65rem] sm:text-xs uppercase tracking-wider text-sand/65 font-semibold mt-1 block">
                    Cloud Synced
                  </span>
                </div>
                <div>
                  <span className="block font-display text-2xl sm:text-3xl text-sand leading-none font-bold">DUPR</span>
                  <span className="text-[0.65rem] sm:text-xs uppercase tracking-wider text-sand/65 font-semibold mt-1 block">
                    Rated Divisions
                  </span>
                </div>
              </div>
            </div>

            {/* Right Hero Visual Card */}
            <div className="flex justify-center md:justify-end">
              <div className="relative w-full max-w-sm rounded-2xl border-2 border-pickle/40 bg-card/85 p-6 backdrop-blur-md shadow-2xl text-center space-y-5">
                {/* Visual Header */}
                <div className="relative inline-block mx-auto">
                  <img
                    src="/DinkValley.jpg"
                    alt="Dink Valley Pickleball Club Crest"
                    className="h-28 w-28 sm:h-32 sm:w-32 rounded-full object-cover ring-4 ring-brick shadow-xl mx-auto"
                  />
                  <div className="absolute -bottom-2 -right-1 bg-pickle text-sand text-[0.65rem] font-bold font-mono px-2.5 py-0.5 rounded-full uppercase tracking-wider border border-charcoal shadow-sm">
                    Verified
                  </div>
                </div>

                <div>
                  <span className="text-[0.65rem] font-bold uppercase tracking-[0.28em] text-pickle block">
                    Santiago City, Isabela
                  </span>
                  <h2 className="font-display text-3xl sm:text-4xl text-foreground mt-1">
                    Dink Valley Club
                  </h2>
                  <p className="text-xs text-muted-foreground mt-1 leading-normal">
                    Official host venue for Santiago City regional tournament circuits &amp; open play.
                  </p>
                </div>

                {/* Features Pill List inside Card */}
                <div className="pt-2 border-t border-border grid grid-cols-2 gap-2 text-left">
                  <div className="p-2.5 rounded bg-background/60 border border-border">
                    <span className="block text-[0.65rem] uppercase tracking-wider text-muted-foreground font-semibold">Courts</span>
                    <span className="text-xs font-bold text-foreground">Acrylic Surface</span>
                  </div>
                  <div className="p-2.5 rounded bg-background/60 border border-border">
                    <span className="block text-[0.65rem] uppercase tracking-wider text-muted-foreground font-semibold">Lighting</span>
                    <span className="text-xs font-bold text-foreground">Anti-Glare LED</span>
                  </div>
                  <div className="p-2.5 rounded bg-background/60 border border-border">
                    <span className="block text-[0.65rem] uppercase tracking-wider text-muted-foreground font-semibold">Scoring</span>
                    <span className="text-xs font-bold text-foreground">Live Terminal</span>
                  </div>
                  <div className="p-2.5 rounded bg-background/60 border border-border">
                    <span className="block text-[0.65rem] uppercase tracking-wider text-muted-foreground font-semibold">Courts</span>
                    <span className="text-xs font-bold text-foreground">4 Dedicated</span>
                  </div>
                </div>

                <a
                  href="#tournaments"
                  className="block w-full py-2.5 rounded bg-charcoal hover:bg-charcoal/80 text-sand text-xs font-bold uppercase tracking-widest transition-colors border border-border"
                >
                  View Active Events &darr;
                </a>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 2. ATHLETIC STATUS TICKER STRIP ── */}
      <div className="bg-charcoal border-b-2 border-pickle/30 py-3 px-4 text-xs font-medium text-sand/80">
        <div className="mx-auto max-w-6xl flex flex-wrap items-center justify-between gap-3 text-center sm:text-left">
          <div className="flex items-center gap-2 mx-auto sm:mx-0">
            <Activity size={15} className="text-pickle shrink-0 animate-pulse" />
            <span className="font-semibold text-sand">Live Facility Status:</span>
            <span className="text-pickle font-bold">4 Tournament Courts Ready</span>
          </div>

          <div className="flex items-center gap-4 text-[0.72rem] text-sand/70 font-mono mx-auto sm:mx-0">
            <span className="inline-flex items-center gap-1.5">
              <MapPin size={13} className="text-pickle" /> C. Ebersole St, Santiago City, 3311 Isabela
            </span>
          </div>
        </div>
      </div>

      {/* ── 3. TOURNAMENTS SECTION (#tournaments) ── */}
      <section id="tournaments" className="mx-auto max-w-6xl px-4 py-14 sm:px-6 sm:py-20 scroll-mt-16 sm:scroll-mt-20 w-full">
        {/* Header with Filters */}
        <div className="flex flex-col md:flex-row md:items-end justify-between gap-4 border-b-2 border-border pb-5">
          <div>
            <div className="inline-flex items-center gap-2 border border-pickle px-3 py-0.5 text-[0.68rem] font-bold uppercase tracking-[0.28em] text-pickle">
              Tournament Calendar
            </div>
            <h2 className="mt-2 font-display text-4xl sm:text-5xl text-foreground tracking-tight">
              Official Tournaments
            </h2>
            <p className="mt-1 text-sm text-muted-foreground">
              Select a tournament to inspect divisions, review pool play standings, and view live playoff brackets.
            </p>
          </div>

          {/* Filter Pills */}
          <div className="flex items-center gap-1.5 overflow-x-auto pb-1 sm:pb-0 shrink-0">
            {(
              [
                { key: "all", label: "All Events" },
                { key: "open", label: "Sign-Up Open" },
                { key: "live", label: "Live Play" },
                { key: "finished", label: "Completed" },
              ] as const
            ).map((filter) => {
              const isActive = statusFilter === filter.key;
              return (
                <button
                  key={filter.key}
                  type="button"
                  onClick={() => setStatusFilter(filter.key)}
                  className={`px-3 py-1.5 rounded-full text-xs font-bold uppercase tracking-wider transition-colors cursor-pointer border ${
                    isActive
                      ? "bg-brick text-sand border-brick shadow-xs"
                      : "bg-card text-muted-foreground border-border hover:border-pickle hover:text-foreground"
                  }`}
                >
                  {filter.label}
                </button>
              );
            })}
          </div>
        </div>

        {/* Tournament Cards Grid */}
        {filteredTournaments.length === 0 ? (
          <div className="surface-card my-10 p-10 sm:p-14 text-center border-2 border-border rounded-2xl">
            <span className="text-xs uppercase tracking-[0.28em] text-pickle font-bold block mb-1">
              Circuit Schedule
            </span>
            <h3 className="font-display text-3xl sm:text-4xl text-foreground">
              No Tournaments Found
            </h3>
            <p className="mt-2 text-sm text-muted-foreground max-w-md mx-auto">
              There are currently no events matching the selected filter. Check back soon for upcoming circuit dates or reset your filter.
            </p>
            {statusFilter !== "all" && (
              <button
                type="button"
                onClick={() => setStatusFilter("all")}
                className="mt-5 inline-flex items-center gap-2 rounded bg-primary px-5 py-2.5 text-xs font-bold uppercase tracking-wider text-primary-foreground hover:bg-brick-deep transition-all cursor-pointer"
              >
                Reset Filter
              </button>
            )}
          </div>
        ) : (
          <div className="mt-8 grid grid-cols-1 gap-5 sm:gap-6 md:grid-cols-2 lg:grid-cols-3">
            {filteredTournaments.map((t) => {
              const statusInfo = getTournamentStatusDisplay(t.status);
              const categoryCount = t.categories?.length || 0;

              return (
                <div
                  key={t.slug}
                  onClick={() => setSelectedTournament(t)}
                  role="button"
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if (e.key === "Enter" || e.key === " ") {
                      e.preventDefault();
                      setSelectedTournament(t);
                    }
                  }}
                  className="surface-card group relative p-6 text-left transition-all duration-300 hover:border-pickle hover:shadow-xl rounded-2xl border-2 border-border cursor-pointer flex flex-col justify-between min-h-[14rem] bg-card"
                >
                  <div>
                    {/* Status & Badge Row */}
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold uppercase tracking-wider rounded-full border ${statusInfo.style}`}
                      >
                        {statusInfo.dot && (
                          <span className="h-2 w-2 rounded-full bg-sand animate-pulse" />
                        )}
                        <span>{statusInfo.label}</span>
                      </span>

                      <span className="text-xs font-mono font-bold uppercase tracking-wider text-pickle group-hover:translate-x-0.5 transition-transform inline-flex items-center gap-1">
                        <span>Select Division</span>
                        <ArrowRight size={14} />
                      </span>
                    </div>

                    {/* Tournament Name */}
                    <h3 className="mt-4 font-display text-2xl sm:text-3xl text-foreground leading-tight group-hover:text-pickle transition-colors">
                      {t.name}
                    </h3>

                    {/* Date & Location */}
                    <div className="mt-3 space-y-1 text-xs text-muted-foreground font-sans">
                      <div className="flex items-center gap-1.5 text-foreground font-semibold">
                        <Calendar size={14} className="text-pickle shrink-0" />
                        <span>{t.date}</span>
                      </div>
                      <div className="flex items-center gap-1.5">
                        <MapPin size={14} className="text-muted-foreground shrink-0" />
                        <span className="truncate">{t.venue}, {t.city}</span>
                      </div>
                    </div>
                  </div>

                  {/* Card Bottom Meta */}
                  <div className="mt-5 pt-3.5 border-t border-border flex items-center justify-between text-xs">
                    <span className="text-muted-foreground font-medium">
                      {categoryCount} {categoryCount === 1 ? "Division" : "Divisions"} Configured
                    </span>
                    <span className="font-mono font-bold text-pickle uppercase text-[0.7rem] bg-pickle/10 px-2.5 py-1 rounded border border-pickle/25">
                      Open Draws
                    </span>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </section>

      {/* ── 4. FACILITY SHOWCASE & AMENITIES ("THE VALLEY") ── */}
      <section id="facility" className="relative overflow-hidden bg-charcoal border-y border-border py-10 sm:py-14 md:py-16 scroll-mt-16 sm:scroll-mt-20">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-4 pb-6 sm:pb-8">
            <div>
              <span className="inline-block border border-pickle px-3 py-1 text-xs font-bold uppercase tracking-[0.28em] text-pickle">
                Premier Venue
              </span>
              <h2 className="mt-2.5 font-display text-4xl sm:text-5xl lg:text-6xl text-sand leading-none">
                The Valley
              </h2>
              <p className="mt-2 max-w-xl text-sm sm:text-base text-sand/75 leading-relaxed">
                4 championship-grade pickleball courts in Santiago City, engineered specifically for serious competition and comfortable community play.
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs text-sand/70 font-mono shrink-0 bg-background/10 px-3 py-2 rounded border border-border">
              <MapPin size={15} className="text-pickle" />
              <span>C. Ebersole St, Santiago City, 3311 Isabela</span>
            </div>
          </div>

          {/* Carousel */}
          <div className="rounded-2xl overflow-hidden border-2 border-border shadow-2xl">
            <FacilityCarousel />
          </div>

          {/* Amenities (Carousel on mobile, Compact Grid on desktop) */}
          <div className="mt-6 sm:mt-8">
            <AmenitiesCarousel />
          </div>

          {/* Google Maps Location Card */}
          <div className="mt-8 rounded-2xl border-2 border-border bg-charcoal/95 p-4 sm:p-6 shadow-xl">
            <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 pb-4 border-b border-white/10">
              <div className="space-y-1">
                <div className="inline-flex items-center gap-2 text-xs font-bold font-mono uppercase tracking-wider text-pickle">
                  <MapPin size={14} className="text-pickle" />
                  <span>Court Location &middot; Google Maps</span>
                </div>
                <h3 className="font-display text-2xl sm:text-3xl text-sand">
                  Dink Valley Pickleball
                </h3>
                <p className="text-xs sm:text-sm text-sand/80">
                  C. Ebersole St, SANTIAGO, City of Santiago, 3311 Isabela (near 3 I. Ancheta St)
                </p>
              </div>

              {/* Action Buttons */}
              <div className="flex flex-wrap items-center gap-2.5">
                <a
                  href="https://www.google.com/maps/dir/?api=1&destination=Dink+Valley+Pickleball&destination_place_id=0x339007fe7dccafe5:0x1b74fabd2aa7183b"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded bg-primary px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-primary-foreground hover:bg-brick-deep transition-all shadow-md active:scale-95 cursor-pointer min-h-[44px]"
                >
                  <Navigation size={15} />
                  <span>Get Directions</span>
                </a>
                <a
                  href="https://www.google.com/maps/place/Dink+Valley+Pickleball/@16.6995003,121.560007,17z/data=!4m6!3m5!1s0x339007fe7dccafe5:0x1b74fabd2aa7183b!8m2!3d16.6995003!4d121.560007!16s%2Fg%2F11z4sfbhrd"
                  target="_blank"
                  rel="noopener noreferrer"
                  className="inline-flex items-center gap-2 rounded border border-border bg-charcoal hover:bg-card px-4 py-2.5 text-xs font-bold uppercase tracking-wider text-sand hover:text-pickle transition-colors active:scale-95 cursor-pointer min-h-[44px]"
                >
                  <ExternalLink size={15} />
                  <span>Open in Google Maps</span>
                </a>
              </div>
            </div>

            {/* Embedded Interactive Map with Named Place Pin */}
            <div className="mt-4 overflow-hidden rounded-xl border-2 border-border/80 shadow-inner bg-charcoal relative">
              <iframe
                title="Dink Valley Pickleball Official Court Location"
                src="https://www.google.com/maps/embed?pb=!1m18!1m12!1m3!1d3822.460113834011!2d121.5574321!3d16.6995003!2m3!1f0!2f0!3f0!3m2!1i1024!2i768!4f13.1!3m3!1m2!1s0x339007fe7dccafe5%3A0x1b74fabd2aa7183b!2sDink%20Valley%20Pickleball!5e0!3m2!1sen!2sph!4v1710000000000!5m2!1sen!2sph"
                className="w-full h-72 sm:h-80 md:h-96 border-0"
                loading="lazy"
                allowFullScreen
                referrerPolicy="no-referrer-when-downgrade"
              />
            </div>

            {/* Quick Location & Arrival Info */}
            <div className="mt-4 pt-3 border-t border-white/10 grid grid-cols-1 sm:grid-cols-2 gap-3 text-xs text-sand/75">
              <div className="flex items-center gap-2">
                <ShieldCheck size={15} className="text-pickle shrink-0" />
                <span>Dedicated Vehicle &amp; Motor Parking</span>
              </div>
              <div className="flex items-center gap-2">
                <MapPin size={15} className="text-pickle shrink-0" />
                <span>Zip 3311 &middot; Isabela, Philippines</span>
              </div>
            </div>
          </div>
        </div>
      </section>

      {/* ── 5. OFFICIAL CATEGORY QUALIFICATIONS & DUPR CRITERIA ── */}
      <section id="qualifications" className="mx-auto max-w-6xl px-4 py-10 sm:py-14 md:py-16 scroll-mt-16 sm:scroll-mt-20 w-full">
        <div className="text-center max-w-2xl mx-auto mb-6 sm:mb-8">
          <span className="inline-block border border-pickle px-3 py-1 text-xs font-bold uppercase tracking-[0.28em] text-pickle">
            Fair Play &amp; Standards
          </span>
          <h2 className="mt-2.5 font-display text-4xl sm:text-5xl text-foreground">
            Category Qualifications
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            To maintain equitable and thrilling competition, all Dink Valley tournament entries follow standardized division criteria and age verification.
          </p>
        </div>

        {/* Carousel Component */}
        <div className="rounded-2xl overflow-hidden border-2 border-border shadow-md bg-card">
          <QualificationsCarousel />
        </div>
      </section>

      {/* ── 6. HOW TO COMPETE (3-Step Quick Start Workflow) ── */}
      <section className="bg-charcoal border-y border-border py-10 sm:py-14 md:py-16 text-sand">
        <div className="mx-auto max-w-6xl px-4 sm:px-6">
          <div className="text-center max-w-xl mx-auto mb-8 sm:mb-10">
            <span className="inline-block border border-pickle px-3 py-1 text-xs font-bold uppercase tracking-[0.28em] text-pickle">
              Tournament Guide
            </span>
            <h2 className="mt-2.5 font-display text-4xl sm:text-5xl text-sand">
              How To Compete
            </h2>
            <p className="mt-2 text-sm text-sand/75">
              Three simple steps to secure your bracket position in our next tournament.
            </p>
          </div>

          <div className="grid grid-cols-1 md:grid-cols-3 gap-4 sm:gap-5">
            <div className="p-4 sm:p-5 rounded-xl border-2 border-border bg-charcoal/80 space-y-2 relative">
              <span className="font-display text-4xl sm:text-5xl text-pickle font-bold opacity-70">01</span>
              <h3 className="font-display text-xl sm:text-2xl text-sand leading-snug">Pick Your Event &amp; Division</h3>
              <p className="text-xs text-sand/70 leading-relaxed">
                Review active tournament dates, inspect division requirements (DUPR / age / level), and select where you and your partner will compete.
              </p>
            </div>

            <div className="p-4 sm:p-5 rounded-xl border-2 border-border bg-charcoal/80 space-y-2 relative">
              <span className="font-display text-4xl sm:text-5xl text-brick font-bold opacity-70">02</span>
              <h3 className="font-display text-xl sm:text-2xl text-sand leading-snug">Submit Team Registration</h3>
              <p className="text-xs text-sand/70 leading-relaxed">
                Click Register in the division drawer, enter both player names, club affiliation, and upload your payment transaction reference.
              </p>
            </div>

            <div className="p-4 sm:p-5 rounded-xl border-2 border-border bg-charcoal/80 space-y-2 relative">
              <span className="font-display text-4xl sm:text-5xl text-sand font-bold opacity-70">03</span>
              <h3 className="font-display text-xl sm:text-2xl text-sand leading-snug">Play &amp; Track Live Draws</h3>
              <p className="text-xs text-sand/70 leading-relaxed">
                Arrive on match day, check in at the Tournament Desk, and follow live court assignments on the digital monitors and public site.
              </p>
            </div>
          </div>
        </div>
      </section>

      {/* ── 7. FREQUENTLY ASKED QUESTIONS (#faq) ── */}
      <section id="faq" className="mx-auto max-w-3xl px-4 py-10 sm:py-14 md:py-16 scroll-mt-16 sm:scroll-mt-20 w-full">
        <div className="text-center mb-10">
          <span className="inline-block border border-pickle px-3 py-1 text-xs font-bold uppercase tracking-[0.28em] text-pickle">
            Need Clarification?
          </span>
          <h2 className="mt-3 font-display text-4xl sm:text-5xl text-foreground">
            Frequently Asked Questions
          </h2>
          <p className="mt-2 text-sm text-muted-foreground">
            Common questions regarding registration rules, fees, qualifications, and court etiquette.
          </p>
        </div>

        <div className="space-y-3">
          {FAQS.map((faq, idx) => {
            const isOpen = openFaq === idx;
            return (
              <div
                key={idx}
                className={`border-2 rounded-xl overflow-hidden transition-all duration-200 ${
                  isOpen
                    ? "border-pickle bg-card shadow-sm"
                    : "border-border bg-card hover:border-pickle/50"
                }`}
              >
                <button
                  id={`faq-${idx}`}
                  type="button"
                  onClick={() => setOpenFaq(isOpen ? null : idx)}
                  aria-expanded={isOpen}
                  className="w-full flex items-center justify-between gap-4 px-5 py-4 text-left cursor-pointer"
                >
                  <span className="text-sm sm:text-base font-bold text-foreground leading-snug">
                    {faq.q}
                  </span>
                  {isOpen ? (
                    <ChevronUp size={18} className="text-pickle shrink-0" />
                  ) : (
                    <ChevronDown size={18} className="text-muted-foreground shrink-0" />
                  )}
                </button>
                {isOpen && (
                  <div className="px-5 pb-5 pt-1 border-t border-border/50">
                    <p className="text-sm text-foreground/80 leading-relaxed">{faq.a}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* ── 8. CLOSING CTA CALLOUT ── */}
      <section className="mx-auto max-w-6xl px-4 pb-20 sm:px-6">
        <div className="rounded-3xl border-2 border-border bg-charcoal p-8 sm:p-12 text-center text-sand relative overflow-hidden shadow-2xl">
          <div className="relative max-w-xl mx-auto space-y-4">
            <span className="inline-block border border-pickle px-3 py-1 text-xs font-bold uppercase tracking-[0.28em] text-pickle">
              Santiago City Pickleball
            </span>
            <h2 className="font-display text-4xl sm:text-5xl md:text-6xl text-sand leading-none">
              Ready To Step On The Court?
            </h2>
            <p className="text-sm sm:text-base text-sand/80 leading-relaxed">
              Find your division, register your team, and compete for championship glory at Dink Valley.
            </p>
            <div className="pt-3 flex flex-wrap justify-center gap-3">
              <a
                href="#tournaments"
                className="inline-flex items-center gap-2 rounded bg-primary px-7 py-3.5 font-display text-xl tracking-wider text-primary-foreground hover:bg-brick-deep transition-all shadow-md cursor-pointer"
              >
                <span>Browse Tournaments</span>
                <ArrowRight size={18} />
              </a>
              <a
                href="#facility"
                className="inline-flex items-center gap-2 rounded border border-border bg-charcoal/80 px-6 py-3.5 font-display text-lg tracking-wider text-sand hover:border-pickle hover:text-pickle transition-colors cursor-pointer"
              >
                <span>Facility Details</span>
              </a>
            </div>
          </div>
        </div>
      </section>

      {/* ── 9. CATEGORY BOTTOM SHEET MODAL ── */}
      {selectedTournament && (
        <CategorySheet
          open={Boolean(selectedTournament)}
          onClose={() => setSelectedTournament(null)}
          tournamentName={selectedTournament.name}
          categories={selectedTournament.categories ?? []}
          liveCategoryIds={liveCategoryIds}
          onSelect={(categoryId) => {
            const slug = selectedTournament.slug;
            setSelectedTournament(null);
            navigate({
              to: "/tournaments/$slug",
              params: { slug },
              search: { category: categoryId },
            });
          }}
        />
      )}
    </div>
  );
}
