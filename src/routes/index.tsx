import { createFileRoute, Link } from "@tanstack/react-router";
import { useTournamentStore } from "@/lib/tournament-store";
import { dbGetTournaments } from "@/lib/supabase-service";

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

function Index() {
  const loaderTournaments = Route.useLoaderData();
  const { tournaments } = useTournamentStore();
  const displayTournaments = tournaments.length > 0 ? tournaments : loaderTournaments;

  return (
    <div>
      {/* ── Hero Section ── */}
      <section className="court-lines relative overflow-hidden">
        <div className="mx-auto grid max-w-6xl items-center gap-8 px-4 py-12 sm:px-5 sm:py-16 md:grid-cols-[1.4fr_1fr] md:py-20 lg:gap-10">
          <div>
            <span className="inline-block border border-pickle px-3 py-1 text-xs font-bold uppercase tracking-[0.28em] text-pickle">
              Season 2026
            </span>
            {/* Responsive hero heading — scales from 4xl on mobile to 8xl on desktop */}
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

          {/* Logo image — centered on mobile, full-width on desktop */}
          <div className="flex justify-center md:block">
            <img
              src="/DinkValley.jpg"
              alt="Dink Valley pickleball club crest"
              className="w-40 drop-shadow-2xl sm:w-52 md:w-full"
            />
          </div>
        </div>
      </section>

      {/* ── Tournaments Grid ── */}
      <section id="tournaments" className="mx-auto max-w-6xl px-4 py-12 sm:px-5 sm:py-16">
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
              There are currently no tournaments scheduled. Check back soon for announcements, or visit the tournament desk for upcoming schedules.
            </p>

          </div>
        ) : (
          /* Responsive grid: 1 col mobile → 2 col sm → 3 col lg */
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
    </div>
  );
}
