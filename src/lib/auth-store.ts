import { getAccessCodes, saveAccessCodes, validateAndUseCode } from "./access-codes";

export type StaffRole = "admin" | "umpire";

export type StaffUser = {
  name: string;
  email: string;
  password: string;
  role: StaffRole;
  accessCode?: string | undefined;
  certifiedAt?: string | undefined;
};

const USERS_STORAGE_KEY = "dv_user_accounts";

const DEFAULT_STAFF_ACCOUNTS: StaffUser[] = [
  {
    name: "Tournament Director",
    email: "admin@dinkvalley.com",
    password: "admin123",
    role: "admin",
    accessCode: "DV-ADMIN",
    certifiedAt: "2026-01-01",
  },
  {
    name: "Match Official",
    email: "umpire@dinkvalley.com",
    password: "umpire123",
    role: "umpire",
    accessCode: "UMP-2026",
    certifiedAt: "2026-01-15",
  },
];

export function getStaffUsers(): StaffUser[] {
  if (typeof window === "undefined") return DEFAULT_STAFF_ACCOUNTS;
  try {
    const raw = localStorage.getItem(USERS_STORAGE_KEY);
    if (!raw) {
      localStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(DEFAULT_STAFF_ACCOUNTS));
      return DEFAULT_STAFF_ACCOUNTS;
    }
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) {
      localStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(DEFAULT_STAFF_ACCOUNTS));
      return DEFAULT_STAFF_ACCOUNTS;
    }
    return parsed as StaffUser[];
  } catch {
    return DEFAULT_STAFF_ACCOUNTS;
  }
}

export function saveStaffUsers(users: StaffUser[]): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.setItem(USERS_STORAGE_KEY, JSON.stringify(users));
  } catch {
    // ignore
  }
}

export function getAuthenticatedStaff(): { role: StaffRole; name: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const isAdmin = localStorage.getItem("mock_auth") === "true";
    const isUmpire = localStorage.getItem("mock_umpire_auth") === "true";

    if (isAdmin) {
      return {
        role: "admin",
        name: localStorage.getItem("mock_admin_name") || "Tournament Director",
      };
    }
    if (isUmpire) {
      return {
        role: "umpire",
        name: localStorage.getItem("mock_umpire_name") || "Match Official",
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function setStaffSession(role: StaffRole, name: string): void {
  if (typeof window === "undefined") return;
  try {
    if (role === "admin") {
      localStorage.setItem("mock_auth", "true");
      localStorage.setItem("mock_admin_name", name);
      localStorage.removeItem("mock_umpire_auth");
      localStorage.removeItem("mock_umpire_name");
    } else {
      localStorage.setItem("mock_umpire_auth", "true");
      localStorage.setItem("mock_umpire_name", name);
      localStorage.removeItem("mock_auth");
      localStorage.removeItem("mock_admin_name");
    }
    window.dispatchEvent(new Event("dv_auth_changed"));
    window.dispatchEvent(new Event("storage"));
  } catch {
    // ignore
  }
}

export function logoutStaff(): void {
  if (typeof window === "undefined") return;
  try {
    localStorage.removeItem("mock_auth");
    localStorage.removeItem("mock_admin_name");
    localStorage.removeItem("mock_umpire_auth");
    localStorage.removeItem("mock_umpire_name");
    window.dispatchEvent(new Event("dv_auth_changed"));
    window.dispatchEvent(new Event("storage"));
  } catch {
    // ignore
  }
}

/**
 * Authenticate using an official access code (e.g. DV-ADMIN or UMP-2026).
 */
export function loginWithAccessCode(codeStr: string): {
  success: boolean;
  role?: StaffRole;
  name?: string;
  error?: string;
} {
  const clean = codeStr.trim().toUpperCase();
  if (!clean) {
    return { success: false, error: "Please enter an official access code." };
  }

  const codes = getAccessCodes();
  const match = codes.find((c) => c.code.toUpperCase() === clean);

  if (match) {
    const role: StaffRole = match.role;
    const defaultName = role === "admin" ? "Tournament Director" : "Match Official";
    setStaffSession(role, defaultName);
    return { success: true, role, name: defaultName };
  }

  // Check fallback known codes
  if (clean === "DV-ADMIN" || clean === "DV-ADMIN-2026") {
    setStaffSession("admin", "Tournament Director");
    return { success: true, role: "admin", name: "Tournament Director" };
  }
  if (clean === "UMP-2026" || clean === "UMP-CERT-88") {
    setStaffSession("umpire", "Match Official");
    return { success: true, role: "umpire", name: "Match Official" };
  }

  return {
    success: false,
    error: "Invalid access code. Please request an authorized access code from tournament management.",
  };
}

/**
 * Authenticate using email and password.
 */
export function loginWithCredentials(
  emailStr: string,
  passwordStr: string
): {
  success: boolean;
  role?: StaffRole;
  name?: string;
  error?: string;
} {
  const cleanEmail = emailStr.trim().toLowerCase();
  const cleanPassword = passwordStr.trim();

  if (!cleanEmail || !cleanPassword) {
    return { success: false, error: "Please enter both email and password." };
  }

  const users = getStaffUsers();
  let user = users.find(
    (u) => u.email.toLowerCase() === cleanEmail && u.password === cleanPassword
  );

  // Fallback credentials
  if (!user) {
    if (cleanEmail === "admin@dinkvalley.com" && cleanPassword === "admin123") {
      user = {
        name: "Tournament Director",
        email: cleanEmail,
        password: cleanPassword,
        role: "admin",
      };
    } else if (cleanEmail === "umpire@dinkvalley.com" && cleanPassword === "umpire123") {
      user = {
        name: "Match Official",
        email: cleanEmail,
        password: cleanPassword,
        role: "umpire",
      };
    }
  }

  if (!user) {
    return {
      success: false,
      error: "Invalid credentials. Please verify your email and password.",
    };
  }

  setStaffSession(user.role, user.name);
  return { success: true, role: user.role, name: user.name };
}

/**
 * Register a new official staff account using an official access code.
 */
export function registerStaffAccount(data: {
  name: string;
  email: string;
  password: string;
  role: StaffRole;
  accessCode: string;
}): { success: boolean; error?: string } {
  const cleanName = data.name.trim();
  const cleanEmail = data.email.trim().toLowerCase();
  const cleanPassword = data.password.trim();
  const cleanCode = data.accessCode.trim().toUpperCase();

  if (!cleanName) {
    return { success: false, error: "Full name is required." };
  }
  if (!cleanEmail || !cleanEmail.includes("@")) {
    return { success: false, error: "Valid email address is required." };
  }
  if (cleanPassword.length < 6) {
    return { success: false, error: "Password must be at least 6 characters." };
  }
  if (!cleanCode) {
    return { success: false, error: "Official access code is required to register." };
  }

  const users = getStaffUsers();
  if (users.some((u) => u.email.toLowerCase() === cleanEmail)) {
    return { success: false, error: "An account with this email address already exists." };
  }

  // Validate the code against role
  const validation = validateAndUseCode(cleanCode, data.role, cleanEmail);
  if (!validation.valid) {
    return { success: false, error: validation.error || "Invalid access code." };
  }

  const newUser: StaffUser = {
    name: cleanName,
    email: cleanEmail,
    password: cleanPassword,
    role: data.role,
    accessCode: cleanCode,
    certifiedAt: new Date().toISOString().split("T")[0],
  };

  users.push(newUser);
  saveStaffUsers(users);

  // Automatically authenticate new user
  setStaffSession(data.role, cleanName);

  return { success: true };
}
