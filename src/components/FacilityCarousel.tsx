import { useState, useEffect, useRef, useCallback } from "react";
import { ChevronLeft, ChevronRight, MapPin, Sparkles } from "lucide-react";

export interface FacilitySlide {
  image: string;
  tag: string;
  title: string;
  subtitle: string;
  desc: string;
}

export const FACILITY_SLIDES: FacilitySlide[] = [
  {
    image: "/facility-overview.jpg",
    tag: "Championship Facility",
    title: "4 Dedicated Courts",
    subtitle: "Center Court & 3 Tournament Courts",
    desc: "Engineered specifically for competitive pickleball with official court dimensions, high-contrast non-glare playing surface, and expansive spectator viewing corridors.",
  },
  {
    image: "/facility-court-main.jpg",
    tag: "Championship Play",
    title: "Center Court Stadium",
    subtitle: "Elevated Umpire Station & LED Lighting",
    desc: "Cushioned acrylic tournament surface, perimeter run-off spacing, elevated official umpire station, and high-lumen anti-glare overhead LED lighting for broadcast-tier competition.",
  },
  {
    image: "/facility-lounge.jpg",
    tag: "Player Amenities",
    title: "Air-Conditioned Lounge",
    subtitle: "Climate Staging & Live Monitors",
    desc: "Full climate-controlled staging area equipped with live digital bracket displays, high-speed device charging bars, and a dedicated hydration & refreshment counter.",
  },
  {
    image: "/facility-desk.jpg",
    tag: "Match Operations",
    title: "Tournament Control Desk",
    subtitle: "Central Court Dispatch & Scheduling",
    desc: "Real-time match scheduling, live umpire assignment coordination, official check-in point, and tournament director operations hub.",
  },
  {
    image: "/facility-exterior.jpg",
    tag: "Club Grounds",
    title: "The Valley Grounds",
    subtitle: "Santiago City, Isabela",
    desc: "Santiago City's premier pickleball facility in Isabela, featuring secure parking, comfortable player amenities, and open play from 6:00 AM to 10:00 PM daily.",
  },
];

export function FacilityCarousel() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const touchStartXRef = useRef<number | null>(null);
  const touchEndXRef = useRef<number | null>(null);

  const totalSlides = FACILITY_SLIDES.length;

  const nextSlide = useCallback(() => {
    setCurrentIndex((prev) => (prev + 1) % totalSlides);
  }, [totalSlides]);

  const prevSlide = useCallback(() => {
    setCurrentIndex((prev) => (prev - 1 + totalSlides) % totalSlides);
  }, [totalSlides]);

  const goToSlide = (idx: number) => {
    setCurrentIndex(idx);
  };

  // Auto-advance every 5.5s when not paused or interacted with
  useEffect(() => {
    if (isPaused) return;
    const timer = setInterval(() => {
      nextSlide();
    }, 5500);
    return () => clearInterval(timer);
  }, [isPaused, nextSlide]);

  // Touch swipe support for mobile devices
  const handleTouchStart = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    touchStartXRef.current = touch.clientX;
    touchEndXRef.current = null;
    setIsPaused(true);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    const touch = e.touches[0];
    if (!touch) return;
    touchEndXRef.current = touch.clientX;
  };

  const handleTouchEnd = () => {
    if (touchStartXRef.current !== null && touchEndXRef.current !== null) {
      const deltaX = touchStartXRef.current - touchEndXRef.current;
      const minSwipeDistance = 45; // 45px threshold

      if (deltaX > minSwipeDistance) {
        nextSlide();
      } else if (deltaX < -minSwipeDistance) {
        prevSlide();
      }
    }
    touchStartXRef.current = null;
    touchEndXRef.current = null;
    setIsPaused(false);
  };

  const currentSlide: FacilitySlide = (FACILITY_SLIDES[currentIndex] ?? FACILITY_SLIDES[0])!;

  return (
    <div
      role="region"
      aria-roledescription="carousel"
      aria-label="Dink Valley Facility Showcase"
      className="relative w-full select-none"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
      onTouchStart={handleTouchStart}
      onTouchMove={handleTouchMove}
      onTouchEnd={handleTouchEnd}
    >
      {/* ── Main Viewport Frame ── */}
      <div className="relative w-full overflow-hidden rounded-xl border border-white/10 bg-charcoal shadow-2xl">
        {/* Aspect ratio container */}
        <div className="relative w-full aspect-[4/3] sm:aspect-[16/9] md:aspect-[21/9] min-h-[300px] sm:min-h-[420px] max-h-[580px]">
          {/* Slides Track */}
          <div
            className="flex h-full w-full transition-transform duration-500 ease-out"
            style={{ transform: `translateX(-${currentIndex * 100}%)` }}
          >
            {FACILITY_SLIDES.map((slide, idx) => (
              <div
                key={slide.image}
                aria-hidden={idx !== currentIndex}
                className="relative h-full w-full flex-shrink-0"
              >
                <img
                  src={slide.image}
                  alt={slide.title}
                  className="h-full w-full object-cover"
                  style={{ objectPosition: "center 35%" }}
                  loading={idx === 0 ? "eager" : "lazy"}
                />

                {/* Ambient dark gradient overlays for legibility */}
                <div className="absolute inset-0 bg-gradient-to-t from-charcoal via-charcoal/50 to-transparent" />
                <div className="absolute inset-0 bg-gradient-to-r from-charcoal/80 via-transparent to-charcoal/20" />
              </div>
            ))}
          </div>

          {/* ── Top Bar within viewport: Badge + Counter ── */}
          <div className="absolute top-4 inset-x-4 sm:top-6 sm:inset-x-6 flex items-center justify-between pointer-events-none z-10">
            <span className="inline-flex items-center gap-1.5 px-3 py-1 rounded-full bg-charcoal/85 backdrop-blur-md border border-pickle/40 text-[0.65rem] sm:text-xs font-bold uppercase tracking-[0.2em] text-pickle">
              <span className="h-1.5 w-1.5 rounded-full bg-pickle animate-pulse" />
              {currentSlide.tag}
            </span>

            {/* Slide Index Badge */}
            <span className="px-3 py-1 rounded-full bg-charcoal/85 backdrop-blur-md border border-white/15 text-[0.65rem] sm:text-xs font-mono font-bold text-sand/90 tracking-widest">
              0{currentIndex + 1} / 0{totalSlides}
            </span>
          </div>

          {/* ── Bottom Content Overlay within viewport ── */}
          <div className="absolute bottom-0 inset-x-0 p-5 sm:p-7 md:p-8 z-10 pointer-events-none">
            <div className="max-w-2xl">
              <span className="block text-[0.7rem] sm:text-xs font-bold uppercase tracking-[0.25em] text-pickle mb-1">
                {currentSlide.subtitle}
              </span>
              <h3 className="font-display text-2xl sm:text-4xl md:text-5xl text-sand leading-none drop-shadow-md">
                {currentSlide.title}
              </h3>
              <p className="mt-2 text-xs sm:text-sm text-sand/80 leading-relaxed max-w-xl drop-shadow line-clamp-2 sm:line-clamp-3">
                {currentSlide.desc}
              </p>
            </div>
          </div>

          {/* ── Left / Right Arrow Buttons ── */}
          <button
            onClick={prevSlide}
            aria-label="Previous facility photo"
            className="absolute left-3 top-1/2 -translate-y-1/2 z-20 flex h-10 w-10 sm:h-12 sm:w-12 items-center justify-center rounded-full bg-charcoal/80 text-sand border border-white/15 backdrop-blur-md transition-all hover:bg-charcoal hover:border-pickle hover:text-pickle hover:scale-105 active:scale-95 cursor-pointer shadow-lg"
          >
            <ChevronLeft size={22} />
          </button>

          <button
            onClick={nextSlide}
            aria-label="Next facility photo"
            className="absolute right-3 top-1/2 -translate-y-1/2 z-20 flex h-10 w-10 sm:h-12 sm:w-12 items-center justify-center rounded-full bg-charcoal/80 text-sand border border-white/15 backdrop-blur-md transition-all hover:bg-charcoal hover:border-pickle hover:text-pickle hover:scale-105 active:scale-95 cursor-pointer shadow-lg"
          >
            <ChevronRight size={22} />
          </button>
        </div>
      </div>

      {/* ── Carousel Pagination Indicators (Dots / Pills) ── */}
      <div className="mt-4 flex items-center justify-center gap-2">
        {FACILITY_SLIDES.map((_, idx) => {
          const isActive = idx === currentIndex;
          return (
            <button
              key={idx}
              onClick={() => goToSlide(idx)}
              aria-label={`Go to slide ${idx + 1}`}
              aria-current={isActive}
              className={`transition-all duration-300 rounded-full cursor-pointer ${
                isActive
                  ? "w-8 h-2 bg-pickle shadow-[0_0_8px_rgba(34,197,94,0.7)]"
                  : "w-2 h-2 bg-sand/30 hover:bg-sand/60"
              }`}
            />
          );
        })}
      </div>

      {/* ── Interactive Thumbnails Row ── */}
      <div className="mt-4 grid grid-cols-5 gap-2 sm:gap-3">
        {FACILITY_SLIDES.map((slide, idx) => {
          const isActive = idx === currentIndex;
          return (
            <button
              key={slide.image}
              onClick={() => goToSlide(idx)}
              aria-label={`Switch to ${slide.title}`}
              className={`relative overflow-hidden rounded-lg border transition-all text-left group cursor-pointer ${
                isActive
                  ? "border-pickle ring-2 ring-pickle/40 shadow-md"
                  : "border-border/60 opacity-60 hover:opacity-100 hover:border-sand/40"
              }`}
            >
              <div className="aspect-[16/10] w-full overflow-hidden bg-charcoal">
                <img
                  src={slide.image}
                  alt={slide.title}
                  className={`h-full w-full object-cover transition-transform duration-300 ${
                    isActive ? "scale-105" : "group-hover:scale-105"
                  }`}
                />
              </div>
              <div className="p-1.5 bg-charcoal/90 hidden sm:block">
                <span className="block text-[0.65rem] font-bold text-sand truncate">
                  {slide.title}
                </span>
              </div>
            </button>
          );
        })}
      </div>
    </div>
  );
}
