# Mirror Trader Dashboard

Create and IMPLEMENT a working private project named Mirror Trader MVP. Do not stop at planning. The first preview must contain a real usable dashboard, not a placeholder.

Purpose: read-only Polymarket wallet monitor + deterministic PAPER copy simulator for this fixed target wallet: 0x8fbd7cf5f806f563080864694415829f7229a959.

Build the actual UI now with these sections: Overview; Recent Source Trades; Paper Copy Activity; Positions; Settled P&L; Data Health. Include Refresh, visible last-updated timestamp, market search, BUY/SELL filter, configurable paper amount default $10, responsive loading/empty/error states.

Use public Polymarket data without credentials. Adapt to the actual public API response shape. If public data is inaccessible from the Lovable runtime/browser, the preview MUST still work using a clearly labeled DEMO/SAMPLE fallback; Data Health must explicitly say why fallback is active and must never portray demo data as live.

Paper-copy rules: derive deterministic paper actions from source trades and clearly label PAPER SIMULATION / DERIVED. No live orders, no authenticated trading endpoints, no credential prompts, no keys, no signing, no mutation controls. Open P&L must say Unavailable unless there is a reliable fresh mark. Settled/verified P&L is authoritative and must not be invented.

For event dedup, prefer source event/trade ID, otherwise transaction hash + event/log index. Never collapse legitimate identical same-second trades; if source identity is insufficient, preserve them with a stable local ordinal. Add a test/regression check for two identical same-second BUYs and SELLs remaining distinct.

Keep scope practical. Do not spend this pass on distributed workers, lease systems, cold storage, huge backfills, or architecture essays. Supabase is optional and must not block the preview. Use client/server code as needed. Fix all build/type/runtime errors yourself and keep iterating until the preview is usable.

At completion report: what works, preview URL, files changed, public APIs actually used, whether data is LIVE/DERIVED/DEMO, test/build result, known limitations, next 3 highest-value improvements. IMPLEMENT NOW.

This project was built with [Lovable](https://lovable.dev).

## Build with Lovable

Continue developing this project in the [Lovable editor](https://lovable.dev/projects/4b638e7d-0e5f-4bf3-92cc-48cb757308fc).

- **Ship faster**: describe what you want to build and Lovable handles the code.
- **Stay in sync**: every change made in Lovable is committed straight to this repository.
- **Full ownership**: this code is yours. Push to `main` on GitHub and your changes sync back into Lovable, ready for your next prompt.

## Development

Prefer working locally? You need Node.js and npm — [install with nvm](https://github.com/nvm-sh/nvm#installing-and-updating).

```sh
git clone <this-repository-url>
cd <repository-name>
npm i
npm run dev
```
