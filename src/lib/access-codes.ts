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
  return newCode;
}

export function revokeCode(id: string): AccessCode[] {
  const codes = getAccessCodes().filter((c) => c.id !== id);
  saveAccessCodes(codes);
  return codes;
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
