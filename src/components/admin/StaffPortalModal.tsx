import { useState, useEffect, useRef } from "react";
import { useNavigate } from "@tanstack/react-router";
import {
  loginWithCredentials,
  registerStaffAccount,
  type StaffRole,
} from "@/lib/auth-store";

interface StaffPortalModalProps {
  isOpen: boolean;
  onClose: () => void;
}

export function StaffPortalModal({ isOpen, onClose }: StaffPortalModalProps) {
  const navigate = useNavigate();
  const [tab, setTab] = useState<"signin" | "register">("signin");

  // Sign In state (Email & Password credentials only)
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");

  // Register state
  const [regName, setRegName] = useState("");
  const [regEmail, setRegEmail] = useState("");
  const [regPassword, setRegPassword] = useState("");
  const [regConfirmPassword, setRegConfirmPassword] = useState("");
  const [regRole, setRegRole] = useState<StaffRole>("umpire");
  const [regAccessCode, setRegAccessCode] = useState("");

  const [error, setError] = useState<string | null>(null);
  const [successNotice, setSuccessNotice] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(false);

  const modalRef = useRef<HTMLDivElement>(null);

  // Close on Escape key
  useEffect(() => {
    if (!isOpen) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        onClose();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [isOpen, onClose]);

  // Reset errors when switching tabs
  useEffect(() => {
    setError(null);
    setSuccessNotice(null);
  }, [tab, isOpen]);

  if (!isOpen) return null;

  const handleSignInWithCredentials = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);
    setIsLoading(true);

    const res = await loginWithCredentials(email, password);
    setIsLoading(false);

    if (!res.success) {
      setError(res.error || "Authentication failed. Please check your credentials.");
      return;
    }

    setSuccessNotice(`Authenticated as ${res.name}. Redirecting...`);
    setTimeout(() => {
      onClose();
      if (res.role === "admin") {
        navigate({ to: "/admin" });
      } else {
        navigate({ to: "/umpire" });
      }
    }, 450);
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError(null);

    if (regPassword !== regConfirmPassword) {
      setError("Passwords do not match.");
      return;
    }

    setIsLoading(true);
    const res = await registerStaffAccount({
      name: regName,
      email: regEmail,
      password: regPassword,
      role: regRole,
      accessCode: regAccessCode,
    });
    setIsLoading(false);

    if (!res.success) {
      setError(res.error || "Registration failed.");
      return;
    }

    setSuccessNotice("Official account registered and certified. Redirecting...");
    setTimeout(() => {
      onClose();
      if (regRole === "admin") {
        navigate({ to: "/admin" });
      } else {
        navigate({ to: "/umpire" });
      }
    }, 500);
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/75 backdrop-blur-sm p-4 animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        ref={modalRef}
        onClick={(e) => e.stopPropagation()}
        className="surface-card bg-card border border-border w-full max-w-lg shadow-2xl rounded-xl overflow-hidden flex flex-col max-h-[90vh]"
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4 bg-charcoal">
          <div className="flex items-center gap-3">
            <img
              src="/DinkValley.jpg"
              alt="Dink Valley"
              className="h-9 w-9 rounded-full object-cover ring-2 ring-brick"
            />
            <div>
              <span className="text-[0.65rem] uppercase tracking-[0.28em] text-pickle font-bold block">
                Authorized Personnel Only
              </span>
              <h2 className="font-display text-xl sm:text-2xl text-sand">
                Tournament Staff Portal
              </h2>
            </div>
          </div>
          <button
            onClick={onClose}
            className="text-sand/60 hover:text-sand text-lg font-bold p-1 transition-colors cursor-pointer"
            aria-label="Close dialog"
          >
            &times;
          </button>
        </div>

        {/* Tab Switcher */}
        <div className="flex border-b-2 border-border bg-card text-xs font-bold uppercase tracking-wider">
          <button
            onClick={() => setTab("signin")}
            className={`flex-1 py-3 text-center transition-colors cursor-pointer border-b-2 ${
              tab === "signin"
                ? "border-pickle text-pickle bg-pickle/10 font-bold"
                : "border-transparent text-foreground/70 hover:text-foreground hover:bg-pickle/5"
            }`}
          >
            Staff Sign In
          </button>
          <button
            onClick={() => setTab("register")}
            className={`flex-1 py-3 text-center transition-colors cursor-pointer border-b-2 ${
              tab === "register"
                ? "border-pickle text-pickle bg-pickle/10 font-bold"
                : "border-transparent text-foreground/70 hover:text-foreground hover:bg-pickle/5"
            }`}
          >
            Register Official
          </button>
        </div>

        {/* Modal Body */}
        <div className="p-5 sm:p-6 overflow-y-auto space-y-4">
          {error && (
            <div className="p-3 bg-brick/15 border border-brick/60 text-brick text-xs font-semibold rounded">
              {error}
            </div>
          )}

          {successNotice && (
            <div className="p-3 bg-pickle/15 border border-pickle/60 text-pickle text-xs font-semibold rounded">
              {successNotice}
            </div>
          )}

          {/* TAB 1: SIGN IN */}
          {tab === "signin" && (
            <div className="space-y-4">
              <form onSubmit={handleSignInWithCredentials} className="space-y-3 pt-1">
                <div>
                  <label className="block text-[0.65rem] uppercase tracking-wider text-muted-foreground font-bold mb-1">
                    Email Address
                  </label>
                  <input
                    type="email"
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="staff@dinkvalley.com"
                    autoFocus
                    required
                    className="w-full bg-charcoal border border-border px-3 py-2 text-sand text-sm rounded focus:outline-none focus:border-pickle"
                  />
                </div>

                <div>
                  <label className="block text-[0.65rem] uppercase tracking-wider text-muted-foreground font-bold mb-1">
                    Password
                  </label>
                  <input
                    type="password"
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    className="w-full bg-charcoal border border-border px-3 py-2 text-sand text-sm rounded focus:outline-none focus:border-pickle"
                  />
                </div>

                <button
                  type="submit"
                  disabled={isLoading || !email.trim() || !password.trim()}
                  className="w-full bg-brick py-2.5 text-xs font-bold uppercase tracking-widest text-sand hover:bg-brick-deep transition-all cursor-pointer rounded disabled:opacity-50 mt-2"
                >
                  {isLoading ? "Signing In..." : "Sign In to Account"}
                </button>
              </form>
            </div>
          )}

          {/* TAB 2: REGISTER */}
          {tab === "register" && (
            <form onSubmit={handleRegister} className="space-y-3">
              <div>
                <label className="block text-[0.65rem] uppercase tracking-wider text-muted-foreground font-bold mb-1">
                  Designated Role
                </label>
                <div className="grid grid-cols-2 gap-2">
                  <button
                    type="button"
                    onClick={() => setRegRole("umpire")}
                    className={`py-2 text-xs font-bold uppercase tracking-wider rounded border transition-colors cursor-pointer ${
                      regRole === "umpire"
                        ? "bg-charcoal border-pickle text-sand"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Match Official
                  </button>
                  <button
                    type="button"
                    onClick={() => setRegRole("admin")}
                    className={`py-2 text-xs font-bold uppercase tracking-wider rounded border transition-colors cursor-pointer ${
                      regRole === "admin"
                        ? "bg-charcoal border-pickle text-sand"
                        : "border-border text-muted-foreground hover:text-foreground"
                    }`}
                  >
                    Organizer / Admin
                  </button>
                </div>
              </div>

              <div>
                <label className="block text-[0.65rem] uppercase tracking-wider text-muted-foreground font-bold mb-1">
                  Full Name
                </label>
                <input
                  type="text"
                  value={regName}
                  onChange={(e) => setRegName(e.target.value)}
                  placeholder="e.g. Alex Morgan"
                  required
                  className="w-full bg-charcoal border border-border px-3 py-2 text-sand text-sm rounded focus:outline-none focus:border-pickle"
                />
              </div>

              <div>
                <label className="block text-[0.65rem] uppercase tracking-wider text-muted-foreground font-bold mb-1">
                  Email Address
                </label>
                <input
                  type="email"
                  value={regEmail}
                  onChange={(e) => setRegEmail(e.target.value)}
                  placeholder="alex@dinkvalley.com"
                  required
                  className="w-full bg-charcoal border border-border px-3 py-2 text-sand text-sm rounded focus:outline-none focus:border-pickle"
                />
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-2">
                <div>
                  <label className="block text-[0.65rem] uppercase tracking-wider text-muted-foreground font-bold mb-1">
                    Password
                  </label>
                  <input
                    type="password"
                    value={regPassword}
                    onChange={(e) => setRegPassword(e.target.value)}
                    placeholder="Min 6 characters"
                    required
                    className="w-full bg-charcoal border border-border px-3 py-2 text-sand text-sm rounded focus:outline-none focus:border-pickle"
                  />
                </div>
                <div>
                  <label className="block text-[0.65rem] uppercase tracking-wider text-muted-foreground font-bold mb-1">
                    Confirm Password
                  </label>
                  <input
                    type="password"
                    value={regConfirmPassword}
                    onChange={(e) => setRegConfirmPassword(e.target.value)}
                    placeholder="Repeat password"
                    required
                    className="w-full bg-charcoal border border-border px-3 py-2 text-sand text-sm rounded focus:outline-none focus:border-pickle"
                  />
                </div>
              </div>

              <div>
                <label className="block text-[0.65rem] uppercase tracking-wider text-muted-foreground font-bold mb-1">
                  Required Official Access Code
                </label>
                <input
                  type="text"
                  value={regAccessCode}
                  onChange={(e) => setRegAccessCode(e.target.value)}
                  placeholder="Issued by tournament director"
                  required
                  className="w-full bg-charcoal border border-border px-3 py-2 text-sand font-mono uppercase tracking-widest text-sm rounded focus:outline-none focus:border-pickle"
                />
                <p className="mt-1 text-[0.65rem] text-muted-foreground">
                  Registration requires an unused access code created by tournament administration.
                </p>
              </div>

              <button
                type="submit"
                disabled={isLoading}
                className="w-full bg-brick py-2.5 text-xs font-bold uppercase tracking-widest text-sand hover:bg-brick-deep transition-all cursor-pointer rounded disabled:opacity-50 mt-2"
              >
                {isLoading ? "Creating Account..." : "Certify & Register Official"}
              </button>
            </form>
          )}
        </div>

        {/* Footer info */}
        <div className="border-t border-border px-5 py-3 bg-charcoal text-center text-[0.7rem] text-sand/50">
          Santiago City Pickleball Club &middot; Authorized tournament terminal
        </div>
      </div>
    </div>
  );
}
