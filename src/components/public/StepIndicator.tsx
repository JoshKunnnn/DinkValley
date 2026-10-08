/**
 * Plain "Step 1, 2, 3" progress guide so visitors always know where they are.
 * Completed steps can be tapped to go back.
 */
export function StepIndicator({
  current,
  onStepClick,
}: {
  current: 1 | 2 | 3;
  onStepClick?: ((step: 1 | 2 | 3) => void) | undefined;
}) {
  const steps: { n: 1 | 2 | 3; label: string }[] = [
    { n: 1, label: "Tournament" },
    { n: 2, label: "Category" },
    { n: 3, label: "Bracket" },
  ];

  return (
    <nav aria-label="Progress" className="w-full">
      <ol className="grid grid-cols-3 gap-2">
        {steps.map((s) => {
          const isDone = s.n < current;
          const isCurrent = s.n === current;
          const clickable = Boolean(onStepClick) && s.n !== current;
          const inner = (
            <>
              <span
                className={`flex h-8 w-8 sm:h-9 sm:w-9 shrink-0 items-center justify-center rounded-full font-display text-base sm:text-lg ${
                  isCurrent
                    ? "bg-pickle text-sand font-bold"
                    : isDone
                      ? "bg-charcoal text-sand"
                      : "bg-foreground/10 text-foreground/50"
                }`}
              >
                {s.n}
              </span>
              <span className="min-w-0 text-left">
                <span
                  className={`block truncate text-xs sm:text-sm font-bold uppercase tracking-wide ${
                    isCurrent ? "text-foreground" : isDone ? "text-foreground/80" : "text-foreground/45"
                  }`}
                >
                  {s.label}
                </span>
                <span className="block text-[0.65rem] sm:text-xs text-foreground/55">
                  {isDone ? "Done" : isCurrent ? "Current" : "Next"}
                </span>
              </span>
            </>
          );

          return (
            <li key={s.n}>
              {clickable ? (
                <button
                  type="button"
                  onClick={() => onStepClick?.(s.n)}
                  aria-current={isCurrent ? "step" : undefined}
                  className="flex w-full min-h-[3.25rem] items-center gap-2 rounded-xl border-2 border-border bg-card px-2.5 py-1.5 hover:border-pickle cursor-pointer transition-colors"
                >
                  {inner}
                </button>
              ) : (
                <div
                  aria-current={isCurrent ? "step" : undefined}
                  className={`flex w-full min-h-[3.25rem] items-center gap-2 rounded-xl border-2 px-2.5 py-1.5 ${
                    isCurrent ? "border-pickle bg-pickle/10" : "border-border bg-card opacity-70"
                  }`}
                >
                  {inner}
                </div>
              )}
            </li>
          );
        })}
      </ol>
    </nav>
  );
}
