import { supabase } from "@/integrations/supabase/client";
import { getAccessCodes, saveAccessCodes, validateAndUseCode, validateAndUseCodeAsync } from "./access-codes";
import {
  dbCheckAccessCode,
  dbSaveCloudStaffAccount,
  dbUpdateCloudStaffAccount,
  dbDeleteCloudStaffAccount,
  dbSyncCloudStaffAccounts,
  type CloudStaffUser,
} from "./supabase-service";

export type StaffRole = "admin" | "umpire";

export type StaffUser = {
  name: string;
  email: string;
  password?: string | undefined;
  role: StaffRole;
  accessCode?: string | undefined;
  certifiedAt?: string | undefined;
  status?: "active" | "deactivated" | undefined;
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
    status: "active",
  },
  {
    name: "Match Official",
    email: "umpire@dinkvalley.com",
    password: "umpire123",
    role: "umpire",
    accessCode: "UMP-2026",
    certifiedAt: "2026-01-15",
    status: "active",
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
    return parsed.map((u: any) => ({
      ...u,
      status: u.status || "active",
    })) as StaffUser[];
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
      status: cu.status || existing?.status || "active",
    });
  });
  const merged = Array.from(map.values());
  saveStaffUsers(merged);
  return merged;
}

export function getAuthenticatedStaff(): { role: StaffRole; name: string; email?: string } | null {
  if (typeof window === "undefined") return null;
  try {
    const isAdmin = localStorage.getItem("mock_auth") === "true";
    const isUmpire = localStorage.getItem("mock_umpire_auth") === "true";

    if (isAdmin) {
      return {
        role: "admin",
        name: localStorage.getItem("mock_admin_name") || "Tournament Director",
        email: localStorage.getItem("mock_admin_email") || "admin@dinkvalley.com",
      };
    }
    if (isUmpire) {
      return {
        role: "umpire",
        name: localStorage.getItem("mock_umpire_name") || "Match Official",
        email: localStorage.getItem("mock_umpire_email") || "umpire@dinkvalley.com",
      };
    }
    return null;
  } catch {
    return null;
  }
}

export function setStaffSession(role: StaffRole, name: string, email?: string): void {
  if (typeof window === "undefined") return;
  try {
    if (role === "admin") {
      localStorage.setItem("mock_auth", "true");
      localStorage.setItem("mock_admin_name", name);
      if (email) localStorage.setItem("mock_admin_email", email.toLowerCase());
      localStorage.removeItem("mock_umpire_auth");
      localStorage.removeItem("mock_umpire_name");
      localStorage.removeItem("mock_umpire_email");
    } else {
      localStorage.setItem("mock_umpire_auth", "true");
      localStorage.setItem("mock_umpire_name", name);
      if (email) localStorage.setItem("mock_umpire_email", email.toLowerCase());
      localStorage.removeItem("mock_auth");
      localStorage.removeItem("mock_admin_name");
      localStorage.removeItem("mock_admin_email");
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
    localStorage.removeItem("mock_admin_email");
    localStorage.removeItem("mock_umpire_auth");
    localStorage.removeItem("mock_umpire_name");
    localStorage.removeItem("mock_umpire_email");
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

      const users = getStaffUsers();
      const existingUser = users.find((u) => u.email.toLowerCase() === cleanEmail);
      if (existingUser?.status === "deactivated") {
        await supabase.auth.signOut().catch(() => {});
        return {
          success: false,
          error: "This official account has been deactivated. Please contact the tournament director.",
        };
      }

      const role: StaffRole = profile?.role === "admin" ? "admin" : "umpire";
      const name = profile?.name || (role === "admin" ? "Tournament Director" : "Match Official");
      setStaffSession(role, name, cleanEmail);
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
        status: "active",
      };
    } else if (cleanEmail === "umpire@dinkvalley.com" && cleanPassword === "umpire123") {
      user = {
        name: "Match Official",
        email: cleanEmail,
        password: cleanPassword,
        role: "umpire",
        status: "active",
      };
    }
  }

  if (!user) {
    return {
      success: false,
      error: "Invalid credentials. Please verify your email and password.",
    };
  }

  if (user.status === "deactivated") {
    return {
      success: false,
      error: "This official account has been deactivated. Please contact the tournament director.",
    };
  }

  setStaffSession(user.role, user.name, user.email);
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
      setStaffSession(finalRole, cleanName, cleanEmail);
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
    status: "active",
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

  setStaffSession(finalRole, cleanName, cleanEmail);
  window.dispatchEvent(new Event("dv_staff_users_changed"));
  return { success: true, role: finalRole };
}

/**
 * Update a staff user's password in local store and cloud.
 */
export async function updateStaffPassword(
  email: string,
  newPassword: string
): Promise<{ success: boolean; error?: string }> {
  const cleanEmail = email.trim().toLowerCase();
  const cleanPassword = newPassword.trim();

  if (cleanPassword.length < 6) {
    return { success: false, error: "Password must be at least 6 characters." };
  }

  const users = getStaffUsers();
  const idx = users.findIndex((u) => u.email.toLowerCase() === cleanEmail);
  if (idx < 0) {
    return { success: false, error: "User account not found." };
  }

  users[idx] = {
    ...users[idx]!,
    password: cleanPassword,
  };
  saveStaffUsers(users);

  try {
    await dbUpdateCloudStaffAccount(cleanEmail, { password: cleanPassword });
  } catch (err) {
    console.warn("[Auth] Failed to sync password update to cloud:", err);
  }

  // If current Supabase Auth user is updating their own password
  try {
    const { data: sessionData } = await supabase.auth.getSession();
    if (sessionData?.session?.user?.email?.toLowerCase() === cleanEmail) {
      await supabase.auth.updateUser({ password: cleanPassword });
    }
  } catch {
    // ignore
  }

  window.dispatchEvent(new Event("dv_staff_users_changed"));
  return { success: true };
}

/**
 * Toggle active / deactivated status of a staff account.
 */
export async function toggleStaffStatus(
  email: string,
  newStatus: "active" | "deactivated"
): Promise<{ success: boolean; error?: string }> {
  const cleanEmail = email.trim().toLowerCase();
  const current = getAuthenticatedStaff();

  if (current?.email && current.email.toLowerCase() === cleanEmail && newStatus === "deactivated") {
    return {
      success: false,
      error: "You cannot deactivate your own currently active administrator session.",
    };
  }

  const users = getStaffUsers();
  const idx = users.findIndex((u) => u.email.toLowerCase() === cleanEmail);
  if (idx < 0) {
    return { success: false, error: "User account not found." };
  }

  users[idx] = {
    ...users[idx]!,
    status: newStatus,
  };
  saveStaffUsers(users);

  try {
    await dbUpdateCloudStaffAccount(cleanEmail, { status: newStatus });
  } catch (err) {
    console.warn("[Auth] Failed to sync status update to cloud:", err);
  }

  window.dispatchEvent(new Event("dv_staff_users_changed"));
  return { success: true };
}

/**
 * Update a staff user's role (admin <-> umpire) in local store and cloud.
 */
export async function updateStaffRole(
  email: string,
  newRole: StaffRole
): Promise<{ success: boolean; error?: string }> {
  const cleanEmail = email.trim().toLowerCase();
  const current = getAuthenticatedStaff();

  if (current?.email && current.email.toLowerCase() === cleanEmail && newRole !== "admin") {
    return {
      success: false,
      error: "You cannot remove administrator privileges from your own currently active session.",
    };
  }

  const users = getStaffUsers();
  const idx = users.findIndex((u) => u.email.toLowerCase() === cleanEmail);
  if (idx < 0) {
    return { success: false, error: "User account not found." };
  }

  users[idx] = {
    ...users[idx]!,
    role: newRole,
  };
  saveStaffUsers(users);

  try {
    await dbUpdateCloudStaffAccount(cleanEmail, { role: newRole });
  } catch (err) {
    console.warn("[Auth] Failed to sync role update to cloud:", err);
  }

  // Also update access_codes table if applicable
  try {
    await supabase
      .from("access_codes")
      .update({ role: newRole })
      .eq("used_by_email", cleanEmail);
  } catch {
    // ignore
  }

  // Also update profiles table if applicable
  try {
    await supabase
      .from("profiles")
      .update({ role: newRole })
      .eq("email", cleanEmail);
  } catch {
    // ignore
  }

  window.dispatchEvent(new Event("dv_staff_users_changed"));
  return { success: true };
}

/**
 * Permanently delete a staff account from local store and cloud.
 */
export async function deleteStaffUser(
  email: string
): Promise<{ success: boolean; error?: string }> {
  const cleanEmail = email.trim().toLowerCase();
  const current = getAuthenticatedStaff();

  if (current?.email && current.email.toLowerCase() === cleanEmail) {
    return {
      success: false,
      error: "You cannot delete your own currently active administrator session.",
    };
  }

  const users = getStaffUsers();
  const updated = users.filter((u) => u.email.toLowerCase() !== cleanEmail);
  saveStaffUsers(updated);

  try {
    await dbDeleteCloudStaffAccount(cleanEmail);
  } catch (err) {
    console.warn("[Auth] Failed to sync deletion to cloud:", err);
  }

  window.dispatchEvent(new Event("dv_staff_users_changed"));
  return { success: true };
}

/**
 * Synchronize staff users between local store and Supabase cloud.
 */
export async function syncStaffUsers(): Promise<StaffUser[]> {
  try {
    const local = getStaffUsers();
    const cloud = await dbSyncCloudStaffAccounts(local);
    if (Array.isArray(cloud) && cloud.length > 0) {
      const merged = mergeAndSaveStaffUsers(cloud);
      window.dispatchEvent(new Event("dv_staff_users_changed"));
      return merged;
    }
    return local;
  } catch {
    return getStaffUsers();
  }
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
