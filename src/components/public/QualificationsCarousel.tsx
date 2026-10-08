import { useState, useEffect, useRef, useCallback } from "react";
import { ChevronLeft, ChevronRight, Maximize2, X } from "lucide-react";

export interface QualificationPoster {
  id: string;
  category: string;
  badge: string;
  badgeColor: string;
  image: string;
}

export const QUALIFICATION_POSTERS: QualificationPoster[] = [
  {
    id: "40plus",
    category: "40+ Category",
    badge: "Born 1986 or Earlier",
    badgeColor: "bg-brick text-sand border-brick",
    image: "/qualifications/40-plus-qualifications.jpg",
  },
  {
    id: "50plus",
    category: "50+ Category",
    badge: "Born 1976 or Earlier",
    badgeColor: "bg-[#c97a3c] text-sand border-[#c97a3c]",
    image: "/qualifications/50-plus-qualifications.jpg",
  },
  {
    id: "beginner",
    category: "Beginner Category",
    badge: "New to Pickleball",
    badgeColor: "bg-pickle text-sand border-pickle",
    image: "/qualifications/beginner-qualifications.jpg",
  },
  {
    id: "novice",
    category: "Novice Category",
    badge: "Developing Consistency",
    badgeColor: "bg-[#7ecb7e] text-charcoal border-[#7ecb7e]",
    image: "/qualifications/novice-qualifications.jpg",
  },
];

export function QualificationsCarousel() {
  const [currentIndex, setCurrentIndex] = useState(0);
  const [isPaused, setIsPaused] = useState(false);
  const [lightboxImage, setLightboxImage] = useState<string | null>(null);

  const touchStartXRef = useRef<number | null>(null);
  const touchEndXRef = useRef<number | null>(null);

  const total = QUALIFICATION_POSTERS.length;
  const current = QUALIFICATION_POSTERS[currentIndex]!;

  const nextSlide = useCallback(() => {
    setCurrentIndex((prev) => (prev + 1) % total);
  }, [total]);

  const prevSlide = useCallback(() => {
    setCurrentIndex((prev) => (prev - 1 + total) % total);
  }, [total]);

  // Auto-advance every 6 seconds unless paused or modal open
  useEffect(() => {
    if (isPaused || lightboxImage !== null) return;
    const timer = setInterval(() => {
      nextSlide();
    }, 6000);
    return () => clearInterval(timer);
  }, [isPaused, lightboxImage, nextSlide]);

  // Touch swipe support for mobile devices
  const handleTouchStart = (e: React.TouchEvent) => {
    touchStartXRef.current = e.touches[0]?.clientX ?? null;
    touchEndXRef.current = null;
    setIsPaused(true);
  };

  const handleTouchMove = (e: React.TouchEvent) => {
    touchEndXRef.current = e.touches[0]?.clientX ?? null;
  };

  const handleTouchEnd = () => {
    if (touchStartXRef.current !== null && touchEndXRef.current !== null) {
      const diff = touchStartXRef.current - touchEndXRef.current;
      if (Math.abs(diff) > 40) {
        if (diff > 0) nextSlide();
        else prevSlide();
      }
    }
    touchStartXRef.current = null;
    touchEndXRef.current = null;
  };

  return (
    <section
      id="qualifications"
      aria-label="Category Qualifications"
      className="relative bg-charcoal text-sand py-12 sm:py-16 overflow-hidden border-t-2 border-b-2 border-border scroll-mt-16 sm:scroll-mt-20"
      onMouseEnter={() => setIsPaused(true)}
      onMouseLeave={() => setIsPaused(false)}
    >
      <div className="mx-auto max-w-5xl px-4 sm:px-5">
        {/* Header & Category Tabs */}
        <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4 border-b border-border/80 pb-4">
          <div>
            <span className="inline-block border border-pickle px-2.5 py-0.5 text-[0.7rem] font-bold uppercase tracking-[0.24em] text-pickle">
              Official Guidelines
            </span>
            <h2 className="mt-1.5 font-display text-2xl sm:text-3xl lg:text-4xl text-sand">
              Category Qualifications
            </h2>
          </div>

          {/* Category Tabs */}
          <div className="flex flex-wrap items-center gap-1.5">
            {QUALIFICATION_POSTERS.map((slide, idx) => {
              const isSelected = idx === currentIndex;
              return (
                <button
                  key={slide.id}
                  type="button"
                  onClick={() => setCurrentIndex(idx)}
                  className={`min-h-[2.4rem] px-3.5 py-1.5 rounded-lg text-xs font-bold uppercase tracking-wider transition-all cursor-pointer border ${
                    isSelected
                      ? "border-pickle bg-pickle text-sand shadow-sm"
                      : "border-border/60 bg-card/60 text-sand/70 hover:border-pickle hover:text-sand"
                  }`}
                >
                  {slide.category.replace(" Category", "")}
                </button>
              );
            })}
          </div>
        </div>

        {/* Carousel Frame */}
        <div
          className="mt-6 relative flex flex-col items-center"
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
        >
          {/* Main Poster Display Container */}
          <div className="relative group w-full max-w-md sm:max-w-lg flex flex-col items-center">
            {/* Poster Card */}
            <div
              onClick={() => setLightboxImage(current.image)}
              className="relative w-full cursor-pointer overflow-hidden rounded-2xl border-2 border-border bg-background shadow-xl transition-transform hover:scale-[1.01]"
            >
              <img
                src={current.image}
                alt={`${current.category} Official Poster`}
                className="w-full h-auto max-h-[560px] sm:max-h-[620px] object-contain mx-auto block"
                loading="lazy"
              />

              {/* Hover overlay hint */}
              <div className="absolute inset-0 bg-charcoal/20 opacity-0 group-hover:opacity-100 transition-opacity flex items-center justify-center pointer-events-none">
                <span className="inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg bg-charcoal/90 text-sand text-xs font-bold uppercase tracking-wider border border-border shadow-lg">
                  <Maximize2 size={13} className="text-pickle" />
                  <span>Enlarge Poster</span>
                </span>
              </div>
            </div>

            {/* Poster sub-bar: category title, badge & tap hint */}
            <div className="w-full mt-3 flex items-center justify-between text-xs px-1">
              <div className="flex items-center gap-2 truncate">
                <span className="font-display text-base sm:text-lg text-sand truncate">
                  {current.category}
                </span>
                <span
                  className={`px-2 py-0.5 rounded text-[0.65rem] font-mono font-bold uppercase tracking-wider border ${current.badgeColor}`}
                >
                  {current.badge}
                </span>
              </div>

              <button
                type="button"
                onClick={() => setLightboxImage(current.image)}
                className="text-[0.7rem] text-pickle hover:text-sand font-mono uppercase tracking-wider flex items-center gap-1 cursor-pointer shrink-0"
              >
                <Maximize2 size={12} />
                <span>Enlarge</span>
              </button>
            </div>
          </div>

          {/* Controls: Left / Right Navigation & Progress Dots */}
          <div className="mt-5 w-full max-w-md sm:max-w-lg flex items-center justify-between border-t border-border/60 pt-3">
            <div className="flex items-center gap-1.5">
              {QUALIFICATION_POSTERS.map((_, idx) => (
                <button
                  key={idx}
                  type="button"
                  onClick={() => setCurrentIndex(idx)}
                  aria-label={`Go to slide ${idx + 1}`}
                  className={`h-2 transition-all rounded-full cursor-pointer ${
                    idx === currentIndex
                      ? "w-7 bg-pickle"
                      : "w-2 bg-border hover:bg-pickle/50"
                  }`}
                />
              ))}
              <span className="ml-2 font-mono text-xs text-sand/60">
                {currentIndex + 1} / {total}
              </span>
            </div>

            <div className="flex items-center gap-2">
              <button
                type="button"
                onClick={prevSlide}
                aria-label="Previous poster"
                className="w-9 h-9 rounded-xl border border-border bg-card text-sand hover:border-pickle hover:text-pickle transition-colors flex items-center justify-center cursor-pointer"
              >
                <ChevronLeft size={18} />
              </button>
              <button
                type="button"
                onClick={nextSlide}
                aria-label="Next poster"
                className="w-9 h-9 rounded-xl border border-border bg-card text-sand hover:border-pickle hover:text-pickle transition-colors flex items-center justify-center cursor-pointer"
              >
                <ChevronRight size={18} />
              </button>
            </div>
          </div>
        </div>
      </div>

      {/* Lightbox Modal */}
      {lightboxImage && (
        <div
          role="dialog"
          aria-modal="true"
          aria-label="Enlarged Poster Preview"
          onClick={() => setLightboxImage(null)}
          className="fixed inset-0 z-50 bg-charcoal/90 backdrop-blur-sm flex items-center justify-center p-3 sm:p-6 animate-in fade-in cursor-zoom-out"
        >
          <div
            className="relative max-w-2xl w-full max-h-[92vh] flex flex-col items-center justify-center"
            onClick={(e) => e.stopPropagation()}
          >
            <button
              type="button"
              onClick={() => setLightboxImage(null)}
              aria-label="Close poster preview"
              className="absolute -top-10 right-0 sm:right-2 w-8 h-8 rounded-full bg-sand text-charcoal flex items-center justify-center font-bold shadow-lg hover:bg-pickle hover:text-sand transition-colors cursor-pointer"
            >
              <X size={18} />
            </button>

            <img
              src={lightboxImage}
              alt="Official Qualifications Poster"
              className="w-auto h-auto max-h-[86vh] max-w-full rounded-xl shadow-2xl object-contain border-2 border-sand/20"
            />
          </div>
        </div>
      )}
    </section>
  );
}
