import type { Tournament, Category, Team } from "@/data/tournaments";
import * as XLSX from "xlsx";

export type CsvExportFilter = "all" | "verified-only" | "pending-only";

export const CSV_HEADERS = [
  "Category",
  "Skill Level",
  "Division",
  "Status",
  "Team Name",
  "Player 1",
  "Player 2",
  "Club / Academy",
  "Payment Reference",
  "Receipt Attached",
  "Entry Fee",
  "Tournament",
  "Team ID",
];

/**
 * Escapes a single CSV cell value according to RFC 4180:
 * - Wrap with double quotes
 * - Double any inner double quotes
 */
export function escapeCsvCell(val: unknown): string {
  if (val === null || val === undefined) return '""';
  const str = String(val).trim();
  return `"${str.replace(/"/g, '""')}"`;
}

/**
 * Converts headers and row matrix into an RFC 4180 CSV string.
 */
export function buildCsvString(headers: string[], rows: (string | number)[][]): string {
  const headerLine = headers.map(escapeCsvCell).join(",");
  const dataLines = rows.map((row) => row.map(escapeCsvCell).join(","));
  return [headerLine, ...dataLines].join("\r\n");
}

/**
 * Triggers a direct browser download of the CSV string.
 * Prepends a UTF-8 BOM (\uFEFF) so Excel, Google Sheets, and other spreadsheet tools
 * correctly detect UTF-8 encoding and display special characters cleanly.
 */
export function triggerCsvDownload(filename: string, csvContent: string): void {
  if (typeof window === "undefined") return;

  const cleanFilename = filename.endsWith(".csv") ? filename : `${filename}.csv`;
  const blob = new Blob(["\uFEFF" + csvContent], {
    type: "text/csv;charset=utf-8;",
  });

  const url = URL.createObjectURL(blob);
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.setAttribute("download", cleanFilename);
  document.body.appendChild(anchor);
  anchor.click();
  document.body.removeChild(anchor);

  setTimeout(() => {
    URL.revokeObjectURL(url);
  }, 1000);
}

/**
 * Formats a single Team into CSV row columns.
 */
export function teamToCsvRow(
  tournament: Tournament,
  category: Category,
  team: Team,
  status: "Verified" | "Pending",
  proofUrl?: string
): (string | number)[] {
  const player1 = team.players?.[0] || "";
  const player2 = team.players?.[1] || "";
  const hasReceipt = Boolean(proofUrl || team.paymentProofUrl) ? "Yes" : "No";

  return [
    category.label,
    category.level,
    category.division,
    status,
    team.name,
    player1,
    player2,
    team.club || "N/A",
    team.paymentRef || "None",
    hasReceipt,
    category.fee || "Free",
    tournament.name,
    team.id,
  ];
}

/**
 * Collects rows for a single category, combining both confirmed/verified teams
 * and pending registrations awaiting review.
 */
export function getCategoryCsvRows(
  tournament: Tournament,
  category: Category,
  filter: CsvExportFilter = "all",
  paymentMap?: Record<string, boolean>,
  proofMap?: Record<string, string>
): (string | number)[][] {
  const rows: (string | number)[][] = [];

  const verifiedTeams = category.teams || [];
  const pendingQueue = category.pendingTeams || [];

  // Process category teams (verified roster)
  verifiedTeams.forEach((team) => {
    const isVerified = paymentMap?.[team.id] ?? (team.paid || team.paymentStatus === "Verified");
    const status: "Verified" | "Pending" = isVerified ? "Verified" : "Pending";

    if (filter === "verified-only" && status !== "Verified") return;
    if (filter === "pending-only" && status !== "Pending") return;

    rows.push(teamToCsvRow(tournament, category, team, status, proofMap?.[team.id]));
  });

  // Process pending registrations queue (awaiting admin admission)
  if (filter === "all" || filter === "pending-only") {
    pendingQueue.forEach((pt) => {
      rows.push(teamToCsvRow(tournament, category, pt, "Pending", proofMap?.[pt.id] || pt.paymentProofUrl));
    });
  }

  return rows;
}

/**
 * Export teams of a specific category to a CSV file.
 */
export function exportCategoryTeamsToCsv(
  tournament: Tournament,
  category: Category,
  filter: CsvExportFilter = "all",
  paymentMap?: Record<string, boolean>,
  proofMap?: Record<string, string>
): { count: number; filename: string } {
  const rows = getCategoryCsvRows(tournament, category, filter, paymentMap, proofMap);
  const csvContent = buildCsvString(CSV_HEADERS, rows);

  const dateStr = new Date().toISOString().split("T")[0];
  const filterSuffix = filter === "all" ? "" : `-${filter}`;
  const filename = `${tournament.slug}-${category.id}-teams${filterSuffix}-${dateStr}.csv`;

  triggerCsvDownload(filename, csvContent);
  return { count: rows.length, filename };
}

/**
 * Export all categories across an entire tournament into a single master CSV (flat table).
 */
export function exportTournamentTeamsToCsv(
  tournament: Tournament,
  filter: CsvExportFilter = "all",
  paymentMap?: Record<string, boolean>,
  proofMap?: Record<string, string>
): { count: number; filename: string } {
  const allRows: (string | number)[][] = [];

  (tournament.categories || []).forEach((cat) => {
    const catRows = getCategoryCsvRows(tournament, cat, filter, paymentMap, proofMap);
    allRows.push(...catRows);
  });

  const csvContent = buildCsvString(CSV_HEADERS, allRows);
  const dateStr = new Date().toISOString().split("T")[0];
  const filterSuffix = filter === "all" ? "" : `-${filter}`;
  const filename = `${tournament.slug}-all-categories-master${filterSuffix}-${dateStr}.csv`;

  triggerCsvDownload(filename, csvContent);
  return { count: allRows.length, filename };
}

/**
 * Export the whole tournament into a single Master CSV, clearly grouped per category
 * with section banners, subtotals, and category breakdown.
 */
export function exportTournamentGroupedPerCategoryCsv(
  tournament: Tournament,
  filter: CsvExportFilter = "all",
  paymentMap?: Record<string, boolean>,
  proofMap?: Record<string, string>,
  includeSectionDividers = true
): { count: number; filename: string; categoryCount: number } {
  const dataLines: string[] = [];
  const headerLine = CSV_HEADERS.map(escapeCsvCell).join(",");
  dataLines.push(headerLine);

  let totalTeamCount = 0;
  const categories = tournament.categories || [];

  categories.forEach((cat, index) => {
    const verifiedTeams = cat.teams || [];
    const pendingQueue = cat.pendingTeams || [];

    const verifiedCount = verifiedTeams.filter(
      (t) => paymentMap?.[t.id] ?? (t.paid || t.paymentStatus === "Verified")
    ).length;
    const pendingCount =
      pendingQueue.length +
      verifiedTeams.filter(
        (t) => !(paymentMap?.[t.id] ?? (t.paid || t.paymentStatus === "Verified"))
      ).length;
    const catTotal = verifiedTeams.length + pendingQueue.length;

    if (includeSectionDividers) {
      if (index > 0) {
        dataLines.push("");
      }
      // Section separator row identifying the category and counts
      const sectionBanner = `>>> DIVISION: ${cat.label.toUpperCase()} (${catTotal} Total: ${verifiedCount} Verified, ${pendingCount} Pending) <<<`;
      dataLines.push(escapeCsvCell(sectionBanner));
    }

    const catRows = getCategoryCsvRows(tournament, cat, filter, paymentMap, proofMap);
    totalTeamCount += catRows.length;

    catRows.forEach((row) => {
      dataLines.push(row.map(escapeCsvCell).join(","));
    });
  });

  const csvContent = dataLines.join("\r\n");
  const dateStr = new Date().toISOString().split("T")[0];
  const filterSuffix = filter === "all" ? "" : `-${filter}`;
  const filename = `${tournament.slug}-whole-tournament-per-category${filterSuffix}-${dateStr}.csv`;

  triggerCsvDownload(filename, csvContent);
  return { count: totalTeamCount, filename, categoryCount: categories.length };
}

/**
 * Batch export every category as an individual CSV file in one single action.
 */
export async function exportAllCategoriesSeparately(
  tournament: Tournament,
  filter: CsvExportFilter = "all",
  paymentMap?: Record<string, boolean>,
  proofMap?: Record<string, string>
): Promise<{ totalCategories: number; totalTeams: number }> {
  const categories = tournament.categories || [];
  let totalTeams = 0;

  for (let i = 0; i < categories.length; i++) {
    const cat = categories[i]!;
    const res = exportCategoryTeamsToCsv(tournament, cat, filter, paymentMap, proofMap);
    totalTeams += res.count;
    if (i < categories.length - 1) {
      await new Promise((r) => setTimeout(r, 250));
    }
  }

  return { totalCategories: categories.length, totalTeams };
}

/* ────────────────────────────────────────────────
   EXCEL WORKBOOK (.XLSX) WITH A TAB PER CATEGORY
──────────────────────────────────────────────── */

/**
 * Sanitizes a string for use as an Excel worksheet tab name.
 * Excel enforces:
 * - Max length of 31 characters
 * - Cannot contain characters: \ / ? * [ ] :
 * - Cannot be empty
 */
export function sanitizeSheetName(name: string, fallbackIndex = 1): string {
  const cleaned = name.replace(/[:\\/?*\[\]]/g, " ").trim();
  const truncated = cleaned.slice(0, 31).trim();
  return truncated || `Category ${fallbackIndex}`;
}

/**
 * Ensures unique sheet names in case two categories have similar names.
 */
export function getUniqueSheetName(usedNames: Set<string>, baseName: string, index: number): string {
  let name = sanitizeSheetName(baseName, index);
  if (!usedNames.has(name.toLowerCase())) {
    usedNames.add(name.toLowerCase());
    return name;
  }
  let counter = 2;
  while (usedNames.has(`${name.slice(0, 27)} (${counter})`.toLowerCase())) {
    counter++;
  }
  const uniqueName = `${name.slice(0, 27)} (${counter})`;
  usedNames.add(uniqueName.toLowerCase());
  return uniqueName;
}

/**
 * Export the whole tournament into a multi-tab Microsoft Excel (.xlsx) workbook,
 * with a dedicated sheet/tab for each category, plus a Tournament Overview sheet
 * and an All Teams Master sheet.
 */
export function exportTournamentToExcelWorkbook(
  tournament: Tournament,
  paymentMap?: Record<string, boolean>,
  proofMap?: Record<string, string>
): { filename: string; sheetCount: number; totalTeams: number } {
  const wb = XLSX.utils.book_new();
  const usedSheetNames = new Set<string>();
  const categories = tournament.categories || [];

  let grandTotalVerified = 0;
  let grandTotalPending = 0;
  let grandTotalTeams = 0;

  // ── SHEET 1: TOURNAMENT OVERVIEW & REGISTRATION COUNTS ──
  const overviewRows: (string | number)[][] = [
    ["DINK VALLEY PICKLEBALL CLUB"],
    ["TOURNAMENT MASTER REGISTRATION & ROSTER WORKBOOK"],
    [],
    ["Tournament Name:", tournament.name],
    ["Tournament Dates:", tournament.date || "TBD"],
    ["Venue / Location:", tournament.venue || tournament.city || "Santiago City"],
    ["Export Timestamp:", new Date().toLocaleString()],
    [],
    ["CATEGORY SUMMARY & REGISTRATION COUNTS"],
    ["#", "Division / Category", "Skill Level", "Division Type", "Verified Teams", "Pending Review", "Total Entries", "Category Fee"],
  ];

  categories.forEach((cat, idx) => {
    const verifiedTeams = cat.teams || [];
    const pendingQueue = cat.pendingTeams || [];

    const verifiedCount = verifiedTeams.filter(
      (t) => paymentMap?.[t.id] ?? (t.paid || t.paymentStatus === "Verified")
    ).length;
    const pendingCount =
      pendingQueue.length +
      verifiedTeams.filter(
        (t) => !(paymentMap?.[t.id] ?? (t.paid || t.paymentStatus === "Verified"))
      ).length;
    const catTotal = verifiedTeams.length + pendingQueue.length;

    grandTotalVerified += verifiedCount;
    grandTotalPending += pendingCount;
    grandTotalTeams += catTotal;

    overviewRows.push([
      idx + 1,
      cat.label,
      cat.level,
      cat.division,
      verifiedCount,
      pendingCount,
      catTotal,
      cat.fee || "Free",
    ]);
  });

  // Grand Total row
  overviewRows.push([]);
  overviewRows.push([
    "TOTAL",
    `All ${categories.length} Categories`,
    "—",
    "—",
    grandTotalVerified,
    grandTotalPending,
    grandTotalTeams,
    "—",
  ]);
  overviewRows.push([]);
  overviewRows.push(["Note: Click on each division tab at the bottom to view player rosters, clubs, and payment verification details."]);

  const wsOverview = XLSX.utils.aoa_to_sheet(overviewRows);
  wsOverview["!cols"] = [
    { wch: 6 },
    { wch: 32 },
    { wch: 16 },
    { wch: 16 },
    { wch: 16 },
    { wch: 16 },
    { wch: 16 },
    { wch: 20 },
  ];
  const overviewSheetName = getUniqueSheetName(usedSheetNames, "Tournament Overview", 0);
  XLSX.utils.book_append_sheet(wb, wsOverview, overviewSheetName);

  // ── SHEETS 2..N: DEDICATED WORKSHEET / TAB PER CATEGORY ──
  categories.forEach((cat, idx) => {
    const verifiedTeams = cat.teams || [];
    const pendingQueue = cat.pendingTeams || [];

    const verifiedCount = verifiedTeams.filter(
      (t) => paymentMap?.[t.id] ?? (t.paid || t.paymentStatus === "Verified")
    ).length;
    const pendingCount =
      pendingQueue.length +
      verifiedTeams.filter(
        (t) => !(paymentMap?.[t.id] ?? (t.paid || t.paymentStatus === "Verified"))
      ).length;
    const catTotal = verifiedTeams.length + pendingQueue.length;

    const catRows: (string | number)[][] = [
      [`${tournament.name} - ${cat.label}`],
      [`Skill Level: ${cat.level} | Division: ${cat.division} | Entry Fee: ${cat.fee || "Free"}`],
      [`Summary: ${verifiedCount} Verified Teams | ${pendingCount} Pending Verification | Total: ${catTotal} Teams`],
      [],
      [
        "#",
        "Status",
        "Team Name",
        "Player 1",
        "Player 2",
        "Club / Academy",
        "Payment Ref",
        "Receipt Attached",
        "Entry Fee",
        "Registration ID",
      ],
    ];

    let entryNum = 1;

    // Verified roster entries
    verifiedTeams.forEach((team) => {
      const isVerified = paymentMap?.[team.id] ?? (team.paid || team.paymentStatus === "Verified");
      const status = isVerified ? "Verified" : "Pending";
      const hasReceipt = Boolean(proofMap?.[team.id] || team.paymentProofUrl) ? "Yes" : "No";

      catRows.push([
        entryNum++,
        status,
        team.name,
        team.players?.[0] || "",
        team.players?.[1] || "",
        team.club || "N/A",
        team.paymentRef || "None",
        hasReceipt,
        cat.fee || "Free",
        team.id,
      ]);
    });

    // Pending registrations queue awaiting verification
    pendingQueue.forEach((pt) => {
      const hasReceipt = Boolean(proofMap?.[pt.id] || pt.paymentProofUrl) ? "Yes" : "No";

      catRows.push([
        entryNum++,
        "Pending",
        pt.name,
        pt.players?.[0] || "",
        pt.players?.[1] || "",
        pt.club || "N/A",
        pt.paymentRef || "None",
        hasReceipt,
        cat.fee || "Free",
        pt.id,
      ]);
    });

    if (catTotal === 0) {
      catRows.push(["—", "No teams registered yet in this category."]);
    }

    const wsCat = XLSX.utils.aoa_to_sheet(catRows);
    wsCat["!cols"] = [
      { wch: 5 },
      { wch: 14 },
      { wch: 28 },
      { wch: 22 },
      { wch: 22 },
      { wch: 24 },
      { wch: 18 },
      { wch: 16 },
      { wch: 18 },
      { wch: 20 },
    ];

    const catSheetName = getUniqueSheetName(usedSheetNames, cat.label, idx + 1);
    XLSX.utils.book_append_sheet(wb, wsCat, catSheetName);
  });

  // ── FINAL SHEET: MASTER CONTINUOUS ALL-TEAMS TAB ──
  const allMasterRows: (string | number)[][] = [
    ["MASTER TOURNAMENT ROSTER (ALL DIVISIONS CONTINUOUS)"],
    [],
    [
      "#",
      "Category / Division",
      "Status",
      "Team Name",
      "Player 1",
      "Player 2",
      "Club / Academy",
      "Payment Ref",
      "Receipt Attached",
      "Entry Fee",
      "Tournament",
      "Team ID",
    ],
  ];

  let masterCounter = 1;
  categories.forEach((cat) => {
    const verifiedTeams = cat.teams || [];
    const pendingQueue = cat.pendingTeams || [];

    verifiedTeams.forEach((team) => {
      const isVerified = paymentMap?.[team.id] ?? (team.paid || team.paymentStatus === "Verified");
      const status = isVerified ? "Verified" : "Pending";
      const hasReceipt = Boolean(proofMap?.[team.id] || team.paymentProofUrl) ? "Yes" : "No";

      allMasterRows.push([
        masterCounter++,
        cat.label,
        status,
        team.name,
        team.players?.[0] || "",
        team.players?.[1] || "",
        team.club || "N/A",
        team.paymentRef || "None",
        hasReceipt,
        cat.fee || "Free",
        tournament.name,
        team.id,
      ]);
    });

    pendingQueue.forEach((pt) => {
      const hasReceipt = Boolean(proofMap?.[pt.id] || pt.paymentProofUrl) ? "Yes" : "No";

      allMasterRows.push([
        masterCounter++,
        cat.label,
        "Pending",
        pt.name,
        pt.players?.[0] || "",
        pt.players?.[1] || "",
        pt.club || "N/A",
        pt.paymentRef || "None",
        hasReceipt,
        cat.fee || "Free",
        tournament.name,
        pt.id,
      ]);
    });
  });

  const wsMaster = XLSX.utils.aoa_to_sheet(allMasterRows);
  wsMaster["!cols"] = [
    { wch: 5 },
    { wch: 28 },
    { wch: 14 },
    { wch: 26 },
    { wch: 20 },
    { wch: 20 },
    { wch: 22 },
    { wch: 18 },
    { wch: 16 },
    { wch: 18 },
    { wch: 26 },
    { wch: 20 },
  ];
  const allTeamsSheetName = getUniqueSheetName(usedSheetNames, "All Teams Master", 999);
  XLSX.utils.book_append_sheet(wb, wsMaster, allTeamsSheetName);

  // Trigger browser download of .xlsx file
  const dateStr = new Date().toISOString().split("T")[0];
  const filename = `${tournament.slug}-tournament-workbook-${dateStr}.xlsx`;

  if (typeof window !== "undefined") {
    const wbout = XLSX.write(wb, { bookType: "xlsx", type: "array" });
    const blob = new Blob([wbout], {
      type: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.setAttribute("download", filename);
    document.body.appendChild(anchor);
    anchor.click();
    document.body.removeChild(anchor);

    setTimeout(() => {
      URL.revokeObjectURL(url);
    }, 1000);
  }

  return {
    filename,
    sheetCount: wb.SheetNames.length,
    totalTeams: grandTotalTeams,
  };
}
