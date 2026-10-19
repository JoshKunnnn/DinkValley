import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState, useMemo } from "react";
import { registerStaffAccount, type StaffRole as Role } from "@/lib/auth-store";
import { detectRoleFromCode, getAccessCodes } from "@/lib/access-codes";

export const Route = createFileRoute("/register")({
  component: Register,
});

function Register() {
  const navigate = useNavigate();
  const [selectedRole, setSelectedRole] = useState<Role>("admin");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [accessCode, setAccessCode] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [successNotice, setSuccessNotice] = useState("");

  // Live code analysis
  const codeAnalysis = useMemo(() => {
    const clean = accessCode.trim().toUpperCase();
    if (!clean) return { detectedRole: null, isValidFormat: false, matchFound: false };

    const detected = detectRoleFromCode(clean);
    const allCodes = getAccessCodes();
    const match = allCodes.find((c) => c.code.toUpperCase() === clean);

    return {
      detectedRole: detected,
      isValidFormat: clean.length >= 6,
      matchFound: Boolean(match),
    };
  }, [accessCode]);

  // Handle access code input and auto-sync role if detected
  const handleCodeChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const clean = e.target.value.toUpperCase();
    setAccessCode(clean);
    setError("");

    const detected = detectRoleFromCode(clean);
    if (detected) {
      setSelectedRole(detected);
    }
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");
    setSuccessNotice("");

    const cleanName = name.trim();
    const cleanEmail = email.trim().toLowerCase();
    const cleanPassword = password.trim();
    const cleanCode = accessCode.trim().toUpperCase();

    if (!cleanName || !cleanEmail || !cleanPassword) {
      setError("Please fill in all required fields.");
      return;
    }

    if (cleanPassword.length < 6) {
      setError("Password must be at least 6 characters.");
      return;
    }

    if (cleanPassword !== confirmPassword.trim()) {
      setError("Passwords do not match.");
      return;
    }

    if (!cleanCode) {
      setError("Official access code is required.");
      return;
    }

    setIsLoading(true);

    try {
      const res = await registerStaffAccount({
        name: cleanName,
        email: cleanEmail,
        password: cleanPassword,
        role: selectedRole,
        accessCode: cleanCode,
      });

      if (!res.success) {
        setError(res.error || "Failed to register official account. Please check your access code.");
        setIsLoading(false);
        return;
      }

      const certifiedRole = res.role || selectedRole;
      setSuccessNotice(
        `Registration successful. Certified as ${certifiedRole === "admin" ? "Tournament Director (Admin)" : "Match Official (Umpire)"}. Redirecting...`
      );

      setTimeout(() => {
        if (certifiedRole === "admin") {
          navigate({ to: "/admin" });
        } else {
          navigate({ to: "/umpire" });
        }
      }, 1200);
    } catch (err: any) {
      setError(err?.message || "Failed to complete registration.");
      setIsLoading(false);
    }
  };

  return (
    <div className="court-lines flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 py-8 sm:py-12">
      <div className="w-full max-w-xl">
        {/* Header */}
        <div className="mb-6 text-center">
          <img
            src="/DinkValley.jpg"
            alt="Dink Valley Logo"
            className="mx-auto mb-3 h-16 w-16 rounded-full object-cover ring-2 ring-brick ring-offset-2 ring-offset-charcoal"
          />
          <span className="block text-[0.65rem] uppercase tracking-[0.28em] text-pickle font-bold">
            Dink Valley Tournament Staff
          </span>
          <h1 className="mt-1 font-display text-3xl sm:text-5xl leading-none text-sand">
            Admin &amp; Umpire Registration
          </h1>
          <p className="mt-2 text-xs sm:text-sm text-sand/80 font-medium max-w-md mx-auto">
            Unified official portal. Enter your security authorization code to certify your role as Tournament Director or Match Official.
          </p>
        </div>

        {/* Card */}
        <div className="surface-card bg-charcoal p-6 sm:p-8 border border-border shadow-2xl">
          {error && (
            <div className="mb-5 border border-brick/60 bg-brick/15 px-4 py-3 text-xs text-brick font-bold">
              {error}
            </div>
          )}

          {successNotice && (
            <div className="mb-5 border border-pickle/60 bg-pickle/15 px-4 py-3 text-xs text-pickle font-bold animate-pulse">
              {successNotice}
            </div>
          )}

          <form onSubmit={handleRegister} className="space-y-4">
            {/* Unified Role Selector */}
            <div>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-bold uppercase tracking-wider text-sand">
                  Certified Role:
                </span>
                {codeAnalysis.detectedRole && (
                  <span
                    className={`text-[0.65rem] font-bold uppercase tracking-widest px-2 py-0.5 border ${
                      codeAnalysis.detectedRole === "admin"
                        ? "border-brick text-brick bg-brick/10"
                        : "border-pickle text-pickle bg-pickle/10"
                    }`}
                  >
                    Auto-Detected from Code
                  </span>
                )}
              </div>

              <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
                {/* Admin Option */}
                <button
                  type="button"
                  onClick={() => setSelectedRole("admin")}
                  className={`p-3.5 border text-left transition-all cursor-pointer ${
                    selectedRole === "admin"
                      ? "bg-brick/20 border-brick text-sand ring-1 ring-brick"
                      : "bg-background/10 border-border text-sand/70 hover:border-sand/40"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-brick">
                      Tournament Director
                    </span>
                    {selectedRole === "admin" && (
                      <span className="h-2 w-2 rounded-full bg-brick animate-ping" />
                    )}
                  </div>
                  <span className="block text-[0.7rem] text-sand/70 mt-1 font-sans">
                    Admin Console, Brackets, Schedules, Access Codes
                  </span>
                </button>

                {/* Umpire Option */}
                <button
                  type="button"
                  onClick={() => setSelectedRole("umpire")}
                  className={`p-3.5 border text-left transition-all cursor-pointer ${
                    selectedRole === "umpire"
                      ? "bg-pickle/20 border-pickle text-sand ring-1 ring-pickle"
                      : "bg-background/10 border-border text-sand/70 hover:border-sand/40"
                  }`}
                >
                  <div className="flex items-center justify-between">
                    <span className="text-xs font-bold uppercase tracking-wider text-pickle">
                      Match Official
                    </span>
                    {selectedRole === "umpire" && (
                      <span className="h-2 w-2 rounded-full bg-pickle animate-ping" />
                    )}
                  </div>
                  <span className="block text-[0.7rem] text-sand/70 mt-1 font-sans">
                    Umpire Dashboard, Live Scoring, Courts 1-4
                  </span>
                </button>
              </div>
            </div>

            {/* Official Access Code */}
            <div className="pt-1">
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-bold uppercase tracking-wider text-sand">
                  Official Access Code <span className="text-brick font-bold">*</span>
                </label>
                <span className="text-[0.65rem] text-sand/60 font-mono">
                  Required for certification
                </span>
              </div>

              <div className="relative">
                <input
                  type="text"
                  required
                  value={accessCode}
                  onChange={handleCodeChange}
                  placeholder="e.g. ADM-4921, UMP-2026, or DV-ADMIN"
                  className={`w-full border bg-background/20 px-3.5 py-3 text-sm font-mono uppercase tracking-widest text-sand placeholder:text-sand/40 focus:outline-none transition-colors ${
                    codeAnalysis.detectedRole === "admin"
                      ? "border-brick focus:border-brick"
                      : codeAnalysis.detectedRole === "umpire"
                        ? "border-pickle focus:border-pickle"
                        : "border-border focus:border-pickle"
                  }`}
                />
                {codeAnalysis.detectedRole && (
                  <span
                    className={`absolute right-3 top-1/2 -translate-y-1/2 text-[0.65rem] font-bold uppercase tracking-wider px-2 py-0.5 border ${
                      codeAnalysis.detectedRole === "admin"
                        ? "border-brick text-brick bg-charcoal"
                        : "border-pickle text-pickle bg-charcoal"
                    }`}
                  >
                    {codeAnalysis.detectedRole === "admin" ? "Admin Code" : "Umpire Code"}
                  </span>
                )}
              </div>

              <div className="mt-1.5 flex flex-col sm:flex-row sm:items-center sm:justify-between gap-1 text-[0.7rem]">
                <span className="text-sand/60">
                  Codes are generated by organizers in the Admin Console.
                </span>
                <span className="font-mono text-sand/70 text-[0.65rem]">
                  Accepts ADM-*, UMP-*, DV-ADMIN, UMP-2026
                </span>
              </div>
            </div>

            {/* Full Name */}
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-sand mb-1.5">
                Full Name <span className="text-brick font-bold">*</span>
              </label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Maria Santos"
                className="w-full border border-border bg-background/20 px-3.5 py-2.5 text-sm text-sand placeholder:text-sand/40 focus:border-pickle focus:outline-none transition-colors"
              />
            </div>

            {/* Email Address */}
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-sand mb-1.5">
                Email Address <span className="text-brick font-bold">*</span>
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={selectedRole === "admin" ? "director@dinkvalley.com" : "official@dinkvalley.com"}
                className="w-full border border-border bg-background/20 px-3.5 py-2.5 text-sm text-sand placeholder:text-sand/40 focus:border-pickle focus:outline-none transition-colors"
              />
            </div>

            {/* Password Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-sand mb-1.5">
                  Password <span className="text-brick font-bold">*</span>
                </label>
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Min 6 characters"
                  className="w-full border border-border bg-background/20 px-3.5 py-2.5 text-sm text-sand placeholder:text-sand/40 focus:border-pickle focus:outline-none transition-colors"
                />
              </div>
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-sand mb-1.5">
                  Confirm Password <span className="text-brick font-bold">*</span>
                </label>
                <input
                  type={showPassword ? "text" : "password"}
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter password"
                  className="w-full border border-border bg-background/20 px-3.5 py-2.5 text-sm text-sand placeholder:text-sand/40 focus:border-pickle focus:outline-none transition-colors"
                />
              </div>
            </div>

            {/* Password visibility toggle */}
            <div className="flex items-center justify-between text-xs text-sand/70 pt-0.5">
              <label className="flex items-center gap-2 cursor-pointer select-none">
                <input
                  type="checkbox"
                  checked={showPassword}
                  onChange={(e) => setShowPassword(e.target.checked)}
                  className="h-3.5 w-3.5 accent-pickle rounded"
                />
                <span>Show passwords</span>
              </label>
              {password && confirmPassword && (
                <span className={password === confirmPassword ? "text-pickle font-bold" : "text-brick font-bold"}>
                  {password === confirmPassword ? "Passwords match" : "Passwords do not match"}
                </span>
              )}
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isLoading}
              className={`mt-4 w-full py-4 px-6 font-display text-2xl tracking-widest transition-all cursor-pointer shadow-md active:scale-[0.99] disabled:opacity-50 ${
                selectedRole === "admin"
                  ? "bg-brick text-sand hover:bg-brick-deep"
                  : "bg-pickle text-sand hover:opacity-90"
              }`}
            >
              {isLoading
                ? "Certifying Account..."
                : `Certify as ${selectedRole === "admin" ? "Tournament Director" : "Match Official"}`}
            </button>
          </form>

          {/* Footer Navigation */}
          <div className="mt-6 pt-4 border-t border-border flex flex-col sm:flex-row items-center justify-between gap-2 text-center">
            <Link
              to="/login"
              className="text-xs uppercase tracking-wider text-sand/70 hover:text-pickle font-bold transition-colors"
            >
              Already certified? Sign In &rarr;
            </Link>
            <Link
              to="/"
              className="text-xs uppercase tracking-wider text-sand/50 hover:text-sand font-medium transition-colors"
            >
              Back to Tournament Portal
            </Link>
          </div>
        </div>

        <p className="mt-4 text-center text-[0.65rem] uppercase tracking-widest text-sand/60 font-mono">
          Santiago City Pickleball Club &middot; Official Tournament Management System
        </p>
      </div>
    </div>
  );
}
