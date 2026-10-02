import { X, MapPin, Clock, Phone, Mail, Award, CheckCircle2 } from "lucide-react";

interface FacilityModalProps {
  isOpen: boolean;
  onClose: () => void;
}

const COURTS = [
  {
    id: "court-1",
    name: "Court 1 - Center Court",
    badge: "Championship Court",
    surface: "Cushioned Acrylic Surface",
    lighting: "High-Lumen LED Tournament Lighting",
    specs: "Full official tournament dimensions with elevated umpire station and perimeter run-off.",
  },
  {
    id: "court-2",
    name: "Court 2",
    badge: "Tournament Court",
    surface: "Non-Glare Pro Coat",
    lighting: "Even-Spread LED Fixtures",
    specs: "Courtside bench seating with direct view from spectator bleachers.",
  },
  {
    id: "court-3",
    name: "Court 3",
    badge: "Tournament Court",
    surface: "Non-Glare Pro Coat",
    lighting: "Even-Spread LED Fixtures",
    specs: "Dedicated digital scoreboard display with court dispatch audio alert.",
  },
  {
    id: "court-4",
    name: "Court 4",
    badge: "Tournament & Training",
    surface: "Non-Glare Pro Coat",
    lighting: "Even-Spread LED Fixtures",
    specs: "Regulation tournament net setup with quick access to warm-up and staging areas.",
  },
];

const AMENITIES = [
  {
    title: "Air-Conditioned Players Lounge",
    desc: "Comfortable staging lounge with live tournament bracket monitors and device charging stations.",
  },
  {
    title: "Official Tournament Desk",
    desc: "Centralized court dispatch station, real-time match scheduling, and live umpire desk coordination.",
  },
  {
    title: "Pro Shop & Equipment Rental",
    desc: "Tournament ball purchases, demo paddles, apparel, grip replacement, and accessory gear.",
  },
  {
    title: "Hydration & Refreshment Bar",
    desc: "Chilled mineral water, electrolyte drinks, sports snacks, and post-match refreshment counter.",
  },
  {
    title: "Covered Spectator Bleachers",
    desc: "Shaded elevated viewing grandstands providing unobstructed sightlines across all 4 courts.",
  },
  {
    title: "Locker Rooms & Shower Suites",
    desc: "Private changing stalls, secure storage lockers, and well-maintained restroom facilities.",
  },
];

export function FacilityModal({ isOpen, onClose }: FacilityModalProps) {
  if (!isOpen) return null;

  return (
    <div
      role="dialog"
      aria-modal="true"
      aria-labelledby="facility-modal-title"
      className="fixed inset-0 z-50 flex items-center justify-center p-3 sm:p-4 bg-charcoal/90 backdrop-blur-md animate-in fade-in duration-200"
      onClick={onClose}
    >
      <div
        className="relative flex flex-col w-full max-w-2xl max-h-[90vh] bg-charcoal border border-border rounded-xl shadow-2xl overflow-hidden"
        onClick={(e) => e.stopPropagation()}
      >
        {/* Header */}
        <div className="flex items-center justify-between border-b border-border px-5 py-4 bg-charcoal/95 sticky top-0 z-10">
          <div>
            <span className="block text-[0.65rem] uppercase tracking-[0.28em] text-pickle font-bold">
              Dink Valley Pickleball Club
            </span>
            <h2 id="facility-modal-title" className="font-display text-2xl sm:text-3xl text-sand">
              Club Facilities
            </h2>
          </div>
          <button
            onClick={onClose}
            className="p-2 text-sand/60 hover:text-sand rounded-lg border border-border hover:border-pickle/50 transition-colors cursor-pointer"
            aria-label="Close facility details"
          >
            <X size={18} />
          </button>
        </div>

        {/* Scrollable Content */}
        <div className="flex-1 overflow-y-auto px-5 py-6 space-y-6 text-sand text-sm">
          {/* Quick Overview Banner */}
          <div className="surface-card p-4 sm:p-5 border border-pickle/30 bg-charcoal/60 rounded-lg">
            <div className="flex items-center gap-2 text-pickle mb-2">
              <Award size={18} />
              <span className="text-xs font-bold uppercase tracking-widest">
                Facility Overview
              </span>
            </div>
            <p className="text-sand/85 text-sm leading-relaxed">
              Dink Valley is Santiago City&apos;s premier dedicated pickleball destination,
              featuring 4 tournament-grade courts engineered for competitive play, high-energy
              rallies, and community tournaments.
            </p>
          </div>

          {/* 4 Courts Section */}
          <div className="space-y-3">
            <div className="flex items-center justify-between border-b border-border pb-2">
              <h3 className="font-display text-xl text-sand">The 4 Facility Courts</h3>
              <span className="text-xs uppercase tracking-widest text-pickle font-semibold">
                4 Dedicated Courts
              </span>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {COURTS.map((court) => (
                <div
                  key={court.id}
                  className="surface-card p-4 border border-border rounded-lg bg-charcoal/40 flex flex-col justify-between"
                >
                  <div>
                    <div className="flex items-center justify-between gap-2 mb-1.5">
                      <h4 className="font-display text-lg text-sand leading-snug">
                        {court.name}
                      </h4>
                      <span className="text-[0.6rem] font-bold uppercase tracking-wider px-2 py-0.5 rounded border border-pickle/40 text-pickle bg-pickle/10">
                        {court.badge}
                      </span>
                    </div>
                    <p className="text-xs text-sand/70 mb-2">{court.specs}</p>
                  </div>
                  <div className="pt-2 border-t border-border/60 text-[0.7rem] text-sand/60 space-y-1">
                    <div className="flex items-center gap-1.5">
                      <CheckCircle2 size={12} className="text-pickle flex-shrink-0" />
                      <span>{court.surface}</span>
                    </div>
                    <div className="flex items-center gap-1.5">
                      <CheckCircle2 size={12} className="text-pickle flex-shrink-0" />
                      <span>{court.lighting}</span>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Amenities Section */}
          <div className="space-y-3">
            <div className="border-b border-border pb-2">
              <h3 className="font-display text-xl text-sand">Club Amenities</h3>
              <p className="text-xs text-sand/60">
                Designed for player comfort, tournament hosting, and spectator enjoyment.
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              {AMENITIES.map((amenity, index) => (
                <div
                  key={index}
                  className="p-3.5 border border-border rounded-lg bg-charcoal/30 flex items-start gap-3"
                >
                  <div className="h-2 w-2 rounded-full bg-pickle mt-1.5 flex-shrink-0" />
                  <div>
                    <h4 className="font-semibold text-xs text-sand uppercase tracking-wider mb-1">
                      {amenity.title}
                    </h4>
                    <p className="text-xs text-sand/70 leading-relaxed">
                      {amenity.desc}
                    </p>
                  </div>
                </div>
              ))}
            </div>
          </div>

          {/* Hours & Location / Contact Template */}
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4 border-t border-border pt-4">
            <div className="p-4 border border-border rounded-lg bg-charcoal/40 space-y-2">
              <div className="flex items-center gap-2 text-pickle">
                <Clock size={16} />
                <span className="text-xs font-bold uppercase tracking-wider">
                  Operating Hours
                </span>
              </div>
              <p className="text-xs text-sand/80 font-mono">
                Monday to Sunday: 6:00 AM - 10:00 PM
              </p>
              <p className="text-[0.7rem] text-sand/50">
                Open play, court bookings, tournament dispatches, and private sessions.
              </p>
            </div>

            <div className="p-4 border border-border rounded-lg bg-charcoal/40 space-y-2">
              <div className="flex items-center gap-2 text-pickle">
                <MapPin size={16} />
                <span className="text-xs font-bold uppercase tracking-wider">
                  Location & Contact
                </span>
              </div>
              <p className="text-xs text-sand/80">
                Santiago City, Isabela, Philippines
              </p>
              <div className="space-y-1 pt-1 text-[0.7rem] text-sand/60">
                <div className="flex items-center gap-1.5">
                  <Phone size={12} className="text-pickle" />
                  <span>Contact: +63 9XX XXX XXXX (Template)</span>
                </div>
                <div className="flex items-center gap-1.5">
                  <Mail size={12} className="text-pickle" />
                  <span>Email: dinkvalley@gmail.com (Template)</span>
                </div>
              </div>
            </div>
          </div>
        </div>

        {/* Footer */}
        <div className="border-t border-border px-5 py-3 bg-charcoal/95 flex justify-end">
          <button
            onClick={onClose}
            className="px-5 py-2 text-xs font-bold uppercase tracking-widest bg-pickle text-charcoal hover:bg-pickle/90 rounded transition-colors cursor-pointer"
          >
            Close Overview
          </button>
        </div>
      </div>
    </div>
  );
}
