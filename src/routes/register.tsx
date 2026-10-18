import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import { registerStaffAccount, type StaffRole as Role } from "@/lib/auth-store";

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
  const [error, setError] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [successNotice, setSuccessNotice] = useState("");

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

      setSuccessNotice(`Registration successful! Account certified as ${selectedRole === "admin" ? "Tournament Director" : "Match Official"}.`);

      setTimeout(() => {
        if (selectedRole === "admin") {
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
    <div className="court-lines flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 py-12">
      <div className="w-full max-w-lg">
        {/* Header */}
        <div className="mb-6 text-center">
          <img
            src="/DinkValley.jpg"
            alt="Dink Valley Logo"
            className="mx-auto mb-3 h-16 w-16 rounded-full object-cover ring-2 ring-brick ring-offset-2 ring-offset-charcoal"
          />
          <span className="block text-[0.65rem] uppercase tracking-[0.28em] text-pickle font-bold">
            Staff &amp; Official Registration
          </span>
          <h1 className="mt-1 font-display text-4xl sm:text-5xl leading-none text-sand">
            Create Official Account
          </h1>
          <p className="mt-2 text-xs text-sand/80 font-medium">
            Authorized portal for Club Tournament Directors and Certified Match Umpires.
          </p>
        </div>

        {/* Card */}
        <div className="surface-card bg-card p-6 sm:p-8 border border-border rounded-xl shadow-xl">
          {error && (
            <div className="mb-5 rounded border border-brick/60 bg-brick/15 px-4 py-3 text-xs text-brick font-bold">
              {error}
            </div>
          )}

          {successNotice && (
            <div className="mb-5 rounded border border-pickle/60 bg-pickle/15 px-4 py-3 text-xs text-pickle font-bold animate-pulse">
              {successNotice}
            </div>
          )}

          {/* Role Selection Tabs */}
          <div className="mb-6">
            <span className="mb-2 block text-xs font-bold uppercase tracking-wider text-foreground">
              Select Official Role:
            </span>
            <div className="grid grid-cols-2 gap-3">
              {/* Admin Card */}
              <button
                type="button"
                onClick={() => {
                  setSelectedRole("admin");
                  setAccessCode("");
                  setError("");
                }}
                className={`p-3.5 rounded-lg border text-left transition-all cursor-pointer ${
                  selectedRole === "admin"
                    ? "bg-brick/15 border-brick text-foreground ring-2 ring-brick/30"
                    : "bg-background/60 border-border text-foreground/70 hover:border-foreground/30"
                }`}
              >
                <span className="block text-xs font-bold uppercase tracking-wider text-brick">
                  Tournament Director
                </span>
                <span className="block text-[0.7rem] text-muted-foreground mt-0.5">
                  Admin Console &middot; Brackets &middot; Dispatch
                </span>
              </button>

              {/* Umpire Card */}
              <button
                type="button"
                onClick={() => {
                  setSelectedRole("umpire");
                  setAccessCode("");
                  setError("");
                }}
                className={`p-3.5 rounded-lg border text-left transition-all cursor-pointer ${
                  selectedRole === "umpire"
                    ? "bg-pickle/15 border-pickle text-foreground ring-2 ring-pickle/30"
                    : "bg-background/60 border-border text-foreground/70 hover:border-foreground/30"
                }`}
              >
                <span className="block text-xs font-bold uppercase tracking-wider text-pickle">
                  Match Official
                </span>
                <span className="block text-[0.7rem] text-muted-foreground mt-0.5">
                  Umpire Dashboard &middot; Courts 1–4
                </span>
              </button>
            </div>
          </div>

          <form onSubmit={handleRegister} className="space-y-4">
            {/* Full Name */}
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-foreground mb-1.5">
                Full Name <span className="text-brick">*</span>
              </label>
              <input
                type="text"
                required
                value={name}
                onChange={(e) => setName(e.target.value)}
                placeholder="e.g. Maria Santos"
                className="w-full rounded-md border border-input bg-background/60 px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-pickle focus:ring-2 focus:ring-pickle/20 focus:outline-none transition-all"
              />
            </div>

            {/* Email Address */}
            <div>
              <label className="block text-xs font-bold uppercase tracking-wider text-foreground mb-1.5">
                Email Address <span className="text-brick">*</span>
              </label>
              <input
                type="email"
                required
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                placeholder={selectedRole === "admin" ? "director@dinkvalley.com" : "official@dinkvalley.com"}
                className="w-full rounded-md border border-input bg-background/60 px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-pickle focus:ring-2 focus:ring-pickle/20 focus:outline-none transition-all"
              />
            </div>

            {/* Password Grid */}
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-foreground mb-1.5">
                  Password <span className="text-brick">*</span>
                </label>
                <input
                  type="password"
                  required
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="At least 6 characters"
                  className="w-full rounded-md border border-input bg-background/60 px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-pickle focus:ring-2 focus:ring-pickle/20 focus:outline-none transition-all"
                />
              </div>
              <div>
                <label className="block text-xs font-bold uppercase tracking-wider text-foreground mb-1.5">
                  Confirm Password <span className="text-brick">*</span>
                </label>
                <input
                  type="password"
                  required
                  value={confirmPassword}
                  onChange={(e) => setConfirmPassword(e.target.value)}
                  placeholder="Re-enter password"
                  className="w-full rounded-md border border-input bg-background/60 px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted-foreground/60 focus:border-pickle focus:ring-2 focus:ring-pickle/20 focus:outline-none transition-all"
                />
              </div>
            </div>

            {/* Verification Access Code */}
            <div className="pt-2">
              <div className="flex items-center justify-between mb-1.5">
                <label className="block text-xs font-bold uppercase tracking-wider text-foreground">
                  Official Access Code <span className="text-brick">*</span>
                </label>
                <span className="text-[0.65rem] text-muted-foreground">
                  Security authorization code
                </span>
              </div>
              <input
                type="text"
                required
                value={accessCode}
                onChange={(e) => setAccessCode(e.target.value.toUpperCase())}
                placeholder="Enter access code provided by admin"
                className="w-full rounded-md border border-input bg-background/60 px-3.5 py-2.5 text-xs font-mono uppercase text-foreground placeholder:text-muted-foreground/60 focus:border-pickle focus:ring-2 focus:ring-pickle/20 focus:outline-none transition-all"
              />
              <p className="mt-1.5 text-[0.7rem] text-muted-foreground">
                Access codes are generated by Tournament Directors in the Admin Console. Contact your organizer to obtain one.
              </p>
            </div>

            {/* Submit Button */}
            <button
              type="submit"
              disabled={isLoading}
              className={`mt-4 w-full py-3.5 px-6 font-display text-2xl tracking-widest transition-all rounded shadow-md cursor-pointer ${
                selectedRole === "admin"
                  ? "bg-brick text-sand hover:bg-brick-deep active:scale-[0.98]"
                  : "bg-pickle text-sand hover:opacity-90 active:scale-[0.98]"
              }`}
            >
              {isLoading ? "Certifying Account..." : `Register as ${selectedRole === "admin" ? "Tournament Director" : "Match Official"}`}
            </button>
          </form>

          {/* Footer Link */}
          <div className="mt-6 pt-4 border-t border-border text-center">
            <Link
              to="/login"
              className="text-xs uppercase tracking-wider text-muted-foreground hover:text-foreground font-semibold transition-colors"
            >
              Already have an account? Sign In &rarr;
            </Link>
          </div>
        </div>

        <p className="mt-4 text-center text-[0.65rem] uppercase tracking-widest text-sand/60 font-mono">
          Dink Valley Tournament Management System &middot; Santiago City
        </p>
      </div>
    </div>
  );
}
