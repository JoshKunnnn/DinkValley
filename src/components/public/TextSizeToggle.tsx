import { useEffect, useState } from "react";

export function TextSizeToggle() {
  const [large, setLarge] = useState(false);

  useEffect(() => {
    try {
      const saved = localStorage.getItem("dv_large_text");
      if (saved === "1") {
        setLarge(true);
        document.documentElement.classList.add("dv-large-text");
      }
    } catch {
      // ignore
    }
  }, []);

  const toggle = () => {
    const next = !large;
    setLarge(next);
    try {
      if (next) {
        document.documentElement.classList.add("dv-large-text");
        localStorage.setItem("dv_large_text", "1");
      } else {
        document.documentElement.classList.remove("dv-large-text");
        localStorage.removeItem("dv_large_text");
      }
    } catch {
      // ignore
    }
  };

  return (
    <button
      type="button"
      onClick={toggle}
      className={`min-h-[2.5rem] px-2.5 py-1 text-xs font-mono font-bold uppercase tracking-wider rounded border transition-colors cursor-pointer flex items-center gap-1.5 ${
        large
          ? "border-pickle bg-pickle text-sand"
          : "border-border bg-charcoal/80 text-sand/80 hover:text-sand hover:border-sand/40"
      }`}
      title={large ? "Switch to standard text size" : "Make text larger for easier reading"}
      aria-pressed={large}
    >
      <span className="font-display text-sm tracking-normal">A+</span>
      <span className="hidden sm:inline">{large ? "Large Text" : "Bigger Text"}</span>
    </button>
  );
}
