/**
 * Server-safe runtime fetch adapter — Task 13E: Cloudflare Workers "Illegal invocation" fix.
 *
 * ROOT CAUSE (reproduced live in production, Combined Task 13 Stage 4 canary): capturing
 * the bare `fetch` function reference into a plain object property (`{ fetchImpl: fetch }`)
 * and later invoking it through that property (`deps.fetchImpl(...)`) changes `this` inside
 * the call to the containing object instead of the runtime's expected receiver. Node/Bun's
 * `fetch` does not check `this` at all, so this pattern passed every local test and every
 * CI run — but Cloudflare Workers' `fetch` is a WebIDL "branded" native that throws
 * `TypeError: Illegal invocation: function called with incorrect \`this\` reference` unless
 * invoked with the correct receiver. Every real wallet poll failed with exactly this error
 * the instant Sports Shadow was enabled against the actual deployed Lovable/Cloudflare
 * Workers runtime — something no Bun/vitest run could ever catch, since Bun's fetch has no
 * such brand check. See runtime-fetch.server.test.ts for a deterministic, network-free
 * reproduction of the underlying JS invocation-semantics distinction.
 *
 * FIX: wrap the call in a plain function whose OWN body performs a property-access call
 * `globalThis.fetch(...)` — a fresh reference resolved via property access at CALL TIME,
 * every time, which always supplies `globalThis` as the receiver (`obj.method()` binds
 * `this = obj` per the language's ordinary method-call semantics) regardless of how this
 * wrapper itself is later stored, detached, or invoked as a value. Safe in Cloudflare
 * Workers, Node, and Bun alike. Preserves the exact `typeof fetch` signature, so every
 * existing dependency-injection call site (including every test fixture that already
 * supplies its own mock `fetchImpl`) continues to work completely unchanged — this module
 * only replaces what the DEFAULT resolves to when no override is given.
 */
export const runtimeFetch: typeof fetch = (...args) => globalThis.fetch(...args);
