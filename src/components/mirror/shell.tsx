/** Responsive dashboard shell: brand bar, health chip, tab navigation. */
import type { ReactNode } from "react";
import { Link } from "@tanstack/react-router";
import { Activity, FlaskConical, LayoutGrid, Server, Trophy, Wallet } from "lucide-react";

import { cn } from "@/lib/utils";

import { Chip } from "./terminal";

export const TABS = [
  { key: "overview", label: "Overview", icon: LayoutGrid },
  { key: "strategies", label: "Strategies", icon: Wallet },
  { key: "activity", label: "Activity", icon: Activity },
  { key: "research", label: "Research", icon: FlaskConical },
  { key: "system", label: "System", icon: Server },
] as const;

export type TabKey = (typeof TABS)[number]["key"];


export function Shell({
  tab,
  onTabChange,
  health,
  operatorEmail,
  onSignOut,
  children,
}: {
  tab: TabKey;
  onTabChange: (tab: TabKey) => void;
  health: { label: string; tone: "ok" | "warn" | "bad" | "muted" } | null;
  operatorEmail: string | null;
  onSignOut: () => void;
  children: ReactNode;
}) {
  return (
    <div className="min-h-dvh bg-background">
      <header className="sticky top-0 z-20 border-b border-border/70 bg-background/85 backdrop-blur">
        <div className="mx-auto grid w-full max-w-7xl grid-cols-[minmax(0,1fr)_auto] items-center gap-3 px-3 py-2 sm:px-6">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-sm font-black tracking-[0.3em] text-foreground">MIRROR</span>
            <span className="hidden truncate text-[11px] text-muted-foreground sm:inline">
              Paper copy simulator
            </span>
          </div>
          <div className="flex shrink-0 items-center gap-2">
            {health ? <Chip tone={health.tone === "muted" ? "muted" : health.tone}>{health.label}</Chip> : null}
            {operatorEmail ? (
              <button
                type="button"
                onClick={onSignOut}
                className="rounded border border-border/70 px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                Sign out
              </button>
            ) : (
              <Link
                to="/auth"
                className="rounded border border-border/70 px-2 py-1 text-[11px] font-medium text-muted-foreground hover:text-foreground"
              >
                Operator sign in
              </Link>
            )}
          </div>
        </div>
        <nav className="mx-auto hidden w-full max-w-7xl gap-1 px-3 pb-2 sm:flex sm:px-6" aria-label="Sections">
          {TABS.map((t) => (
            <button
              key={t.key}
              type="button"
              onClick={() => onTabChange(t.key)}
              aria-current={tab === t.key ? "page" : undefined}
              className={cn(
                "rounded px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                tab === t.key
                  ? "bg-muted text-foreground"
                  : "text-muted-foreground hover:text-foreground",
              )}
            >
              {t.label}
            </button>
          ))}
          <Link
            to="/sports-shadow"
            className="rounded border border-[var(--paper)]/40 px-3 py-1.5 text-[11px] font-semibold uppercase tracking-[0.12em] text-[var(--paper)] transition-colors hover:bg-[var(--paper-soft)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          >
            Sports Shadow
          </Link>
        </nav>
      </header>

      <main className="mx-auto w-full max-w-7xl px-3 py-3 pb-24 sm:px-6 sm:pb-8">{children}</main>

      <nav
        className="fixed inset-x-0 bottom-0 z-20 grid grid-cols-5 border-t border-border/70 bg-background/95 backdrop-blur sm:hidden"
        aria-label="Sections"
      >
        {TABS.map((t) => {
          const Icon = t.icon;
          return (
            <button
              key={t.key}
              type="button"
              onClick={() => onTabChange(t.key)}
              aria-current={tab === t.key ? "page" : undefined}
              className={cn(
                "flex min-h-14 flex-col items-center justify-center gap-1 text-[10px] font-medium focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
                tab === t.key ? "text-foreground" : "text-muted-foreground",
              )}
            >
              <Icon className="size-4" aria-hidden />
              {t.label}
            </button>
          );
        })}
      </nav>
    </div>
  );
}