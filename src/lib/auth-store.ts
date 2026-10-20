import { supabase } from "@/integrations/supabase/client";
import { getAccessCodes, saveAccessCodes, validateAndUseCode, validateAndUseCodeAsync } from "./access-codes";
import {
  dbCheckAccessCode,
  dbSaveCloudStaffAccount,
  dbSyncCloudStaffAccounts,
  type CloudStaffUser,
} from "./supabase-service";

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

/**
 * Merge cloud accounts into local storage safely without duplicating emails.
 */
export function mergeAndSaveStaffUsers(cloudUsers: (StaffUser | CloudStaffUser)[]): StaffUser[] {
  const localUsers = getStaffUsers();
  const map = new Map<string, StaffUser>();
  localUsers.forEach((u) => map.set(u.email.toLowerCase(), u));
  cloudUsers.forEach((cu) => {
    const emailKey = cu.email.toLowerCase();
    const existing = map.get(emailKey);
    map.set(emailKey, {
      name: cu.name || existing?.name || "Official",
      email: emailKey,
      password: cu.password || existing?.password || "",
      role: cu.role,
      accessCode: cu.accessCode || existing?.accessCode,
      certifiedAt: cu.certifiedAt || existing?.certifiedAt,
    });
  });
  const merged = Array.from(map.values());
  saveStaffUsers(merged);
  return merged;
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

export async function logoutStaff(): Promise<void> {
  try {
    await supabase.auth.signOut();
  } catch {
    // ignore
  }
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
 * Access code direct login is disabled.
 * Access codes are only viewed in the admin console and redeemed during initial account registration.
 */
export async function loginWithAccessCode(_codeStr: string): Promise<{
  success: boolean;
  role?: StaffRole;
  name?: string;
  error?: string;
}> {
  return {
    success: false,
    error: "Direct access code login has been disabled for security. Please sign in with your email and password. Access codes are managed in the Admin Console and used for new official account registration.",
  };
}

/**
 * Authenticate using email and password via Supabase Auth with fallback.
 */
export async function loginWithCredentials(
  emailStr: string,
  passwordStr: string
): Promise<{
  success: boolean;
  role?: StaffRole;
  name?: string;
  error?: string;
}> {
  const cleanEmail = emailStr.trim().toLowerCase();
  const cleanPassword = passwordStr.trim();

  if (!cleanEmail || !cleanPassword) {
    return { success: false, error: "Please enter both email and password." };
  }

  // 1. Try Supabase Auth
  try {
    const { data: authData, error: authError } = await supabase.auth.signInWithPassword({
      email: cleanEmail,
      password: cleanPassword,
    });

    if (!authError && authData?.user) {
      // Query profile role
      const { data: profile } = await supabase
        .from("profiles")
        .select("role, name")
        .eq("id", authData.user.id)
        .maybeSingle();

      const role: StaffRole = profile?.role === "admin" ? "admin" : "umpire";
      const name = profile?.name || (role === "admin" ? "Tournament Director" : "Match Official");
      setStaffSession(role, name);
      return { success: true, role, name };
    }
  } catch {
    // continue to local credential store below
  }

  // 2. Check local accounts
  let users = getStaffUsers();
  let user = users.find(
    (u) => u.email.toLowerCase() === cleanEmail && u.password === cleanPassword
  );

  // 3. If not found locally, fetch latest accounts from Supabase cloud
  // (allows accounts created on mobile to authenticate on PC and vice versa)
  if (!user) {
    try {
      const cloudAccounts = await dbSyncCloudStaffAccounts(users);
      if (Array.isArray(cloudAccounts) && cloudAccounts.length > 0) {
        users = mergeAndSaveStaffUsers(cloudAccounts);
        user = users.find(
          (u) => u.email.toLowerCase() === cleanEmail && u.password === cleanPassword
        );
      }
    } catch (err) {
      console.warn("[Auth] Cloud staff account sync during login notice:", err);
    }
  }

  // 4. Fallback default system accounts
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
 * Creates real Supabase Auth user + profile via database trigger, with local fallback.
 */
export async function registerStaffAccount(data: {
  name: string;
  email: string;
  password: string;
  role?: StaffRole;
  accessCode: string;
}): Promise<{ success: boolean; role?: StaffRole; error?: string }> {
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

  // 1. Determine effective role and validate access code
  const validationRes = await validateAndUseCodeAsync(cleanCode, data.role, cleanEmail);
  if (!validationRes.valid) {
    return {
      success: false,
      error: validationRes.error || "Invalid access code. Please request an official code from an administrator.",
    };
  }

  const finalRole: StaffRole = validationRes.role || data.role || "umpire";

  // 2. Try Supabase Auth Sign Up
  try {
    const { data: authData, error: signUpError } = await supabase.auth.signUp({
      email: cleanEmail,
      password: cleanPassword,
      options: {
        data: {
          name: cleanName,
          access_code: cleanCode,
          role: finalRole,
        },
      },
    });

    if (signUpError) {
      if (signUpError.message.includes("User already registered") || signUpError.message.includes("already exists")) {
        return { success: false, error: "An account with this email address already exists. Please sign in." };
      }
      console.warn("[Auth] Supabase signup warning, registering certified session locally:", signUpError.message);
    } else if (authData?.user) {
      setStaffSession(finalRole, cleanName);
    }
  } catch (err: any) {
    console.warn("[Auth] Unexpected signup notice:", err);
  }

  // 3. Keep local accounts updated for offline resilience
  const users = getStaffUsers();
  const existingIdx = users.findIndex((u) => u.email.toLowerCase() === cleanEmail);
  const newUser: StaffUser = {
    name: cleanName,
    email: cleanEmail,
    password: cleanPassword,
    role: finalRole,
    accessCode: cleanCode,
    certifiedAt: new Date().toISOString().split("T")[0],
  };

  if (existingIdx >= 0) {
    users[existingIdx] = newUser;
  } else {
    users.push(newUser);
  }
  saveStaffUsers(users);

  // 4. Save to Supabase Cloud so the account is immediately active across all devices (Mobile <-> PC)
  try {
    await dbSaveCloudStaffAccount(newUser);
  } catch (err) {
    console.warn("[Auth] Failed to sync new staff account to cloud:", err);
  }

  setStaffSession(finalRole, cleanName);
  return { success: true, role: finalRole };
}

// Background auto-sync on initialization to ensure cross-device parity
if (typeof window !== "undefined") {
  setTimeout(async () => {
    try {
      const localUsers = getStaffUsers();
      const cloudUsers = await dbSyncCloudStaffAccounts(localUsers);
      if (Array.isArray(cloudUsers) && cloudUsers.length > 0) {
        mergeAndSaveStaffUsers(cloudUsers);
      }
    } catch {
      // background sync catch
    }
  }, 400);
}
