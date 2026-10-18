import { createFileRoute, useNavigate, Link } from "@tanstack/react-router";
import { useState } from "react";
import {
  loginWithCredentials,
  registerStaffAccount,
  type StaffRole as Role,
} from "@/lib/auth-store";

export const Route = createFileRoute("/login")({
  component: Login,
});

function Login() {
  const navigate = useNavigate({ from: "/login" });
  const [mode, setMode] = useState<"login" | "register">("login");
  const [name, setName] = useState("");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [selectedRole, setSelectedRole] = useState<Role>("umpire");
  const [accessCode, setAccessCode] = useState("");
  const [detectedRole, setDetectedRole] = useState<Role | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState("");

  const handleLogin = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const cleanEmail = email.trim().toLowerCase();
    const cleanPassword = password.trim();

    if (!cleanEmail || !cleanPassword) {
      setError("Please enter your email and password.");
      return;
    }

    setIsLoading(true);
    const res = await loginWithCredentials(cleanEmail, cleanPassword);

    if (!res.success || !res.role) {
      setIsLoading(false);
      setError(res.error || "Invalid credentials. Check your email and password.");
      return;
    }

    setDetectedRole(res.role);
    setTimeout(() => {
      if (res.role === "admin") {
        navigate({ to: "/admin" });
      } else {
        navigate({ to: "/umpire" });
      }
    }, 1200);
  };

  const handleRegister = async (e: React.FormEvent) => {
    e.preventDefault();
    setError("");

    const cleanName = name.trim();
    const cleanEmail = email.trim().toLowerCase();
    const cleanPassword = password.trim();
    const cleanCode = accessCode.trim().toUpperCase();

    if (!cleanName || !cleanEmail || !cleanPassword) {
      setError("Full Name, Email, and Password are required.");
      return;
    }

    if (!cleanCode) {
      setError("Official access code is required to register.");
      return;
    }

    setIsLoading(true);
    const res = await registerStaffAccount({
      name: cleanName,
      email: cleanEmail,
      password: cleanPassword,
      role: selectedRole,
      accessCode: cleanCode,
    });

    if (!res.success) {
      setIsLoading(false);
      setError(res.error || "Registration failed. Please verify your access code.");
      return;
    }

    setDetectedRole(selectedRole);
    setTimeout(() => {
      if (selectedRole === "admin") {
        navigate({ to: "/admin" });
      } else {
        navigate({ to: "/umpire" });
      }
    }, 1200);
  };

  return (
    <div className="court-lines flex min-h-[calc(100vh-4rem)] items-center justify-center px-4 py-12">
      <div className="w-full max-w-md">
        {isLoading ? (
          /* Loading / Authenticating View */
          <div className="surface-card bg-charcoal p-8 border-2 border-pickle text-center space-y-6">
            <div className="flex justify-center">
              <div className="relative">
                <img
                  src="/DinkValley.jpg"
                  alt="Dink Valley"
                  className="h-24 w-24 animate-spin rounded-full object-cover ring-4 ring-pickle ring-offset-4 ring-offset-charcoal"
                  style={{ animationDuration: "2.2s" }}
                />
              </div>
            </div>
            <div>
              <span className="text-[0.6rem] uppercase tracking-[0.3em] font-bold text-pickle block mb-1">
                Role Detected: {detectedRole === "admin" ? "Organizer Admin" : "Live Match Official"}
              </span>
              <h2 className="font-display text-3xl text-sand tracking-wider animate-pulse">
                Authenticating
              </h2>
              <p className="text-xs text-sand/70 mt-1 font-medium">
                Redirecting to {detectedRole === "admin" ? "Admin Console" : "Umpire Dashboard"}...
              </p>
            </div>
          </div>
        ) : (
          <>
            {/* Header */}
            <div className="mb-6 text-center">
              <img
                src="/DinkValley.jpg"
                alt="Dink Valley Logo"
                className="mx-auto mb-3 h-16 w-16 rounded-full object-cover ring-2 ring-brick ring-offset-2 ring-offset-charcoal"
              />
              <span className="block text-[0.65rem] uppercase tracking-[0.28em] text-pickle font-bold">
                Dink Valley Official Portal
              </span>
              <h1 className="mt-1 font-display text-4xl sm:text-5xl leading-none text-sand">
                {mode === "login" ? "Sign In" : "Register Account"}
              </h1>
              <p className="mt-2 text-xs text-sand/80 font-medium">
                {mode === "login"
                  ? "Enter your credentials. Role will be automatically detected."
                  : "Register as an Admin Organizer or Live Match Official."}
              </p>
            </div>



            {/* Card */}
            <div className="surface-card bg-charcoal p-6 sm:p-8 border border-border shadow-xl">
              {error && (
                <div className="mb-5 border border-brick/60 bg-brick/15 px-4 py-3 text-xs text-brick font-bold">
                  {error}
                </div>
              )}

              <form
                onSubmit={mode === "login" ? handleLogin : handleRegister}
                className="space-y-4"
              >
                {/* Name field (register only) */}
                {mode === "register" && (
                  <label className="block">
                    <span className="mb-1 block text-xs font-bold uppercase tracking-widest text-sand">
                      Full Name
                    </span>
                    <input
                      id="user-name"
                      type="text"
                      required
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                      placeholder="Juan Dela Cruz"
                      className="w-full border border-border bg-background/20 px-4 py-3 text-sand placeholder:text-sand/40 focus:border-pickle focus:outline-none transition-colors text-sm"
                    />
                  </label>
                )}

                {/* Email field */}
                <label className="block">
                  <span className="mb-1 block text-xs font-bold uppercase tracking-widest text-sand">
                    Email Address
                  </span>
                  <input
                    id="auth-email"
                    type="email"
                    required
                    value={email}
                    onChange={(e) => setEmail(e.target.value)}
                    placeholder="admin@dinkvalley.com or umpire@dinkvalley.com"
                    className="w-full border border-border bg-background/20 px-4 py-3 text-sand placeholder:text-sand/40 focus:border-pickle focus:outline-none transition-colors text-sm"
                  />
                </label>

                {/* Password field */}
                <label className="block">
                  <span className="mb-1 block text-xs font-bold uppercase tracking-widest text-sand">
                    Password
                  </span>
                  <input
                    id="auth-password"
                    type="password"
                    required
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    placeholder="••••••••"
                    className="w-full border border-border bg-background/20 px-4 py-3 text-sand placeholder:text-sand/40 focus:border-pickle focus:outline-none transition-colors text-sm"
                  />
                </label>

                {/* Registration additional fields */}
                {mode === "register" && (
                  <>
                    <div>
                      <span className="mb-1.5 block text-xs font-bold uppercase tracking-widest text-sand">
                        Account Role
                      </span>
                      <div className="grid grid-cols-2 gap-2">
                        <button
                          type="button"
                          onClick={() => setSelectedRole("umpire")}
                          className={`py-2.5 px-3 text-xs font-bold uppercase tracking-wider border transition-all cursor-pointer ${
                            selectedRole === "umpire"
                              ? "bg-pickle text-sand border-pickle"
                              : "bg-background/10 text-sand/70 border-border hover:border-sand"
                          }`}
                        >
                          Umpire / Official
                        </button>

                        <button
                          type="button"
                          onClick={() => setSelectedRole("admin")}
                          className={`py-2.5 px-3 text-xs font-bold uppercase tracking-wider border transition-all cursor-pointer ${
                            selectedRole === "admin"
                              ? "bg-brick text-sand border-brick"
                              : "bg-background/10 text-sand/70 border-border hover:border-sand"
                          }`}
                        >
                          Admin / Director
                        </button>
                      </div>
                    </div>

                    <label className="block">
                      <span className="mb-1 block text-xs font-bold uppercase tracking-widest text-sand">
                        Verification Access Code <span className="text-pickle font-bold">*</span>
                      </span>
                      <input
                        id="access-code"
                        type="text"
                        required
                        value={accessCode}
                        onChange={(e) => setAccessCode(e.target.value)}
                        placeholder="Enter code provided by administrator"
                        className="w-full border border-border bg-background/20 px-4 py-2.5 text-sand uppercase placeholder:text-sand/40 focus:border-pickle focus:outline-none transition-colors text-xs font-mono"
                      />
                    </label>
                  </>
                )}

                {/* Submit button */}
                <button
                  id="auth-submit-btn"
                  type="submit"
                  className="mt-2 w-full bg-brick px-4 py-4 font-display text-2xl tracking-widest text-sand transition-all hover:bg-brick-deep active:scale-[0.98] cursor-pointer shadow-md"
                >
                  {mode === "login" ? "Sign In" : "Register Account"}
                </button>
              </form>

              {/* Link to Register page */}
              <div className="mt-5 pt-4 border-t border-border/80 text-center">
                <Link
                  to="/register"
                  className="text-xs text-pickle hover:text-pickle/80 underline underline-offset-2 transition-colors cursor-pointer font-bold uppercase tracking-wider"
                >
                  Need an official account? Register as Admin or Umpire &rarr;
                </Link>
              </div>
            </div>

            <p className="mt-4 text-center text-[0.65rem] uppercase tracking-widest text-sand/60 font-mono">
              Dink Valley Tournament Management System
            </p>
          </>
        )}
      </div>
    </div>
  );
}
