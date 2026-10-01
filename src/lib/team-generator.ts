import type { Team } from "@/data/tournaments";
import { createSampleReceiptSvg } from "@/data/tournaments";
import { generateUUID } from "@/lib/utils";

export interface GenerateTeamsOptions {
  prefix?: string;
  verifiedOnly?: boolean;
}

const TEAM_NAMES = [
  // 8 seeded entries for bracket distribution testing
  "Nanomoly",
  "Nanomoly",
  "Nanomoly",
  "Nanomoly",
  "Nanomoly",
  "Nanomoly",
  "Nanomoly",
  "Nanomoly",
  // Regular teams
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
];

const PLAYER_PAIRS: [string, string][] = [
  // Pairs for the 8 Nanomoly teams
  ["Carlo Nano", "Rico Moly"],
  ["Dante Nano", "Gio Moly"],
  ["Felix Nano", "Ivan Moly"],
  ["Hugo Nano", "Jace Moly"],
  ["Karl Nano", "Leo Moly"],
  ["Marco Nano", "Nico Moly"],
  ["Oscar Nano", "Pablo Moly"],
  ["Quinn Nano", "Ryan Moly"],
  // Regular pairs
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
    const id = generateUUID();
    const [p1, p2] = PLAYER_PAIRS[index] || [`Player ${index * 2 + 1}`, `Player ${index * 2 + 2}`];
    const club = CLUBS[index % CLUBS.length];
    const isPaid = verifiedOnly ? true : index < 28;
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
