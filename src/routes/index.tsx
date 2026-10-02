import { createFileRoute, Link } from "@tanstack/react-router";
import { useState, useEffect } from "react";
import { useTournamentStore } from "@/lib/tournament-store";
import { dbGetTournaments } from "@/lib/supabase-service";
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

const statusStyles: Record<string, string> = {
  Live: "bg-primary text-primary-foreground",
  "Registration open": "bg-accent text-accent-foreground",
  Completed: "bg-muted text-muted-foreground",
};

/* ── Classification data ── */
const CLASSIFICATIONS = [
  {
    key: "beginner",
    label: "Beginner",
    borderColor: "border-l-[#6bbb6b]",
    textColor: "text-[#6bbb6b]",
    badgeBorder: "border-[#6bbb6b]",
    badgeBg: "bg-[#6bbb6b]/10",
    dot: "bg-[#6bbb6b]",
    rating: "DUPR 1.0 – 2.5",
    criteria: [
      "Has just started playing pickleball (less than 6 months).",
      "Still learning dinking, serving, and basic rally consistency.",
      "Has little to no competitive match experience.",
      "Relies on power over placement with inconsistent shots.",
    ],
    tip: "This is your welcome level. Come learn, enjoy, and grow your game.",
  },
  {
    key: "novice",
    label: "Novice",
    borderColor: "border-l-[#7ecb7e]",
    textColor: "text-[#7ecb7e]",
    badgeBorder: "border-[#7ecb7e]",
    badgeBg: "bg-[#7ecb7e]/10",
    dot: "bg-[#7ecb7e]",
    rating: "DUPR 2.5 – 3.5",
    criteria: [
      "Can maintain a rally with moderate consistency.",
      "Understands basic pickleball rules, scoring, and court zones.",
      "Can serve with some accuracy and return with control.",
      "Aware of the non-volley zone (kitchen) rules and dink shots.",
    ],
    tip: "You are past the learning curve and developing a real game.",
  },
  {
    key: "intermediate",
    label: "Intermediate",
    borderColor: "border-l-pickle",
    textColor: "text-pickle",
    badgeBorder: "border-pickle",
    badgeBg: "bg-pickle/10",
    dot: "bg-pickle",
    rating: "DUPR 3.5 – 4.5",
    criteria: [
      "Demonstrates consistent third-shot drops and transition play.",
      "Applies strategic positioning, stacking, and court awareness.",
      "Capable of sustained dink exchanges and net play.",
      "Has participated in local or club-level competitive play.",
    ],
    tip: "You are a well-rounded player with tactical awareness.",
  },
  {
    key: "advance",
    label: "Advance",
    borderColor: "border-l-sand",
    textColor: "text-sand",
    badgeBorder: "border-sand",
    badgeBg: "bg-sand/10",
    dot: "bg-sand",
    rating: "DUPR 4.5 – 5.5+",
    criteria: [
      "Executes high-level shot selection and spin variations.",
      "Dominates the NVZ line and controls pace of play.",
      "Competes regularly at regional or national-level events.",
      "Reads opponent patterns and adjusts strategy mid-match.",
    ],
    tip: "Elite competitive play at the highest club and regional tiers.",
  },
  {
    key: "40plus",
    label: "40+",
    borderColor: "border-l-brick",
    textColor: "text-brick",
    badgeBorder: "border-brick",
    badgeBg: "bg-brick/10",
    dot: "bg-brick",
    rating: "Age 40 and above",
    criteria: [
      "Open to all skill levels — experience is not the qualifier.",
      "Participants must be 40 years of age or older at time of event.",
      "Valid government ID verifying age required at registration.",
      "Play style and category pairing adjusted for age bracket.",
    ],
    tip: "Celebrate experience on the court. Every decade counts.",
  },
  {
    key: "50plus",
    label: "50+",
    borderColor: "border-l-[#c97a3c]",
    textColor: "text-[#c97a3c]",
    badgeBorder: "border-[#c97a3c]",
    badgeBg: "bg-[#c97a3c]/10",
    dot: "bg-[#c97a3c]",
    rating: "Age 50 and above",
    criteria: [
      "Open to all skill levels — experience is not the qualifier.",
      "Participants must be 50 years of age or older at time of event.",
      "Valid government ID verifying age required at registration.",
      "Matches are structured for comfort, sport, and camaraderie.",
    ],
    tip: "The best competitors get better with age. This is your court.",
  },
];

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
          <div className="mt-6 grid gap-4 sm:mt-8 sm:gap-5 md:grid-cols-2 lg:grid-cols-3">
            {displayTournaments.map((t) => (
              <Link
                key={t.slug}
                to="/tournaments/$slug"
                params={{ slug: t.slug }}
                className="surface-card group flex flex-col p-5 transition-transform hover:-translate-y-1 sm:p-6"
              >
                <span
                  className={`self-start px-2 py-1 text-[0.65rem] font-bold uppercase tracking-widest ${statusStyles[t.status]}`}
                >
                  {t.status}
                </span>
                <h3 className="mt-3 text-2xl leading-tight group-hover:text-primary sm:mt-4 sm:text-3xl">
                  {t.name}
                </h3>
                <p className="mt-2 flex-1 text-sm text-muted-foreground">{t.tagline}</p>
                <dl className="mt-4 space-y-1 border-t border-border pt-3 text-sm sm:mt-5 sm:pt-4">
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Dates</dt>
                    <dd className="font-semibold text-right">{t.date}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Categories</dt>
                    <dd className="font-semibold">{t.categories?.length || 0}</dd>
                  </div>
                  <div className="flex justify-between gap-2">
                    <dt className="text-muted-foreground">Teams</dt>
                    <dd className="font-semibold">{t.teamsCount || 0}</dd>
                  </div>
                </dl>
              </Link>
            ))}
          </div>
        )}
      </section>

      {/* ── Player Classification Guidelines ── */}
      <section id="guidelines" className="relative bg-charcoal overflow-hidden scroll-mt-16 sm:scroll-mt-20">
        <div className="absolute inset-0 court-lines opacity-20 pointer-events-none" />

        <div className="relative mx-auto max-w-6xl px-4 py-14 sm:px-5 sm:py-16">
          <div className="text-center mb-10 sm:mb-14">
            <span className="inline-block border border-pickle px-3 py-1 text-xs font-bold uppercase tracking-[0.28em] text-pickle">
              Know Your Level
            </span>
            <h2 className="mt-3 font-display text-4xl text-sand sm:text-5xl lg:text-6xl">
              Player Classifications
            </h2>
            <p className="mt-3 max-w-2xl mx-auto text-sm text-sand/70 sm:text-base">
              Choose the right category when you register. Classifications are based on skill, DUPR
              rating, and age bracket. Our committee reserves the right to adjust placement.
            </p>
          </div>

          <div className="grid gap-5 sm:grid-cols-2 lg:grid-cols-3">
            {CLASSIFICATIONS.map((cls) => (
              <div
                key={cls.key}
                className={`relative rounded-xl border-l-4 ${cls.borderColor} border-t border-r border-b border-border bg-charcoal/60 p-5 flex flex-col gap-3 transition-all hover:bg-charcoal/80`}
              >
                <div className="flex items-start justify-between gap-2">
                  <h3 className={`font-display text-3xl sm:text-4xl ${cls.textColor}`}>
                    {cls.label}
                  </h3>
                  <span
                    className={`text-[0.65rem] font-bold font-mono uppercase tracking-wider px-2 py-1 rounded border ${cls.badgeBorder} ${cls.badgeBg} ${cls.textColor} whitespace-nowrap`}
                  >
                    {cls.rating}
                  </span>
                </div>

                <ul className="space-y-1.5 text-xs text-sand/80 leading-relaxed">
                  {cls.criteria.map((c, i) => (
                    <li key={i} className="flex items-start gap-2">
                      <span
                        className={`h-1.5 w-1.5 rounded-full ${cls.dot} flex-shrink-0 mt-1.5`}
                      />
                      {c}
                    </li>
                  ))}
                </ul>

                <div className="mt-auto pt-3 border-t border-border text-[0.72rem] italic text-sand/60">
                  &ldquo;{cls.tip}&rdquo;
                </div>
              </div>
            ))}
          </div>

          <p className="mt-8 text-center text-xs text-sand/50 max-w-2xl mx-auto">
            DUPR (Dynamic Universal Pickleball Rating) scores are self-reported or pulled from
            official match records. Players without a DUPR rating may self-classify, subject to
            tournament committee review.
          </p>
        </div>
      </section>

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
                className={`border-2 rounded-xl overflow-hidden transition-all ${
                  isOpen
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
    </div>
  );
}
