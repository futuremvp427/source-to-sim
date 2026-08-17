/** Compact trading-terminal presentation primitives. Display only. */
import type { ReactNode } from "react";

import { cn } from "@/lib/utils";
import type { Tone } from "@/lib/ui/portfolio-view";

export function toneClass(tone: Tone | "warn" | "ok" | "bad"): string {
  switch (tone) {
    case "positive":
    case "ok":
      return "text-[var(--gain)]";
    case "negative":
    case "bad":
      return "text-[var(--loss)]";
    case "warn":
      return "text-[var(--warn)]";
    default:
      return "text-muted-foreground";
  }
}

export function TerminalCard({
  title,
  subtitle,
  action,
  children,
  className,
}: {
  title?: string;
  subtitle?: string;
  action?: ReactNode;
  children: ReactNode;
  className?: string;
}) {
  return (
    <section
      className={cn(
        "rounded-lg border border-border/70 bg-card/60 backdrop-blur-[1px]",
        className,
      )}
    >
      {title ? (
        <header className="grid grid-cols-[minmax(0,1fr)_auto] items-center gap-3 border-b border-border/70 px-3 py-2 sm:px-4">
          <div className="min-w-0">
            <h2 className="truncate text-[11px] font-semibold uppercase tracking-[0.12em] text-muted-foreground">
              {title}
            </h2>
            {subtitle ? (
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground/80">{subtitle}</p>
            ) : null}
          </div>
          {action}
        </header>
      ) : null}
      <div className="px-3 py-3 sm:px-4">{children}</div>
    </section>
  );
}

export function Metric({
  label,
  value,
  hint,
  tone = "default",
  size = "md",
}: {
  label: string;
  value: string;
  hint?: string | undefined;
  tone?: Tone | "default";
  size?: "sm" | "md" | "lg";
}) {
  const valueTone =
    tone === "positive"
      ? "text-[var(--gain)]"
      : tone === "negative"
        ? "text-[var(--loss)]"
        : tone === "muted"
          ? "text-muted-foreground"
          : "text-foreground";
  const sizeClass =
    size === "lg" ? "text-2xl sm:text-3xl" : size === "sm" ? "text-sm" : "text-lg sm:text-xl";
  return (
    <div className="min-w-0 rounded-md border border-border/60 bg-background/40 px-3 py-2">
      <p className="truncate text-[10px] font-medium uppercase tracking-[0.14em] text-muted-foreground">
        {label}
      </p>
      <p className={cn("mt-1 font-semibold tabular-nums", sizeClass, valueTone)}>{value}</p>
      {hint ? <p className="mt-1 text-[11px] text-muted-foreground/80">{hint}</p> : null}
    </div>
  );
}

export function Chip({
  children,
  tone = "muted",
}: {
  children: ReactNode;
  tone?: "muted" | "ok" | "warn" | "bad" | "accent";
}) {
  const map = {
    muted: "border-border/70 text-muted-foreground",
    ok: "border-[var(--gain)]/40 bg-[var(--gain-soft)] text-[var(--gain)]",
    warn: "border-[var(--warn)]/40 bg-[var(--warn-soft)] text-[var(--warn)]",
    bad: "border-[var(--loss)]/40 bg-[var(--loss-soft)] text-[var(--loss)]",
    accent: "border-[var(--paper)]/40 bg-[var(--paper-soft)] text-[var(--paper)]",
  } as const;
  return (
    <span
      className={cn(
        "inline-flex items-center gap-1 rounded border px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-[0.1em]",
        map[tone],
      )}
    >
      {children}
    </span>
  );
}

export function MagnitudeBar({ pct, tone }: { pct: number; tone: Tone }) {
  return (
    <div className="h-1.5 w-full overflow-hidden rounded-full bg-muted/60">
      <div
        className={cn(
          "h-full rounded-full",
          tone === "negative" ? "bg-[var(--loss)]" : tone === "muted" ? "bg-muted" : "bg-[var(--gain)]",
        )}
        style={{ width: `${Math.max(pct, 2)}%` }}
      />
    </div>
  );
}

export function WalletGlyph({ badge }: { badge: string }) {
  return (
    <span className="grid size-8 shrink-0 place-items-center rounded border border-border/70 bg-background/60 text-[11px] font-bold tracking-tight text-muted-foreground">
      {badge}
    </span>
  );
}

export function PaperLabel() {
  return <Chip tone="accent">Paper simulation · derived</Chip>;
}