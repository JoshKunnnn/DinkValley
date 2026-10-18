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
];

export function getAccessCodes(): AccessCode[] {
  try {
    const raw = localStorage.getItem("dv_access_codes");
    if (!raw) {
      localStorage.setItem("dv_access_codes", JSON.stringify(DEFAULT_CODES));
      return DEFAULT_CODES;
    }
    return JSON.parse(raw) as AccessCode[];
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
  role: "admin" | "umpire",
  userEmail: string
): Promise<{ valid: boolean; error?: string }> {
  const cleanCode = codeStr.trim().toUpperCase();
  if (!cleanCode) {
    return { valid: false, error: "Access code is required to register." };
  }

  // 1. Try server-side validation via secure Supabase RPC
  try {
    const serverRole = await dbCheckAccessCode(cleanCode);
    if (serverRole) {
      if (serverRole !== role) {
        return {
          valid: false,
          error: `This access code is assigned for ${serverRole.toUpperCase()} accounts, not ${role.toUpperCase()}.`,
        };
      }
      return { valid: true };
    }
  } catch {
    // fallback to local verification below
  }

  // 2. Local verification fallback
  return validateAndUseCode(cleanCode, role, userEmail);
}

export function validateAndUseCode(
  codeStr: string,
  role: "admin" | "umpire",
  userEmail: string
): { valid: boolean; error?: string } {
  const cleanCode = codeStr.trim().toUpperCase();
  if (!cleanCode) {
    return { valid: false, error: "Access code is required to register." };
  }

  const codes = getAccessCodes();
  const match = codes.find((c) => c.code.toUpperCase() === cleanCode);

  if (!match) {
    return { valid: false, error: "Invalid access code. Request an official access code from an admin." };
  }

  if (match.role !== role) {
    return {
      valid: false,
      error: `This access code is assigned for ${match.role.toUpperCase()} accounts, not ${role.toUpperCase()}.`,
    };
  }

  if (match.isUsed) {
    return {
      valid: false,
      error: `This access code was already used by ${match.usedBy ?? "another account"}.`,
    };
  }

  // Mark as used
  match.isUsed = true;
  match.usedBy = userEmail;
  saveAccessCodes(codes);

  return { valid: true };
}
