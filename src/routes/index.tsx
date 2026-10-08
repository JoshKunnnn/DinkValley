import { createFileRoute, useNavigate } from "@tanstack/react-router";
import { useState, useEffect, useMemo } from "react";
import { useTournamentStore } from "@/lib/tournament-store";
import { useMatchStore } from "@/lib/match-store";
import { dbGetTournaments } from "@/lib/supabase-service";
import type { Tournament } from "@/data/tournaments";
import { CategorySheet } from "@/components/public/CategorySheet";
import {
  ChevronDown,
  ChevronUp,
  MapPin,
  Clock,
  Wifi,
  ShoppingBag,
  Droplets,
  Users,
  MonitorPlay,
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
          "Pick a Dink Valley pickleball tournament to see categories, pool standings and playoff brackets.",
      },
      { property: "og:title", content: "Dink Valley Tournaments" },
      {
        property: "og:description",
        content: "Categories, pool standings and playoff brackets for every Dink Valley event.",
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
    };
  }
  if (s.includes("complete") || s.includes("finish")) {
    return {
      label: "Finished",
      style: "bg-charcoal text-sand/75 border-border",
      dot: false,
    };
  }
  return {
    label: "Open for Sign-up",
    style: "bg-brick text-sand border-brick",
    dot: false,
  };
}



/* ── FAQ data ── */
const FAQS = [
  {
    q: "How do I register for a tournament?",
    a: "Click 'Browse Tournaments', select your event, and tap the registration link. You will receive a confirmation with payment instructions. Paid registration is required to secure your slot.",
  },
  {
    q: "What is the entry fee and payment process?",
    a: "Entry fees vary per tournament and category. Payment is accepted via GCash or bank transfer. Upload your proof of payment during registration to be officially enrolled. Payments not confirmed before the cutoff date will forfeit the slot.",
  },
  {
    q: "How is the classification determined if I don't have a DUPR rating?",
    a: "If you do not yet have an official DUPR rating, you may self-declare based on the criteria listed above. The tournament committee reserves the right to reassign a player to an appropriate category after warm-up observation on Day 1.",
  },
  {
    q: "What is the tournament format?",
    a: "All categories follow a round-robin pool play phase to determine standings, followed by a single-elimination playoff bracket. Finals are best-of-3 games to 11 points, win by 2.",
  },
  {
    q: "Can I join multiple categories?",
    a: "Yes. Players may enter across skill categories (e.g., Intermediate and 40+) as long as entry fees are paid per category. Double registration in the same skill level is not permitted.",
  },
  {
    q: "What happens if a match is not completed due to injury or withdrawal?",
    a: "A walkover is awarded to the opposing team. Refunds are not issued for mid-tournament withdrawals. Medical emergencies are handled on a case-by-case basis by the Tournament Director.",
  },
  {
    q: "Is outside food and drinks allowed inside the facility?",
    a: "Sealed water bottles and personal hydration packs are permitted. Outside meals and cooked food are not allowed inside the court area. Dink Valley's refreshment counter is available for players and spectators.",
  },
  {
    q: "Where is Dink Valley located?",
    a: "Dink Valley Pickleball Club is located in Santiago City, Isabela, Philippines. Courts are open daily from 6:00 AM to 10:00 PM.",
  },
];

function Index() {
  const loaderTournaments = Route.useLoaderData();
  const { tournaments } = useTournamentStore();
  const displayTournaments =
    tournaments.length > 0 ? tournaments : (loaderTournaments ?? []);
  const [openFaq, setOpenFaq] = useState<number | null>(null);

  const navigate = useNavigate();
  const { matches } = useMatchStore();
  const [selectedTournament, setSelectedTournament] = useState<Tournament | null>(null);

  const liveCategoryIds = useMemo(() => {
    const set = new Set<string>();
    matches.forEach((m) => {
      if (m.status === "live" && m.categoryId) {
        set.add(m.categoryId);
      }
    });
    return set;
  }, [matches]);

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
    <div>
      {/* ── Hero Section ── */}
      <section className="court-lines relative overflow-hidden">
        <div className="mx-auto grid max-w-6xl items-center gap-8 px-4 py-12 sm:px-5 sm:py-16 md:grid-cols-[1.4fr_1fr] md:py-20 lg:gap-10">
          <div>
            <span className="inline-block border border-pickle px-3 py-1 text-xs font-bold uppercase tracking-[0.28em] text-pickle">
              Season 2026
            </span>
            <h1 className="mt-4 font-display text-5xl leading-[0.92] text-sand sm:text-6xl md:text-7xl lg:text-8xl">
              Play the valley.
              <br />
              Own the bracket.
            </h1>
            <p className="mt-4 max-w-lg text-base text-sand/75 sm:text-lg">
              Every Dink Valley event, from beginners to open category. Pick a tournament to see
              draws, pool standings and the road to the final.
            </p>
            <a
              href="#tournaments"
              className="mt-6 inline-block bg-primary px-6 py-3 font-display text-xl tracking-wide text-primary-foreground transition-colors hover:bg-brick-deep sm:mt-8 sm:px-7 sm:text-2xl"
            >
              Browse tournaments
            </a>
          </div>

          <div className="flex justify-center md:block">
            <img
              src="/DinkValley.jpg"
              alt="Dink Valley pickleball club crest"
              className="w-40 drop-shadow-2xl sm:w-52 md:w-full"
            />
          </div>
        </div>
      </section>

      {/* ── Facility Showcase ── */}
      <section id="facility" className="relative overflow-hidden bg-charcoal scroll-mt-16 sm:scroll-mt-20">
        <div className="mx-auto max-w-6xl px-4 pt-14 pb-10 sm:px-5 sm:pt-16 sm:pb-12">
          <div className="flex flex-col sm:flex-row sm:items-end sm:justify-between gap-3">
            <div>
              <span className="inline-block border border-pickle px-3 py-1 text-xs font-bold uppercase tracking-[0.28em] text-pickle">
                Our Facility
              </span>
              <h2 className="mt-3 font-display text-4xl leading-tight text-sand sm:text-5xl lg:text-6xl">
                The Valley
              </h2>
              <p className="mt-2 max-w-xl text-sm text-sand/70 sm:text-base">
                4 championship-grade pickleball courts in Santiago City, engineered for serious
                competition and built for the community.
              </p>
            </div>
            <div className="flex items-center gap-2 text-xs text-sand/60 font-mono shrink-0">
              <MapPin size={14} className="text-pickle" />
              <span>Santiago City, Isabela, PH</span>
            </div>
          </div>
        </div>

        {/* Facility Carousel */}
        <div className="mx-auto max-w-6xl px-4 sm:px-5">
          <FacilityCarousel />
        </div>

        {/* Amenity pills */}
        <div className="mx-auto max-w-6xl px-4 pt-8 pb-12 sm:px-5">
          <div className="flex flex-wrap gap-2.5 sm:gap-3 justify-center sm:justify-start">
            {[
              { icon: Clock, label: "Open 6AM – 10PM daily" },
              { icon: Users, label: "Spectator bleachers" },
              { icon: ShoppingBag, label: "Pro shop & equipment rental" },
              { icon: Droplets, label: "Hydration & refreshment bar" },
              { icon: MonitorPlay, label: "Live scoreboard displays" },
              { icon: Wifi, label: "Free facility Wi-Fi" },
            ].map(({ icon: Icon, label }) => (
              <div
                key={label}
                className="flex items-center gap-2 rounded-full border-2 border-border bg-charcoal px-3.5 py-2 text-[0.72rem] text-sand font-bold uppercase tracking-wide"
              >
                <Icon size={14} className="text-pickle" />
                {label}
              </div>
            ))}
          </div>
        </div>
      </section>

      {/* ── Tournaments Grid ── */}
      <section id="tournaments" className="mx-auto max-w-6xl px-4 py-12 sm:px-5 sm:py-16 scroll-mt-16 sm:scroll-mt-20">
        <div className="flex items-end justify-between border-b-2 border-charcoal pb-3">
          <h2 className="text-3xl sm:text-4xl">Tournaments</h2>
          <span className="text-sm uppercase tracking-widest text-muted-foreground">
            {displayTournaments.length} {displayTournaments.length === 1 ? "event" : "events"}
          </span>
        </div>

        {displayTournaments.length === 0 ? (
          <div className="surface-card my-8 p-10 sm:p-14 text-center border border-border">
            <span className="text-xs uppercase tracking-[0.28em] text-pickle font-bold">
              Upcoming Events
            </span>
            <h3 className="font-display text-3xl text-foreground mt-2">No Tournaments Scheduled</h3>
            <p className="mt-2 text-sm text-muted-foreground max-w-md mx-auto">
              There are currently no tournaments scheduled. Check back soon for announcements, or
              visit the tournament desk for upcoming schedules.
            </p>
          </div>
        ) : (
          <div className="mt-6 grid grid-cols-1 gap-4 sm:mt-8 sm:gap-5 md:grid-cols-2 lg:grid-cols-3 w-full">
            {displayTournaments.map((t) => {
              const statusInfo = getTournamentStatusDisplay(t.status);
              return (
                <button
                  key={t.slug}
                  type="button"
                  onClick={() => setSelectedTournament(t)}
                  className="surface-card group w-full p-5 sm:p-6 text-left transition-all hover:border-pickle hover:shadow-md rounded-2xl border-2 border-border cursor-pointer flex flex-col justify-between min-h-[10rem] sm:min-h-[11rem]"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span
                        className={`inline-flex items-center gap-1.5 px-3 py-1 text-xs font-bold uppercase tracking-wider rounded-full border ${statusInfo.style}`}
                      >
                        {statusInfo.dot && (
                          <span className="h-2 w-2 rounded-full bg-sand animate-pulse" />
                        )}
                        <span>{statusInfo.label}</span>
                      </span>
                      <span className="text-xs font-mono font-bold uppercase tracking-wider text-pickle sm:opacity-0 group-hover:opacity-100 transition-opacity">
                        Pick Category &rsaquo;
                      </span>
                    </div>

                    <h3 className="mt-3 font-display text-2xl sm:text-3xl text-foreground leading-tight group-hover:text-pickle transition-colors">
                      {t.name}
                    </h3>
                  </div>

                  <div className="mt-4 pt-3 border-t border-border flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 text-sm sm:text-base text-foreground/75 font-sans">
                    <div className="font-semibold text-foreground">
                      {t.date}
                    </div>
                    <div className="text-xs sm:text-sm text-foreground/60 truncate">
                      {t.venue}, {t.city}
                    </div>
                  </div>
                </button>
              );
            })}
          </div>
        )}
      </section>

      {/* ── Official Category Qualifications Carousel ── */}
      <QualificationsCarousel />



      {/* ── FAQ ── */}
      <section id="faq" className="mx-auto max-w-3xl px-4 py-14 sm:px-5 sm:py-16 scroll-mt-16 sm:scroll-mt-20">
        <div className="text-center mb-10">
          <span className="inline-block border border-pickle px-3 py-1 text-xs font-bold uppercase tracking-[0.28em] text-pickle">
            Got Questions?
          </span>
          <h2 className="mt-3 font-display text-4xl text-foreground sm:text-5xl">
            Frequently Asked
          </h2>
        </div>

        <div className="space-y-2">
          {FAQS.map((faq, idx) => {
            const isOpen = openFaq === idx;
            return (
              <div
                key={idx}
                className={`border-2 rounded-xl overflow-hidden transition-all ${isOpen
                    ? "border-pickle bg-card shadow-sm"
                    : "border-border bg-card hover:border-pickle/50"
                  }`}
              >
                <button
                  id={`faq-${idx}`}
                  onClick={() => setOpenFaq(isOpen ? null : idx)}
                  aria-expanded={isOpen}
                  className="w-full flex items-center justify-between gap-4 px-5 py-4 text-left cursor-pointer"
                >
                  <span className="text-sm font-bold text-foreground leading-snug">
                    {faq.q}
                  </span>
                  {isOpen ? (
                    <ChevronUp size={18} className="text-pickle flex-shrink-0" />
                  ) : (
                    <ChevronDown size={18} className="text-foreground/70 flex-shrink-0" />
                  )}
                </button>
                {isOpen && (
                  <div className="px-5 pb-5">
                    <p className="text-sm text-foreground/80 leading-relaxed">{faq.a}</p>
                  </div>
                )}
              </div>
            );
          })}
        </div>
      </section>

      {/* Step 2 – Categories bottom sheet */}
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
