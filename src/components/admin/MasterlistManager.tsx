import { useState, useEffect, useMemo } from "react";
import {
  Users,
  Shield,
  UserCheck,
  UserX,
  KeyRound,
  Search,
  X,
  Eye,
  EyeOff,
  Trash2,
  RefreshCw,
  Download,
  CheckCircle2,
  AlertCircle,
  Calendar,
  Mail,
  Lock,
} from "lucide-react";
import {
  getStaffUsers,
  getAuthenticatedStaff,
  updateStaffPassword,
  updateStaffRole,
  toggleStaffStatus,
  deleteStaffUser,
  syncStaffUsers,
  type StaffUser,
  type StaffRole,
} from "@/lib/auth-store";
import { buildCsvString, triggerCsvDownload } from "@/lib/csv-export";

interface MasterlistManagerProps {
  onNavigateTab?: (tab: string) => void;
}

export function MasterlistManager({ onNavigateTab }: MasterlistManagerProps) {
  const [users, setUsers] = useState<StaffUser[]>(() => getStaffUsers());
  const [isSyncing, setIsSyncing] = useState(false);
  const [searchQuery, setSearchQuery] = useState("");
  const [roleFilter, setRoleFilter] = useState<"all" | StaffRole>("all");
  const [statusFilter, setStatusFilter] = useState<"all" | "active" | "deactivated">("all");
  const [revealedPasswords, setRevealedPasswords] = useState<Record<string, boolean>>({});

  // Role change modal state
  const [roleModalUser, setRoleModalUser] = useState<StaffUser | null>(null);
  const [targetRole, setTargetRole] = useState<StaffRole>("umpire");
  const [isSavingRole, setIsSavingRole] = useState(false);
  const [roleError, setRoleError] = useState<string | null>(null);

  // Password change modal state
  const [passwordModalUser, setPasswordModalUser] = useState<StaffUser | null>(null);
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordError, setPasswordError] = useState<string | null>(null);
  const [passwordSuccess, setPasswordSuccess] = useState<string | null>(null);
  const [isSavingPassword, setIsSavingPassword] = useState(false);
  const [showNewPassword, setShowNewPassword] = useState(false);

  // Delete modal state
  const [deleteModalUser, setDeleteModalUser] = useState<StaffUser | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [isDeleting, setIsDeleting] = useState(false);

  // Status toggle in-progress state
  const [togglingEmail, setTogglingEmail] = useState<string | null>(null);
  const [generalNotice, setGeneralNotice] = useState<{ type: "success" | "error"; message: string } | null>(null);

  const currentStaff = useMemo(() => getAuthenticatedStaff(), []);

  // Sync users on mount and listen to changes
  useEffect(() => {
    const refreshList = () => {
      setUsers(getStaffUsers());
    };

    window.addEventListener("dv_staff_users_changed", refreshList);
    window.addEventListener("dv_auth_changed", refreshList);
    window.addEventListener("storage", refreshList);

    // Initial background cloud sync
    handleSync();

    return () => {
      window.removeEventListener("dv_staff_users_changed", refreshList);
      window.removeEventListener("dv_auth_changed", refreshList);
      window.removeEventListener("storage", refreshList);
    };
  }, []);

  const handleSync = async () => {
    setIsSyncing(true);
    try {
      const synced = await syncStaffUsers();
      setUsers(synced);
    } catch {
      // ignore
    } finally {
      setIsSyncing(false);
    }
  };

  const showNotice = (type: "success" | "error", message: string) => {
    setGeneralNotice({ type, message });
    setTimeout(() => {
      setGeneralNotice((prev) => (prev?.message === message ? null : prev));
    }, 4500);
  };

  // Toggle password visibility for specific row
  const togglePasswordVisibility = (email: string) => {
    setRevealedPasswords((prev) => ({
      ...prev,
      [email]: !prev[email],
    }));
  };

  // Open role change modal
  const openRoleModal = (user: StaffUser) => {
    setRoleModalUser(user);
    setTargetRole(user.role);
    setRoleError(null);
  };

  // Submit role change
  const handleSaveRole = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!roleModalUser) return;
    setIsSavingRole(true);
    setRoleError(null);

    const res = await updateStaffRole(roleModalUser.email, targetRole);
    setIsSavingRole(false);

    if (!res.success) {
      setRoleError(res.error || "Failed to update account role.");
      return;
    }

    setUsers(getStaffUsers());
    const userEmail = roleModalUser.email;
    const roleLabel = targetRole === "admin" ? "Tournament Director (Admin)" : "Match Official (Umpire)";
    setRoleModalUser(null);
    showNotice("success", `${userEmail} privileges updated to ${roleLabel}.`);
  };

  // Open password change modal
  const openPasswordModal = (user: StaffUser) => {
    setPasswordModalUser(user);
    setNewPassword("");
    setConfirmPassword("");
    setPasswordError(null);
    setPasswordSuccess(null);
    setShowNewPassword(false);
  };

  // Submit password change
  const handleSavePassword = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!passwordModalUser) return;

    setPasswordError(null);
    setPasswordSuccess(null);

    const clean = newPassword.trim();
    if (clean.length < 6) {
      setPasswordError("Password must be at least 6 characters.");
      return;
    }

    if (clean !== confirmPassword.trim()) {
      setPasswordError("Passwords do not match.");
      return;
    }

    setIsSavingPassword(true);
    const res = await updateStaffPassword(passwordModalUser.email, clean);
    setIsSavingPassword(false);

    if (!res.success) {
      setPasswordError(res.error || "Failed to update password.");
      return;
    }

    setPasswordSuccess(`Password updated successfully for ${passwordModalUser.email}`);
    setUsers(getStaffUsers());
    setTimeout(() => {
      setPasswordModalUser(null);
    }, 1200);
  };

  // Handle account status toggle (activate / deactivate)
  const handleToggleStatus = async (user: StaffUser) => {
    const nextStatus = user.status === "deactivated" ? "active" : "deactivated";
    setTogglingEmail(user.email);
    const res = await toggleStaffStatus(user.email, nextStatus);
    setTogglingEmail(null);

    if (!res.success) {
      showNotice("error", res.error || "Failed to update account status.");
      return;
    }

    setUsers(getStaffUsers());
    showNotice(
      "success",
      `Account ${user.email} is now ${nextStatus === "active" ? "active" : "deactivated"}.`
    );
  };

  // Open delete user modal
  const openDeleteModal = (user: StaffUser) => {
    setDeleteModalUser(user);
    setDeleteError(null);
  };

  // Confirm delete user
  const handleConfirmDelete = async () => {
    if (!deleteModalUser) return;
    setIsDeleting(true);
    setDeleteError(null);

    const res = await deleteStaffUser(deleteModalUser.email);
    setIsDeleting(false);

    if (!res.success) {
      setDeleteError(res.error || "Failed to delete user account.");
      return;
    }

    setUsers(getStaffUsers());
    const deletedEmail = deleteModalUser.email;
    setDeleteModalUser(null);
    showNotice("success", `User account ${deletedEmail} has been deleted.`);
  };

  // Export Masterlist to CSV
  const handleExportCsv = () => {
    const headers = [
      "Full Name",
      "Email Address",
      "Role",
      "Status",
      "Access Code",
      "Certified Date",
      "Password",
    ];

    const rows = filteredUsers.map((u) => [
      u.name,
      u.email,
      u.role === "admin" ? "Tournament Director (Admin)" : "Match Official (Umpire)",
      u.status || "active",
      u.accessCode || "None",
      u.certifiedAt || "Pre-configured",
      u.password || "",
    ]);

    const csvContent = buildCsvString(headers, rows);
    const dateStamp = new Date().toISOString().split("T")[0];
    triggerCsvDownload(`DinkValley_Official_Users_Masterlist_${dateStamp}.csv`, csvContent);
  };

  // Filtered accounts list
  const filteredUsers = useMemo(() => {
    return users.filter((u) => {
      // Role filter
      if (roleFilter !== "all" && u.role !== roleFilter) return false;

      // Status filter
      const userStatus = u.status || "active";
      if (statusFilter !== "all" && userStatus !== statusFilter) return false;

      // Search query
      if (searchQuery.trim()) {
        const query = searchQuery.trim().toLowerCase();
        const matchesName = u.name.toLowerCase().includes(query);
        const matchesEmail = u.email.toLowerCase().includes(query);
        const matchesCode = u.accessCode ? u.accessCode.toLowerCase().includes(query) : false;
        if (!matchesName && !matchesEmail && !matchesCode) return false;
      }

      return true;
    });
  }, [users, roleFilter, statusFilter, searchQuery]);

  // Aggregate metrics
  const totalCount = users.length;
  const adminCount = users.filter((u) => u.role === "admin" && (u.status || "active") === "active").length;
  const umpireCount = users.filter((u) => u.role === "umpire" && (u.status || "active") === "active").length;
  const deactivatedCount = users.filter((u) => u.status === "deactivated").length;

  return (
    <div className="max-w-6xl space-y-6">
      {/* ── Header ── */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div>
          <span className="text-[0.65rem] sm:text-xs uppercase tracking-[0.28em] text-pickle font-bold block">
            Access Control &amp; Roster
          </span>
          <h2 className="mt-1 font-display text-3xl sm:text-4xl text-foreground">
            Official Accounts Masterlist
          </h2>
          <p className="text-xs sm:text-sm text-muted-foreground mt-1 max-w-2xl">
            Directory of all certified Tournament Directors and Match Officials. Change credentials,
            toggle active status, or revoke accounts.
          </p>
        </div>

        <div className="flex items-center gap-2 self-start sm:self-auto">
          <button
            type="button"
            onClick={handleSync}
            disabled={isSyncing}
            className="flex items-center gap-2 border border-border bg-card px-3.5 py-2 text-xs font-bold uppercase tracking-wider text-foreground hover:border-pickle rounded transition-all cursor-pointer disabled:opacity-50"
            title="Synchronize with Cloud"
          >
            <RefreshCw size={14} className={isSyncing ? "animate-spin text-pickle" : "text-muted-foreground"} />
            <span>{isSyncing ? "Syncing..." : "Sync Cloud"}</span>
          </button>

          <button
            type="button"
            onClick={handleExportCsv}
            disabled={filteredUsers.length === 0}
            className="flex items-center gap-2 bg-brick hover:bg-brick-deep px-4 py-2 text-xs font-bold uppercase tracking-wider text-sand rounded transition-all cursor-pointer disabled:opacity-50"
          >
            <Download size={14} />
            <span>Export CSV</span>
          </button>
        </div>
      </div>

      {/* ── General Toast / Notice ── */}
      {generalNotice && (
        <div
          className={`p-3.5 rounded-lg border text-xs sm:text-sm font-medium flex items-center justify-between gap-3 transition-all ${
            generalNotice.type === "success"
              ? "bg-pickle/10 border-pickle/40 text-foreground"
              : "bg-brick/10 border-brick/40 text-brick"
          }`}
        >
          <div className="flex items-center gap-2">
            {generalNotice.type === "success" ? (
              <CheckCircle2 size={16} className="text-pickle flex-shrink-0" />
            ) : (
              <AlertCircle size={16} className="text-brick flex-shrink-0" />
            )}
            <span>{generalNotice.message}</span>
          </div>
          <button
            onClick={() => setGeneralNotice(null)}
            className="text-muted-foreground hover:text-foreground p-1 cursor-pointer"
          >
            <X size={14} />
          </button>
        </div>
      )}

      {/* ── Summary Metric Cards ── */}
      <div className="grid grid-cols-2 lg:grid-cols-4 gap-3 sm:gap-4">
        <div className="surface-card bg-card border border-border p-4 rounded-xl flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-charcoal/10 dark:bg-sand/10 flex items-center justify-center text-foreground flex-shrink-0">
            <Users size={20} />
          </div>
          <div>
            <span className="text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground block">
              Total Accounts
            </span>
            <span className="font-display text-2xl sm:text-3xl text-foreground font-bold">
              {totalCount}
            </span>
          </div>
        </div>

        <div className="surface-card bg-card border border-brick/30 p-4 rounded-xl flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-brick/15 flex items-center justify-center text-brick flex-shrink-0">
            <Shield size={20} />
          </div>
          <div>
            <span className="text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground block">
              Active Admins
            </span>
            <span className="font-display text-2xl sm:text-3xl text-brick font-bold">
              {adminCount}
            </span>
          </div>
        </div>

        <div className="surface-card bg-card border border-pickle/30 p-4 rounded-xl flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-pickle/15 flex items-center justify-center text-pickle flex-shrink-0">
            <UserCheck size={20} />
          </div>
          <div>
            <span className="text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground block">
              Active Umpires
            </span>
            <span className="font-display text-2xl sm:text-3xl text-pickle font-bold">
              {umpireCount}
            </span>
          </div>
        </div>

        <div className="surface-card bg-card border border-border p-4 rounded-xl flex items-center gap-3">
          <div className="h-10 w-10 rounded-lg bg-muted flex items-center justify-center text-muted-foreground flex-shrink-0">
            <UserX size={20} />
          </div>
          <div>
            <span className="text-[0.65rem] font-bold uppercase tracking-wider text-muted-foreground block">
              Deactivated
            </span>
            <span className="font-display text-2xl sm:text-3xl text-muted-foreground font-bold">
              {deactivatedCount}
            </span>
          </div>
        </div>
      </div>

      {/* ── Filters & Search ── */}
      <div className="surface-card bg-card border border-border p-3.5 sm:p-4 rounded-xl space-y-3">
        <div className="flex flex-col md:flex-row gap-3">
          {/* Search Bar */}
          <div className="relative flex-1">
            <Search
              size={16}
              className="absolute left-3.5 top-1/2 -translate-y-1/2 text-muted-foreground"
            />
            <input
              type="text"
              value={searchQuery}
              onChange={(e) => setSearchQuery(e.target.value)}
              placeholder="Search by name, email, or access code..."
              className="w-full pl-10 pr-9 py-2 text-xs sm:text-sm bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-pickle transition-colors"
            />
            {searchQuery && (
              <button
                onClick={() => setSearchQuery("")}
                className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
              >
                <X size={14} />
              </button>
            )}
          </div>

          {/* Role Filter */}
          <div className="flex items-center gap-2">
            <span className="text-[0.7rem] uppercase tracking-wider font-bold text-muted-foreground whitespace-nowrap">
              Role:
            </span>
            <div className="flex rounded-lg border border-border overflow-hidden bg-background">
              <button
                type="button"
                onClick={() => setRoleFilter("all")}
                className={`px-3 py-1.5 text-xs font-bold transition-colors cursor-pointer ${
                  roleFilter === "all"
                    ? "bg-brick text-sand"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                All
              </button>
              <button
                type="button"
                onClick={() => setRoleFilter("admin")}
                className={`px-3 py-1.5 text-xs font-bold transition-colors cursor-pointer ${
                  roleFilter === "admin"
                    ? "bg-brick text-sand"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Admins
              </button>
              <button
                type="button"
                onClick={() => setRoleFilter("umpire")}
                className={`px-3 py-1.5 text-xs font-bold transition-colors cursor-pointer ${
                  roleFilter === "umpire"
                    ? "bg-brick text-sand"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Umpires
              </button>
            </div>
          </div>

          {/* Status Filter */}
          <div className="flex items-center gap-2">
            <span className="text-[0.7rem] uppercase tracking-wider font-bold text-muted-foreground whitespace-nowrap">
              Status:
            </span>
            <div className="flex rounded-lg border border-border overflow-hidden bg-background">
              <button
                type="button"
                onClick={() => setStatusFilter("all")}
                className={`px-3 py-1.5 text-xs font-bold transition-colors cursor-pointer ${
                  statusFilter === "all"
                    ? "bg-pickle text-sand"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                All
              </button>
              <button
                type="button"
                onClick={() => setStatusFilter("active")}
                className={`px-3 py-1.5 text-xs font-bold transition-colors cursor-pointer ${
                  statusFilter === "active"
                    ? "bg-pickle text-sand"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Active
              </button>
              <button
                type="button"
                onClick={() => setStatusFilter("deactivated")}
                className={`px-3 py-1.5 text-xs font-bold transition-colors cursor-pointer ${
                  statusFilter === "deactivated"
                    ? "bg-pickle text-sand"
                    : "text-muted-foreground hover:text-foreground"
                }`}
              >
                Inactive
              </button>
            </div>
          </div>
        </div>

        {/* Active Filters Bar */}
        {(searchQuery || roleFilter !== "all" || statusFilter !== "all") && (
          <div className="flex items-center justify-between text-xs text-muted-foreground border-t border-border/60 pt-2.5">
            <span>
              Showing {filteredUsers.length} of {users.length} accounts
            </span>
            <button
              onClick={() => {
                setSearchQuery("");
                setRoleFilter("all");
                setStatusFilter("all");
              }}
              className="text-brick hover:underline font-bold uppercase text-[0.65rem] tracking-wider cursor-pointer"
            >
              Reset Filters
            </button>
          </div>
        )}
      </div>

      {/* ── Accounts List Section ── */}
      <div className="surface-card bg-card border border-border rounded-xl overflow-hidden shadow-sm">
        {filteredUsers.length === 0 ? (
          <div className="p-10 text-center space-y-3">
            <div className="h-12 w-12 rounded-full bg-muted flex items-center justify-center mx-auto text-muted-foreground">
              <Search size={22} />
            </div>
            <h3 className="font-display text-2xl text-foreground">No Official Accounts Found</h3>
            <p className="text-xs text-muted-foreground max-w-sm mx-auto">
              No registered user accounts match your active search and filter criteria.
            </p>
            {onNavigateTab && (
              <button
                onClick={() => onNavigateTab("access-codes")}
                className="mt-2 text-xs font-bold uppercase tracking-wider text-pickle hover:underline cursor-pointer inline-flex items-center gap-1"
              >
                <KeyRound size={14} />
                <span>Issue new access code for registration</span>
              </button>
            )}
          </div>
        ) : (
          <>
            {/* ── Desktop View (Table) ── */}
            <div className="hidden md:block overflow-x-auto">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="border-b border-border bg-charcoal/5 dark:bg-sand/5 text-muted-foreground font-bold uppercase tracking-wider text-[0.65rem]">
                    <th className="py-3.5 px-4">Official / Account</th>
                    <th className="py-3.5 px-4">Role</th>
                    <th className="py-3.5 px-4">Access Code</th>
                    <th className="py-3.5 px-4">Certified Date</th>
                    <th className="py-3.5 px-4">Password</th>
                    <th className="py-3.5 px-4">Status</th>
                    <th className="py-3.5 px-4 text-right">Actions</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-border">
                  {filteredUsers.map((user) => {
                    const isSelf =
                      currentStaff?.email &&
                      currentStaff.email.toLowerCase() === user.email.toLowerCase();
                    const isDeactivated = user.status === "deactivated";
                    const isPasswordRevealed = Boolean(revealedPasswords[user.email]);

                    return (
                      <tr
                        key={user.email}
                        className={`hover:bg-charcoal/5 dark:hover:bg-sand/5 transition-colors ${
                          isDeactivated ? "opacity-60 bg-muted/20" : ""
                        }`}
                      >
                        {/* Name & Email */}
                        <td className="py-3.5 px-4">
                          <div className="flex items-center gap-3">
                            <div
                              className={`h-9 w-9 rounded-full flex items-center justify-center font-bold text-xs uppercase flex-shrink-0 ${
                                user.role === "admin"
                                  ? "bg-brick text-sand ring-1 ring-brick/50"
                                  : "bg-pickle text-sand ring-1 ring-pickle/50"
                              }`}
                            >
                              {user.name.slice(0, 2)}
                            </div>
                            <div>
                              <div className="flex items-center gap-2">
                                <span className="font-bold text-sm text-foreground">
                                  {user.name}
                                </span>
                                {isSelf && (
                                  <span className="text-[0.6rem] uppercase tracking-wider font-bold bg-pickle/15 text-pickle px-2 py-0.5 rounded-full">
                                    Current
                                  </span>
                                )}
                              </div>
                              <span className="text-xs text-muted-foreground flex items-center gap-1">
                                <Mail size={11} />
                                {user.email}
                              </span>
                            </div>
                          </div>
                        </td>

                        {/* Role Badge */}
                        <td className="py-3.5 px-4">
                          <span
                            className={`inline-flex items-center gap-1.5 px-2.5 py-1 rounded text-[0.65rem] font-bold uppercase tracking-wider ${
                              user.role === "admin"
                                ? "bg-brick/15 text-brick border border-brick/30"
                                : "bg-pickle/15 text-pickle border border-pickle/30"
                            }`}
                          >
                            {user.role === "admin" ? <Shield size={12} /> : <UserCheck size={12} />}
                            {user.role === "admin" ? "Director (Admin)" : "Official (Umpire)"}
                          </span>
                        </td>

                        {/* Access Code */}
                        <td className="py-3.5 px-4">
                          {user.accessCode ? (
                            <span className="font-mono text-xs font-bold bg-background border border-border px-2 py-1 rounded text-foreground">
                              {user.accessCode}
                            </span>
                          ) : (
                            <span className="text-muted-foreground/60 italic text-xs">
                              Default / System
                            </span>
                          )}
                        </td>

                        {/* Certified Date */}
                        <td className="py-3.5 px-4 text-muted-foreground text-xs whitespace-nowrap">
                          <span className="inline-flex items-center gap-1.5">
                            <Calendar size={12} />
                            {user.certifiedAt || "System default"}
                          </span>
                        </td>

                        {/* Password */}
                        <td className="py-3.5 px-4">
                          <div className="flex items-center gap-2">
                            <span className="font-mono text-xs text-foreground select-all">
                              {isPasswordRevealed
                                ? user.password || "••••••••"
                                : "••••••••"}
                            </span>
                            <button
                              type="button"
                              onClick={() => togglePasswordVisibility(user.email)}
                              className="text-muted-foreground hover:text-foreground p-1 transition-colors cursor-pointer"
                              title={isPasswordRevealed ? "Hide Password" : "Show Password"}
                            >
                              {isPasswordRevealed ? <EyeOff size={13} /> : <Eye size={13} />}
                            </button>
                          </div>
                        </td>

                        {/* Status */}
                        <td className="py-3.5 px-4">
                          <span
                            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded text-[0.65rem] font-bold uppercase tracking-wider ${
                              isDeactivated
                                ? "bg-muted text-muted-foreground border border-border"
                                : "bg-pickle/15 text-pickle border border-pickle/30"
                            }`}
                          >
                            <span
                              className={`h-1.5 w-1.5 rounded-full ${
                                isDeactivated ? "bg-muted-foreground" : "bg-pickle animate-pulse"
                              }`}
                            />
                            {isDeactivated ? "Deactivated" : "Active"}
                          </span>
                        </td>

                        {/* Action Buttons */}
                        <td className="py-3.5 px-4 text-right">
                          <div className="flex items-center justify-end gap-1.5">
                            {/* Change Role / Privileges */}
                            <button
                              type="button"
                              onClick={() => openRoleModal(user)}
                              className="px-2.5 py-1 rounded border border-border bg-background hover:border-pickle text-foreground text-[0.7rem] font-bold uppercase tracking-wider inline-flex items-center gap-1 transition-colors cursor-pointer"
                              title="Change Role & Privileges"
                            >
                              <Shield size={12} />
                              <span>Role</span>
                            </button>

                            {/* Change Password */}
                            <button
                              type="button"
                              onClick={() => openPasswordModal(user)}
                              className="px-2.5 py-1 rounded border border-border bg-background hover:border-pickle text-foreground text-[0.7rem] font-bold uppercase tracking-wider inline-flex items-center gap-1 transition-colors cursor-pointer"
                              title="Change Password"
                            >
                              <Lock size={12} />
                              <span>Password</span>
                            </button>

                            {/* Deactivate / Activate */}
                            <button
                              type="button"
                              onClick={() => handleToggleStatus(user)}
                              disabled={Boolean(isSelf) || togglingEmail === user.email}
                              className={`px-2.5 py-1 rounded border text-[0.7rem] font-bold uppercase tracking-wider inline-flex items-center gap-1 transition-colors cursor-pointer disabled:opacity-40 disabled:cursor-not-allowed ${
                                isDeactivated
                                  ? "border-pickle/40 text-pickle hover:bg-pickle/10"
                                  : "border-border text-muted-foreground hover:text-brick hover:border-brick/40"
                              }`}
                              title={
                                isSelf
                                  ? "Cannot deactivate your own active session"
                                  : isDeactivated
                                  ? "Activate Account"
                                  : "Deactivate Account"
                              }
                            >
                              {isDeactivated ? (
                                <>
                                  <CheckCircle2 size={12} />
                                  <span>Activate</span>
                                </>
                              ) : (
                                <>
                                  <UserX size={12} />
                                  <span>Deactivate</span>
                                </>
                              )}
                            </button>

                            {/* Delete User */}
                            <button
                              type="button"
                              onClick={() => openDeleteModal(user)}
                              disabled={Boolean(isSelf)}
                              className="p-1 rounded text-muted-foreground hover:text-brick hover:bg-brick/10 transition-colors cursor-pointer disabled:opacity-30 disabled:cursor-not-allowed"
                              title={
                                isSelf
                                  ? "Cannot delete your own active session"
                                  : "Delete Account"
                              }
                            >
                              <Trash2 size={14} />
                            </button>
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>

            {/* ── Mobile View (Cards) ── */}
            <div className="md:hidden divide-y divide-border">
              {filteredUsers.map((user) => {
                const isSelf =
                  currentStaff?.email &&
                  currentStaff.email.toLowerCase() === user.email.toLowerCase();
                const isDeactivated = user.status === "deactivated";
                const isPasswordRevealed = Boolean(revealedPasswords[user.email]);

                return (
                  <div
                    key={user.email}
                    className={`p-4 space-y-3 ${
                      isDeactivated ? "opacity-65 bg-muted/20" : ""
                    }`}
                  >
                    {/* Top Row: Avatar, Name, Badges */}
                    <div className="flex items-start justify-between gap-2">
                      <div className="flex items-center gap-3">
                        <div
                          className={`h-10 w-10 rounded-full flex items-center justify-center font-bold text-xs uppercase flex-shrink-0 ${
                            user.role === "admin"
                              ? "bg-brick text-sand ring-1 ring-brick/50"
                              : "bg-pickle text-sand ring-1 ring-pickle/50"
                          }`}
                        >
                          {user.name.slice(0, 2)}
                        </div>
                        <div>
                          <div className="flex items-center gap-1.5 flex-wrap">
                            <span className="font-bold text-sm text-foreground">
                              {user.name}
                            </span>
                            {isSelf && (
                              <span className="text-[0.6rem] uppercase tracking-wider font-bold bg-pickle/15 text-pickle px-1.5 py-0.2 rounded-full">
                                Self
                              </span>
                            )}
                          </div>
                          <span className="text-xs text-muted-foreground break-all">
                            {user.email}
                          </span>
                        </div>
                      </div>

                      {/* Status Badge */}
                      <span
                        className={`inline-flex items-center gap-1 px-2 py-0.5 rounded text-[0.6rem] font-bold uppercase tracking-wider flex-shrink-0 ${
                          isDeactivated
                            ? "bg-muted text-muted-foreground border border-border"
                            : "bg-pickle/15 text-pickle border border-pickle/30"
                        }`}
                      >
                        <span
                          className={`h-1.5 w-1.5 rounded-full ${
                            isDeactivated ? "bg-muted-foreground" : "bg-pickle animate-pulse"
                          }`}
                        />
                        {isDeactivated ? "Inactive" : "Active"}
                      </span>
                    </div>

                    {/* Middle Row: Role, Code, Date */}
                    <div className="grid grid-cols-2 gap-2 text-xs pt-1 border-t border-border/50">
                      <div>
                        <span className="text-[0.6rem] uppercase tracking-wider font-bold text-muted-foreground block">
                          Role
                        </span>
                        <span
                          className={`inline-flex items-center gap-1 font-bold text-[0.7rem] uppercase ${
                            user.role === "admin" ? "text-brick" : "text-pickle"
                          }`}
                        >
                          {user.role === "admin" ? <Shield size={12} /> : <UserCheck size={12} />}
                          {user.role === "admin" ? "Director (Admin)" : "Official (Umpire)"}
                        </span>
                      </div>

                      <div>
                        <span className="text-[0.6rem] uppercase tracking-wider font-bold text-muted-foreground block">
                          Access Code
                        </span>
                        <span className="font-mono text-xs font-bold text-foreground">
                          {user.accessCode || "Default"}
                        </span>
                      </div>

                      <div>
                        <span className="text-[0.6rem] uppercase tracking-wider font-bold text-muted-foreground block">
                          Certified Date
                        </span>
                        <span className="text-xs text-muted-foreground">
                          {user.certifiedAt || "System default"}
                        </span>
                      </div>

                      <div>
                        <span className="text-[0.6rem] uppercase tracking-wider font-bold text-muted-foreground block">
                          Password
                        </span>
                        <div className="flex items-center gap-1">
                          <span className="font-mono text-xs text-foreground">
                            {isPasswordRevealed ? user.password || "••••••••" : "••••••••"}
                          </span>
                          <button
                            type="button"
                            onClick={() => togglePasswordVisibility(user.email)}
                            className="p-1 text-muted-foreground hover:text-foreground"
                          >
                            {isPasswordRevealed ? <EyeOff size={12} /> : <Eye size={12} />}
                          </button>
                        </div>
                      </div>
                    </div>

                    {/* Bottom Row: Actions */}
                    <div className="flex items-center justify-between gap-2 pt-2 border-t border-border/50">
                      <button
                        type="button"
                        onClick={() => openRoleModal(user)}
                        className="flex-1 py-1.5 px-2 rounded border border-border bg-background hover:border-pickle text-foreground text-xs font-bold uppercase tracking-wider inline-flex items-center justify-center gap-1 transition-colors cursor-pointer"
                      >
                        <Shield size={12} />
                        <span>Role</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => openPasswordModal(user)}
                        className="flex-1 py-1.5 px-2 rounded border border-border bg-background hover:border-pickle text-foreground text-xs font-bold uppercase tracking-wider inline-flex items-center justify-center gap-1 transition-colors cursor-pointer"
                      >
                        <Lock size={12} />
                        <span>Password</span>
                      </button>

                      <button
                        type="button"
                        onClick={() => handleToggleStatus(user)}
                        disabled={Boolean(isSelf) || togglingEmail === user.email}
                        className={`flex-1 py-1.5 px-2 rounded border text-xs font-bold uppercase tracking-wider inline-flex items-center justify-center gap-1 transition-colors cursor-pointer disabled:opacity-40 ${
                          isDeactivated
                            ? "border-pickle/40 text-pickle hover:bg-pickle/10"
                            : "border-border text-muted-foreground hover:text-brick"
                        }`}
                      >
                        {isDeactivated ? (
                          <>
                            <CheckCircle2 size={12} />
                            <span>Activate</span>
                          </>
                        ) : (
                          <>
                            <UserX size={12} />
                            <span>Deactivate</span>
                          </>
                        )}
                      </button>

                      <button
                        type="button"
                        onClick={() => openDeleteModal(user)}
                        disabled={Boolean(isSelf)}
                        className="p-2 rounded text-muted-foreground hover:text-brick hover:bg-brick/10 transition-colors cursor-pointer disabled:opacity-30"
                        title="Delete Account"
                      >
                        <Trash2 size={16} />
                      </button>
                    </div>
                  </div>
                );
              })}
            </div>
          </>
        )}
      </div>

      {/* ── Change Password Modal ── */}
      {passwordModalUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="surface-card bg-card border border-border w-full max-w-md p-6 rounded-xl shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div>
                <span className="text-[0.65rem] font-bold uppercase tracking-[0.2em] text-pickle block">
                  Credentials Security
                </span>
                <h3 className="font-display text-2xl text-foreground">Change Password</h3>
              </div>
              <button
                type="button"
                onClick={() => setPasswordModalUser(null)}
                className="text-muted-foreground hover:text-foreground p-1 cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <div className="text-xs text-muted-foreground bg-muted/40 p-3 rounded-lg space-y-1">
              <div>
                <span className="font-bold text-foreground">Account: </span>
                {passwordModalUser.name}
              </div>
              <div>
                <span className="font-bold text-foreground">Email: </span>
                {passwordModalUser.email}
              </div>
              <div>
                <span className="font-bold text-foreground">Role: </span>
                {passwordModalUser.role === "admin"
                  ? "Tournament Director (Admin)"
                  : "Match Official (Umpire)"}
              </div>
            </div>

            {passwordError && (
              <div className="p-3 rounded bg-brick/10 border border-brick/40 text-brick text-xs flex items-center gap-2">
                <AlertCircle size={14} className="flex-shrink-0" />
                <span>{passwordError}</span>
              </div>
            )}

            {passwordSuccess && (
              <div className="p-3 rounded bg-pickle/10 border border-pickle/40 text-pickle text-xs flex items-center gap-2">
                <CheckCircle2 size={14} className="flex-shrink-0" />
                <span>{passwordSuccess}</span>
              </div>
            )}

            <form onSubmit={handleSavePassword} className="space-y-3">
              <div>
                <label className="block text-[0.65rem] uppercase tracking-wider font-bold text-muted-foreground mb-1">
                  New Password (min 6 characters)
                </label>
                <div className="relative">
                  <input
                    type={showNewPassword ? "text" : "password"}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    required
                    minLength={6}
                    placeholder="Enter new secure password"
                    className="w-full px-3 py-2 pr-10 text-xs sm:text-sm bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-pickle transition-colors"
                  />
                  <button
                    type="button"
                    onClick={() => setShowNewPassword((prev) => !prev)}
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                  >
                    {showNewPassword ? <EyeOff size={14} /> : <Eye size={14} />}
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-[0.65rem] uppercase tracking-wider font-bold text-muted-foreground mb-1">
                  Confirm New Password
                </label>
                <input
                  type={showNewPassword ? "text" : "password"}
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  required
                  minLength={6}
                  placeholder="Repeat new password"
                  className="w-full px-3 py-2 text-xs sm:text-sm bg-background border border-border rounded-lg text-foreground placeholder:text-muted-foreground/60 focus:outline-none focus:border-pickle transition-colors"
                />
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-border">
                <button
                  type="button"
                  onClick={() => setPasswordModalUser(null)}
                  disabled={isSavingPassword}
                  className="px-4 py-2 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground border border-border rounded transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSavingPassword}
                  className="px-5 py-2 text-xs font-bold uppercase tracking-wider bg-brick hover:bg-brick-deep text-sand rounded transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {isSavingPassword ? (
                    <>
                      <RefreshCw size={13} className="animate-spin" />
                      <span>Saving...</span>
                    </>
                  ) : (
                    <span>Update Password</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}

      {/* ── Delete Confirmation Modal ── */}
      {deleteModalUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="surface-card bg-card border border-brick/40 w-full max-w-md p-6 rounded-xl shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div>
                <span className="text-[0.65rem] font-bold uppercase tracking-[0.2em] text-brick font-bold block">
                  Destructive Action
                </span>
                <h3 className="font-display text-2xl text-foreground">Delete User Account</h3>
              </div>
              <button
                type="button"
                onClick={() => setDeleteModalUser(null)}
                className="text-muted-foreground hover:text-foreground p-1 cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <p className="text-xs sm:text-sm text-foreground">
              Are you sure you want to permanently delete the account for{" "}
              <strong className="text-brick">{deleteModalUser.name}</strong> (
              <span className="font-mono text-xs">{deleteModalUser.email}</span>)?
            </p>

            <div className="p-3 rounded-lg bg-brick/10 border border-brick/30 text-xs text-brick space-y-1">
              <span className="font-bold block">Warning:</span>
              <span>
                This will revoke their access to both the Administrator Console and Umpire Console
                across all synchronized devices. This action cannot be undone.
              </span>
            </div>

            {deleteError && (
              <div className="p-3 rounded bg-brick/10 border border-brick/40 text-brick text-xs flex items-center gap-2">
                <AlertCircle size={14} className="flex-shrink-0" />
                <span>{deleteError}</span>
              </div>
            )}

            <div className="flex items-center justify-end gap-2 pt-3 border-t border-border">
              <button
                type="button"
                onClick={() => setDeleteModalUser(null)}
                disabled={isDeleting}
                className="px-4 py-2 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground border border-border rounded transition-colors cursor-pointer"
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={handleConfirmDelete}
                disabled={isDeleting}
                className="px-5 py-2 text-xs font-bold uppercase tracking-wider bg-brick hover:bg-brick-deep text-sand rounded transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
              >
                {isDeleting ? (
                  <>
                    <RefreshCw size={13} className="animate-spin" />
                    <span>Deleting...</span>
                  </>
                ) : (
                  <>
                    <Trash2 size={13} />
                    <span>Delete Account</span>
                  </>
                )}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* ── Change Role Modal ── */}
      {roleModalUser && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-charcoal/80 backdrop-blur-sm p-4 animate-in fade-in duration-150">
          <div className="surface-card bg-card border border-border w-full max-w-md p-6 rounded-xl shadow-2xl space-y-4">
            <div className="flex items-center justify-between border-b border-border pb-3">
              <div>
                <span className="text-[0.65rem] font-bold uppercase tracking-[0.2em] text-pickle block">
                  Permissions Management
                </span>
                <h3 className="font-display text-2xl text-foreground">Change Account Role</h3>
              </div>
              <button
                type="button"
                onClick={() => setRoleModalUser(null)}
                className="text-muted-foreground hover:text-foreground p-1 cursor-pointer"
              >
                <X size={18} />
              </button>
            </div>

            <div className="text-xs text-muted-foreground bg-muted/40 p-3 rounded-lg space-y-1">
              <div>
                <span className="font-bold text-foreground">Official: </span>
                {roleModalUser.name}
              </div>
              <div>
                <span className="font-bold text-foreground">Email: </span>
                {roleModalUser.email}
              </div>
              <div>
                <span className="font-bold text-foreground">Current Role: </span>
                {roleModalUser.role === "admin"
                  ? "Tournament Director (Admin)"
                  : "Match Official (Umpire)"}
              </div>
            </div>

            {roleError && (
              <div className="p-3 rounded bg-brick/10 border border-brick/40 text-brick text-xs flex items-center gap-2">
                <AlertCircle size={14} className="flex-shrink-0" />
                <span>{roleError}</span>
              </div>
            )}

            <form onSubmit={handleSaveRole} className="space-y-4">
              <div className="space-y-2">
                <label className="block text-[0.65rem] uppercase tracking-wider font-bold text-muted-foreground">
                  Select System Role &amp; Privileges
                </label>

                {/* Option 1: Admin */}
                <label
                  className={`flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-all ${
                    targetRole === "admin"
                      ? "border-brick bg-brick/10"
                      : "border-border bg-background hover:border-border/80"
                  }`}
                >
                  <input
                    type="radio"
                    name="accountRole"
                    value="admin"
                    checked={targetRole === "admin"}
                    onChange={() => setTargetRole("admin")}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm text-foreground">
                        Tournament Director (Admin)
                      </span>
                      <span className="text-[0.6rem] uppercase tracking-wider font-bold bg-brick/15 text-brick px-2 py-0.5 rounded">
                        Full Access
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Grants access to the Organizer Gate (/admin), draws management, dispatch queue, tournament creation, and accounts masterlist.
                    </p>
                  </div>
                </label>

                {/* Option 2: Umpire */}
                <label
                  className={`flex items-start gap-3 p-3 rounded-lg border-2 cursor-pointer transition-all ${
                    targetRole === "umpire"
                      ? "border-pickle bg-pickle/10"
                      : "border-border bg-background hover:border-border/80"
                  }`}
                >
                  <input
                    type="radio"
                    name="accountRole"
                    value="umpire"
                    checked={targetRole === "umpire"}
                    onChange={() => setTargetRole("umpire")}
                    className="mt-0.5"
                  />
                  <div>
                    <div className="flex items-center gap-2">
                      <span className="font-bold text-sm text-foreground">
                        Match Official (Umpire)
                      </span>
                      <span className="text-[0.6rem] uppercase tracking-wider font-bold bg-pickle/15 text-pickle px-2 py-0.5 rounded">
                        Field Access
                      </span>
                    </div>
                    <p className="text-xs text-muted-foreground mt-0.5">
                      Grants access to the Umpire Console (/umpire) for live court scoring, side switches, and completed match submission.
                    </p>
                  </div>
                </label>
              </div>

              <div className="flex items-center justify-end gap-2 pt-3 border-t border-border">
                <button
                  type="button"
                  onClick={() => setRoleModalUser(null)}
                  disabled={isSavingRole}
                  className="px-4 py-2 text-xs font-bold uppercase tracking-wider text-muted-foreground hover:text-foreground border border-border rounded transition-colors cursor-pointer"
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={isSavingRole}
                  className="px-5 py-2 text-xs font-bold uppercase tracking-wider bg-brick hover:bg-brick-deep text-sand rounded transition-colors cursor-pointer disabled:opacity-50 inline-flex items-center gap-1.5"
                >
                  {isSavingRole ? (
                    <>
                      <RefreshCw size={13} className="animate-spin" />
                      <span>Saving...</span>
                    </>
                  ) : (
                    <span>Update Role</span>
                  )}
                </button>
              </div>
            </form>
          </div>
        </div>
      )}
    </div>
  );
}
