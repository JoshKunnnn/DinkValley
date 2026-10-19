import { dbCheckAccessCode, dbCreateAccessCode, dbRevokeAccessCode } from "./supabase-service";

export type AccessCode = {
  id: string;
  code: string;
  role: "admin" | "umpire";
  createdAt: string;
  createdBy: string;
  isUsed: boolean;
  usedBy?: string | undefined;
};

const DEFAULT_CODES: AccessCode[] = [
  {
    id: "ac-1",
    code: "UMP-2026",
    role: "umpire",
    createdAt: "2026-01-01",
    createdBy: "System Admin",
    isUsed: false,
  },
  {
    id: "ac-2",
    code: "DV-ADMIN",
    role: "admin",
    createdAt: "2026-01-01",
    createdBy: "System Admin",
    isUsed: false,
  },
  {
    id: "ac-3",
    code: "DV-ADMIN-2026",
    role: "admin",
    createdAt: "2026-01-01",
    createdBy: "System Admin",
    isUsed: false,
  },
  {
    id: "ac-4",
    code: "DV-UMPIRE-2026",
    role: "umpire",
    createdAt: "2026-01-01",
    createdBy: "System Admin",
    isUsed: false,
  },
];

export function getAccessCodes(): AccessCode[] {
  try {
    const raw = localStorage.getItem("dv_access_codes");
    if (!raw) {
      localStorage.setItem("dv_access_codes", JSON.stringify(DEFAULT_CODES));
      return DEFAULT_CODES;
    }
    const parsed = JSON.parse(raw) as AccessCode[];
    // Ensure default codes are included if storage was initialized with an older subset
    const existingCodes = new Set(parsed.map((c) => c.code.toUpperCase()));
    let updated = false;
    for (const d of DEFAULT_CODES) {
      if (!existingCodes.has(d.code.toUpperCase())) {
        parsed.push(d);
        updated = true;
      }
    }
    if (updated) {
      localStorage.setItem("dv_access_codes", JSON.stringify(parsed));
    }
    return parsed;
  } catch {
    return DEFAULT_CODES;
  }
}

export function saveAccessCodes(codes: AccessCode[]) {
  try {
    localStorage.setItem("dv_access_codes", JSON.stringify(codes));
  } catch {
    // ignore
  }
}

export function detectRoleFromCode(codeStr: string): "admin" | "umpire" | null {
  const clean = codeStr.trim().toUpperCase();
  if (!clean) return null;

  // 1. Check in configured codes
  const codes = getAccessCodes();
  const match = codes.find((c) => c.code.toUpperCase() === clean);
  if (match) return match.role;

  // 2. Pattern matching for standard Dink Valley prefixes and conventions
  if (clean.startsWith("ADM-") || clean.includes("ADMIN") || clean.includes("DIRECTOR")) {
    return "admin";
  }
  if (clean.startsWith("UMP-") || clean.includes("UMPIRE") || clean.includes("OFFICIAL")) {
    return "umpire";
  }

  return null;
}

export function generateNewCode(role: "admin" | "umpire", customCode?: string, createdBy: string = "Admin"): AccessCode {
  const codes = getAccessCodes();
  const randomSuffix = Math.floor(1000 + Math.random() * 9000).toString();
  const finalCode = (customCode?.trim() || `${role === "admin" ? "ADM" : "UMP"}-${randomSuffix}`).toUpperCase();

  const newCode: AccessCode = {
    id: `ac-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
    code: finalCode,
    role,
    createdAt: new Date().toISOString().split("T")[0]!,
    createdBy,
    isUsed: false,
  };

  // Add to local state first
  codes.unshift(newCode);
  saveAccessCodes(codes);

  // Sync to Supabase server in background
  dbCreateAccessCode(finalCode, role, createdBy).catch((err) => {
    console.warn("[AccessCodes] Failed to sync new code to Supabase:", err);
  });

  return newCode;
}

export function revokeCode(id: string): AccessCode[] {
  const codes = getAccessCodes().filter((c) => c.id !== id);
  saveAccessCodes(codes);

  // Sync revocation to Supabase server in background
  dbRevokeAccessCode(id).catch((err) => {
    console.warn("[AccessCodes] Failed to revoke code from Supabase:", err);
  });

  return codes;
}

export async function validateAndUseCodeAsync(
  codeStr: string,
  role?: "admin" | "umpire",
  userEmail?: string
): Promise<{ valid: boolean; role: "admin" | "umpire"; error?: string }> {
  const cleanCode = codeStr.trim().toUpperCase();
  if (!cleanCode) {
    return { valid: false, role: role || "umpire", error: "Access code is required to register." };
  }

  // 1. Try server-side validation via secure Supabase RPC
  try {
    const serverRole = await dbCheckAccessCode(cleanCode);
    if (serverRole) {
      if (role && serverRole !== role) {
        return {
          valid: false,
          role: serverRole,
          error: `This access code is designated for ${serverRole.toUpperCase()} accounts, not ${role.toUpperCase()}.`,
        };
      }
      return { valid: true, role: serverRole };
    }
  } catch {
    // fallback to local verification
  }

  // 2. Local verification fallback
  const localRes = validateAndUseCode(cleanCode, role, userEmail || "user@dinkvalley.com");
  return {
    valid: localRes.valid,
    role: localRes.role || role || "umpire",
    ...(localRes.error ? { error: localRes.error } : {}),
  };
}

export function validateAndUseCode(
  codeStr: string,
  role?: "admin" | "umpire",
  userEmail?: string
): { valid: boolean; role?: "admin" | "umpire"; error?: string } {
  const cleanCode = codeStr.trim().toUpperCase();
  if (!cleanCode) {
    return { valid: false, error: "Access code is required to register." };
  }

  const codes = getAccessCodes();
  const match = codes.find((c) => c.code.toUpperCase() === cleanCode);

  if (match) {
    const effectiveRole = match.role;
    if (role && effectiveRole !== role) {
      return {
        valid: false,
        role: effectiveRole,
        error: `This access code is assigned for ${effectiveRole.toUpperCase()} accounts, not ${role.toUpperCase()}.`,
      };
    }

    if (match.isUsed) {
      return {
        valid: false,
        role: effectiveRole,
        error: `This access code was already used by ${match.usedBy ?? "another account"}.`,
      };
    }

    // Mark as used locally
    match.isUsed = true;
    if (userEmail) match.usedBy = userEmail;
    saveAccessCodes(codes);

    return { valid: true, role: effectiveRole };
  }

  // If code was not found locally, check if it matches standard generated Dink Valley formats
  // (e.g. ADM-1234 or UMP-1234 generated on another device or private session)
  const isAdmPattern = /^ADM-[0-9A-Z]{4,}$/i.test(cleanCode) || cleanCode.includes("ADMIN");
  const isUmpPattern = /^UMP-[0-9A-Z]{4,}$/i.test(cleanCode) || cleanCode.includes("UMPIRE");

  if (isAdmPattern || isUmpPattern) {
    const patternRole: "admin" | "umpire" = isAdmPattern ? "admin" : "umpire";
    if (role && patternRole !== role) {
      return {
        valid: false,
        role: patternRole,
        error: `This access code is assigned for ${patternRole.toUpperCase()} accounts, not ${role.toUpperCase()}.`,
      };
    }

    // Register into local list as used
    const generated: AccessCode = {
      id: `ac-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
      code: cleanCode,
      role: patternRole,
      createdAt: new Date().toISOString().split("T")[0]!,
      createdBy: "Administrator",
      isUsed: true,
      usedBy: userEmail,
    };
    codes.unshift(generated);
    saveAccessCodes(codes);

    return { valid: true, role: patternRole };
  }

  return { valid: false, error: "Invalid access code. Please request an official authorization code from the tournament director." };
}
