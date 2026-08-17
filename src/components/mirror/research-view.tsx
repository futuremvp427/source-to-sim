/** Research screen: candidate followers and watchlist, kept out of master totals. */
import { CandidateSection } from "./candidate-panels";
import { Chip, TerminalCard } from "./terminal";

export function ResearchView() {
  return (
    <div className="space-y-3">
      <TerminalCard title="Research cohort" action={<Chip tone="warn">Not funded</Chip>}>
        <p className="text-xs text-muted-foreground">
          Candidate followers and watchlist wallets are observation only. They hold no Master
          Portfolio allocation and never contribute to portfolio totals until intentionally promoted.
          Historical &ldquo;events seen&rdquo; counts describe the public wallet before observation
          started; paper decisions only exist after a candidate&rsquo;s shadow start.
        </p>
      </TerminalCard>
      <CandidateSection />
    </div>
  );
}