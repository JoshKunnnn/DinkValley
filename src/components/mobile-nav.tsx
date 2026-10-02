import { useRouterState, useNavigate } from "@tanstack/react-router";
import { useRef, useState, useEffect } from "react";
import {
  Home,
  Trophy,
  Building2,
  Users,
  User,
} from "lucide-react";
import { getAuthenticatedStaff, type StaffRole } from "@/lib/auth-store";
import { StaffPortalModal } from "./admin/StaffPortalModal";
import { PlayerDirectoryModal } from "./PlayerDirectoryModal";

export function MobileNav() {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const navigate = useNavigate();
  const [authRole, setAuthRole] = useState<StaffRole | null>(null);
  const [showStaffModal, setShowStaffModal] = useState(false);
  const [showPlayerDirectoryModal, setShowPlayerDirectoryModal] = useState(false);
  const [activeId, setActiveId] = useState("home");

  const tapCountRef = useRef(0);
  const tapTimerRef = useRef<NodeJS.Timeout | null>(null);

  // Hide on admin / umpire routes — staff have their own full bottom nav
  const isConsole =
    pathname.startsWith("/admin") || pathname.startsWith("/umpire");

  useEffect(() => {
    const checkAuth = () => {
      const staff = getAuthenticatedStaff();
      setAuthRole(staff ? staff.role : null);
    };
    checkAuth();
    window.addEventListener("storage", checkAuth);
    window.addEventListener("dv_auth_changed", checkAuth);
    return () => {
      window.removeEventListener("storage", checkAuth);
      window.removeEventListener("dv_auth_changed", checkAuth);
    };
  }, []);

  // Player directory modal event listener
  useEffect(() => {
    const handleOpenPlayerDir = () => setShowPlayerDirectoryModal(true);
    window.addEventListener("dv_open_player_directory", handleOpenPlayerDir);
    return () => window.removeEventListener("dv_open_player_directory", handleOpenPlayerDir);
  }, []);

  // Scroll spy to update active tab based on scroll position on the landing page
  useEffect(() => {
    if (pathname !== "/") {
      setActiveId("");
      return;
    }

    const handleScroll = () => {
      const scrollY = window.scrollY;
      if (scrollY < 120) {
        setActiveId("home");
        return;
      }

      // Check sections from bottom of page upwards
      const sections = [
        { id: "tournaments", navId: "tournaments" },
        { id: "facility", navId: "facility" },
      ];

      const triggerY = scrollY + window.innerHeight * 0.35;

      for (const s of sections) {
        const el = document.getElementById(s.id);
        if (el && el.offsetTop <= triggerY) {
          setActiveId(s.navId);
          return;
        }
      }

      setActiveId("home");
    };

    handleScroll();
    window.addEventListener("scroll", handleScroll, { passive: true });
    return () => window.removeEventListener("scroll", handleScroll);
  }, [pathname]);

  const navigateToSection = (sectionId: string) => {
    setActiveId(sectionId);

    if (sectionId === "home") {
      if (pathname === "/") {
        window.scrollTo({ top: 0, behavior: "smooth" });
        if (window.location.hash) {
          history.replaceState(null, "", window.location.pathname);
        }
      } else {
        navigate({ to: "/" });
      }
      return;
    }

    if (pathname === "/") {
      const el = document.getElementById(sectionId);
      if (el) {
        el.scrollIntoView({ behavior: "smooth", block: "start" });
        history.replaceState(null, "", `#${sectionId}`);
      }
    } else {
      window.location.href = `/#${sectionId}`;
    }
  };

  const handlePlayersClick = () => {
    setActiveId("players");
    setShowPlayerDirectoryModal(true);
  };

  const handleMeTap = () => {
    if (authRole) {
      // Already logged in — navigate to staff console
      window.location.href = authRole === "admin" ? "/admin" : "/umpire";
      return;
    }
    // Quadruple-tap detection: 4 taps within 1.8s reveals staff portal
    tapCountRef.current += 1;
    if (tapTimerRef.current) clearTimeout(tapTimerRef.current);
    if (tapCountRef.current >= 4) {
      tapCountRef.current = 0;
      setShowStaffModal(true);
      return;
    }
    tapTimerRef.current = setTimeout(() => {
      tapCountRef.current = 0;
    }, 1800);
  };

  if (isConsole) return null;

  return (
    <>
      {/* Bottom Nav Bar */}
      <nav
        role="navigation"
        aria-label="Mobile navigation"
        className="fixed bottom-0 inset-x-0 z-50 sm:hidden"
      >
        {/* Gradient blur fade at top edge */}
        <div className="absolute inset-x-0 -top-4 h-4 bg-gradient-to-t from-charcoal/60 to-transparent pointer-events-none" />

        <div
          className="
            relative
            bg-charcoal/96 backdrop-blur-md
            border-t border-white/10
            grid grid-cols-5
            pb-[env(safe-area-inset-bottom,0.75rem)]
          "
          style={{ boxShadow: "0 -4px 24px rgba(0,0,0,0.45)" }}
        >
          {/* 1. Home */}
          <MobileNavItem
            id="home"
            label="Home"
            icon={Home}
            isActive={activeId === "home" && pathname === "/"}
            onClick={() => navigateToSection("home")}
          />

          {/* 2. Events (scrolls to #tournaments) */}
          <MobileNavItem
            id="tournaments"
            label="Events"
            icon={Trophy}
            isActive={activeId === "tournaments"}
            onClick={() => navigateToSection("tournaments")}
          />

          {/* 3. Facility (scrolls to #facility) */}
          <MobileNavItem
            id="facility"
            label="Facility"
            icon={Building2}
            isActive={activeId === "facility"}
            onClick={() => navigateToSection("facility")}
          />

          {/* 4. Players (player directory modal) */}
          <MobileNavItem
            id="players"
            label="Players"
            icon={Users}
            isActive={activeId === "players" || showPlayerDirectoryModal}
            onClick={handlePlayersClick}
          />

          {/* 5. Me / Staff Console */}
          <button
            id="mobile-nav-me"
            aria-label={authRole ? "Go to staff console" : "Staff portal"}
            onClick={handleMeTap}
            className="relative flex flex-col items-center justify-center gap-1 pt-3 pb-1 transition-all select-none cursor-pointer"
          >
            {/* Active indicator pill */}
            {(activeId === "me" || showStaffModal) && (
              <span
                className="absolute top-0 left-1/2 -translate-x-1/2 h-0.5 w-8 bg-pickle rounded-full"
                style={{ boxShadow: "0 0 6px rgba(34,197,94,0.7)" }}
              />
            )}

            {/* Staff online status indicator dot */}
            {authRole && (
              <span className="absolute top-2.5 right-[calc(50%-0.6rem)] h-2 w-2 rounded-full bg-pickle border-2 border-charcoal animate-pulse" />
            )}

            <User
              size={20}
              strokeWidth={activeId === "me" || showStaffModal ? 2.5 : 1.75}
              className={
                activeId === "me" || showStaffModal
                  ? "text-pickle drop-shadow-[0_0_4px_rgba(34,197,94,0.7)] transition-colors"
                  : "text-sand/50 transition-colors"
              }
            />
            <span
              className={`text-[0.6rem] font-bold uppercase tracking-wider leading-none truncate w-full px-0.5 text-center transition-colors ${
                activeId === "me" || showStaffModal ? "text-pickle font-black" : "text-sand/50"
              }`}
            >
              {authRole
                ? authRole === "admin"
                  ? "Admin"
                  : "Umpire"
                : "Me"}
            </span>
          </button>
        </div>
      </nav>

      {/* Staff Portal Modal */}
      <StaffPortalModal
        isOpen={showStaffModal}
        onClose={() => {
          setShowStaffModal(false);
          setActiveId("home");
        }}
      />

      {/* Tournament Players Directory Modal */}
      <PlayerDirectoryModal
        isOpen={showPlayerDirectoryModal}
        onClose={() => {
          setShowPlayerDirectoryModal(false);
          setActiveId("home");
        }}
      />
    </>
  );
}

/* ── Sub-component: single nav pill ── */
function MobileNavItem({
  id,
  label,
  icon: Icon,
  isActive,
  onClick,
}: {
  id: string;
  label: string;
  icon: React.ElementType;
  isActive: boolean;
  onClick: () => void;
}) {
  return (
    <button
      id={`mobile-nav-${id}`}
      aria-label={label}
      onClick={onClick}
      className="relative flex flex-col items-center justify-center gap-1 w-full pt-3 pb-1 transition-all select-none cursor-pointer"
    >
      {/* Active pill indicator at top */}
      {isActive && (
        <span
          className="absolute top-0 left-1/2 -translate-x-1/2 h-0.5 w-8 bg-pickle rounded-full"
          style={{ boxShadow: "0 0 6px rgba(34,197,94,0.7)" }}
        />
      )}
      <Icon
        size={20}
        strokeWidth={isActive ? 2.5 : 1.75}
        className={
          isActive
            ? "text-pickle drop-shadow-[0_0_4px_rgba(34,197,94,0.7)] transition-colors"
            : "text-sand/50 transition-colors"
        }
      />
      <span
        className={`text-[0.6rem] font-bold uppercase tracking-wider leading-none truncate w-full px-0.5 text-center transition-colors ${
          isActive ? "text-pickle font-black" : "text-sand/50"
        }`}
      >
        {label}
      </span>
    </button>
  );
}
