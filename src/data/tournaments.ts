import { getTournaments, getTournament as getStoreTournament } from "@/lib/tournament-store";

export type CategoryId = string;

export type Team = {
  id: string;
  name: string;
  players: string[];
  club?: string | undefined;
  paid?: boolean;
  paymentProofUrl?: string | undefined;
  paymentRef?: string | undefined;
  paymentStatus?: "Verified" | "Pending" | "Unpaid" | undefined;
};

export type PoolMatch = {
  id: string;
  pool: string;
  teamA: string;
  teamB: string;
  scoreA?: number | undefined;
  scoreB?: number | undefined;
  court?: string | undefined;
  time?: string | undefined;
};

export type Standing = {
  teamId: string;
  played: number;
  won: number;
  lost: number;
  pointDiff: number;
};

export type PlayoffMatch = {
  id: string;
  round: "Quarterfinal" | "Semifinal" | "Final" | "Bronze";
  teamA?: string | undefined;
  teamB?: string | undefined;
  scoreA?: number | undefined;
  scoreB?: number | undefined;
  winner?: string | undefined;
  court?: string | undefined;
};

export type Category = {
  id: CategoryId;
  label: string;
  level: "Beginners" | "Novice" | "Intermediate" | "Advance" | "Open";
  division: "Men's" | "Women's" | "Mixed" | "Open";
  fee?: string | undefined;
  teams: Team[];
  pendingTeams?: Team[] | undefined;
  pools: PoolMatch[];
  standings: Standing[];
  playoffs: PlayoffMatch[];
};

export type Tournament = {
  slug: string;
  name: string;
  tagline: string;
  status: "Registration open" | "Live" | "Completed";
  date: string;
  venue: string;
  city: string;
  entryFee?: string | undefined;
  format: string;
  teamsCount: number;
  categories: Category[];
  schedule: { time: string; title: string; detail: string }[];
  rules: string[];
};

export function createSampleReceiptSvg(teamName: string, refNo: string = "GC-98214309"): string {
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="520" viewBox="0 0 400 520" fill="none">
    <rect width="400" height="520" rx="16" fill="#1C2421"/>
    <rect x="20" y="20" width="360" height="480" rx="12" fill="#2A3531" stroke="#4A6B5D" stroke-width="2"/>
    <circle cx="200" cy="75" r="28" fill="#4A6B5D"/>
    <path d="M190 75L197 82L212 67" stroke="#F4F1EA" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"/>
    <text x="200" y="130" fill="#F4F1EA" font-family="sans-serif" font-size="20" font-weight="bold" text-anchor="middle">PAYMENT VERIFIED</text>
    <text x="200" y="152" fill="#A8C3B5" font-family="sans-serif" font-size="12" text-anchor="middle">GCash / Bank Transfer Proof</text>
    <line x1="40" y1="175" x2="360" y2="175" stroke="#4A6B5D" stroke-dasharray="4 4"/>
    <text x="50" y="210" fill="#A8C3B5" font-family="sans-serif" font-size="12">Recipient</text>
    <text x="350" y="210" fill="#F4F1EA" font-family="sans-serif" font-size="12" font-weight="bold" text-anchor="end">Dink Valley Sports Inc.</text>
    <text x="50" y="245" fill="#A8C3B5" font-family="sans-serif" font-size="12">Team Registered</text>
    <text x="350" y="245" fill="#F4F1EA" font-family="sans-serif" font-size="12" font-weight="bold" text-anchor="end">${teamName.replace(/&/g, "&amp;")}</text>
    <text x="50" y="280" fill="#A8C3B5" font-family="sans-serif" font-size="12">Amount Paid</text>
    <text x="350" y="280" fill="#4A6B5D" font-family="sans-serif" font-size="16" font-weight="bold" text-anchor="end">PHP 1,800.00</text>
    <text x="50" y="315" fill="#A8C3B5" font-family="sans-serif" font-size="12">Ref. Number</text>
    <text x="350" y="315" fill="#F4F1EA" font-family="monospace" font-size="13" font-weight="bold" text-anchor="end">${refNo}</text>
    <text x="50" y="350" fill="#A8C3B5" font-family="sans-serif" font-size="12">Status</text>
    <text x="350" y="350" fill="#4A6B5D" font-family="sans-serif" font-size="12" font-weight="bold" text-anchor="end">Completed &amp; Verified</text>
    <line x1="40" y1="380" x2="360" y2="380" stroke="#4A6B5D" stroke-dasharray="4 4"/>
    <rect x="50" y="405" width="300" height="40" rx="8" fill="#1C2421" stroke="#4A6B5D"/>
    <text x="200" y="430" fill="#A8C3B5" font-family="sans-serif" font-size="11" text-anchor="middle">Official Dink Valley e-Receipt Attachment</text>
  </svg>`;
  return `data:image/svg+xml;utf8,${encodeURIComponent(svg)}`;
}

/**
 * Static placeholder array representing initial state (empty by default).
 * For reactive data, use useTournamentStore() or getTournaments().
 */
export const tournaments: Tournament[] = [];

/**
 * Retrieve a tournament by its unique slug from the store.
 */
export const getTournament = (slug: string): Tournament | undefined => {
  return getStoreTournament(slug);
};

export const teamName = (category: Category, id?: string): string => {
  return category.teams.find((t) => t.id === id)?.name ?? "TBD";
};
