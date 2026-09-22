import type { Team } from "@/data/tournaments";
import { createSampleReceiptSvg } from "@/data/tournaments";

export interface GenerateTeamsOptions {
  prefix?: string;
  verifiedOnly?: boolean;
}

const TEAM_NAMES = [
  "Kitchen Krushers",
  "Dink Dynasty",
  "Side-Out Snipers",
  "Volley Vipers",
  "Baseline Bandits",
  "Drop Shot Demons",
  "Apex Attackers",
  "Erne Elite",
  "Third Shot Kings",
  "Net Ninjas",
  "Lob Legends",
  "Paddle Prowlers",
  "Zero-Zero-Two",
  "Spin Wizards",
  "Court Commanders",
  "Smash Squad",
  "Rally Rebels",
  "Crosscourt Crushers",
  "Topspin Titans",
  "Santiago Strikers",
  "Valley Vanguards",
  "Pickle Pirates",
  "Drive Masters",
  "Backhand Bandits",
  "Kitchen Keepers",
  "The Dinking Dead",
  "Speedup Sultans",
  "Poach Patrol",
  "Fireballers",
  "Ace Alliance",
  "Sweet Spotters",
  "Golden Dinkers",
];

const PLAYER_PAIRS: [string, string][] = [
  ["Marcus Vance", "Elena Rostova"],
  ["Mateo Cruz", "Sophia Reyes"],
  ["Liam Gallagher", "Noah Chen"],
  ["Dante Silva", "Camila Santos"],
  ["Julian Alvarez", "Lucas Morales"],
  ["Alexander Wright", "Gabriel Ross"],
  ["Oliver Bennett", "Ethan Brooks"],
  ["Sebastian Perez", "Adrian Castillo"],
  ["Benjamin Cole", "Daniel Hayes"],
  ["Samuel Ortiz", "Leo Delgado"],
  ["Rafael Mendoza", "Diego Navarro"],
  ["Christian Miller", "Anthony Baker"],
  ["Isaac Guzman", "Dominic Flores"],
  ["Joshua Kim", "Hannah Choi"],
  ["Zachary Taylor", "Owen Murphy"],
  ["Nathaniel Drake", "Victor Sullivan"],
  ["Carlos Gomez", "Andres Moreno"],
  ["Vincent Vega", "Jules Winnfield"],
  ["Connor MacLeod", "Duncan Rhodes"],
  ["Javier Ramos", "Emilio Estrada"],
  ["Wesley Snipes", "Woody Harrelson"],
  ["Mason Cooper", "Wyatt Foster"],
  ["Tyler Durden", "Robert Paulson"],
  ["Damian Wayne", "Richard Grayson"],
  ["Lorenzo Medici", "Giovanni Rossi"],
  ["Tobias Eaton", "Caleb Prior"],
  ["Felix Vance", "Simon Ortiz"],
  ["Arthur Morgan", "John Marston"],
  ["Gavin Ramirez", "Tristan Ward"],
  ["Xavier Mercer", "Quinn Sterling"],
  ["Kai Tanaka", "Kenji Sato"],
  ["Cesar Romero", "Manuel Quezon"],
];

const CLUBS = [
  "Metro Dink Club",
  "Santiago Pickleball Club",
  "Valley Smashers",
  "Apex Paddle Academy",
  "Twin Rivers PC",
  "Cordillera Dinkers",
  "Highland Paddle Club",
  "Cagayan Valley PC",
  "Sierra Madre Picklers",
  "Northside Dinkers",
  "Pioneer Paddle Club",
  "Summit Pickleball Hub",
];

/**
 * Generate 32 realistic, verified pickleball doubles teams.
 * Guaranteed to have zero emojis and fully formatted payment receipts.
 */
export function generate32Teams(options: GenerateTeamsOptions = {}): Team[] {
  const { prefix = "team-32", verifiedOnly = true } = options;

  return TEAM_NAMES.slice(0, 32).map((name, index) => {
    const paddedIndex = String(index + 1).padStart(2, "0");
    const id =
      typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
        ? crypto.randomUUID()
        : `${prefix}-${paddedIndex}-${Date.now().toString(36).slice(-4)}`;
    const [p1, p2] = PLAYER_PAIRS[index] || [`Player ${index * 2 + 1}`, `Player ${index * 2 + 2}`];
    const club = CLUBS[index % CLUBS.length];
    const isPaid = verifiedOnly ? true : index < 28; // 28 paid, 4 pending if not verifiedOnly
    const refNumber = `GC-${98200000 + index * 317 + 104}`;

    return {
      id,
      name,
      players: [p1!, p2!],
      club,
      paid: isPaid,
      paymentRef: refNumber,
      paymentStatus: isPaid ? "Verified" : "Pending",
      paymentProofUrl: isPaid ? createSampleReceiptSvg(name, refNumber) : undefined,
    };
  });
}
