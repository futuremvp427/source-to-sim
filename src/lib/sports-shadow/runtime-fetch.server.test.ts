import { describe, expect, it } from "vitest";
import { runtimeFetch } from "./runtime-fetch.server";

/**
 * Task 13E: deterministic, network-free reproduction of the exact JS invocation-semantics
 * distinction that caused the live production failure ("Illegal invocation: function called
 * with incorrect `this` reference"). Models Cloudflare Workers' branded-native `fetch` by
 * installing a fake `globalThis.fetch` that throws unless called with `this === globalThis`
 * -- Node/Bun's own real fetch never performs this check, which is exactly why this defect
 * passed every prior local test and every prior CI run undetected.
 */
function installThisSensitiveGlobalFetch(): () => void {
  const original = globalThis.fetch;
  function brandedFetch(this: unknown, ..._args: Parameters<typeof fetch>): ReturnType<typeof fetch> {
    if (this !== globalThis) {
      throw new TypeError("Illegal invocation: function called with incorrect `this` reference.");
    }
    return Promise.resolve(new Response("{}"));
  }
  globalThis.fetch = brandedFetch as typeof fetch;
  return () => {
    globalThis.fetch = original;
  };
}

describe("Task 13E: reproduction — the CURRENT bare-capture pattern is unsafe", () => {
  it("A. `{ fetchImpl: fetch }` (today's exact pattern in source-poll.server.ts/pmus.server.ts/kalshi.server.ts) throws Illegal-invocation-style failure once detached and invoked via a different receiver", () => {
    const restore = installThisSensitiveGlobalFetch();
    try {
      // Exactly today's buggy pattern: `fetchImpl: fetch` captures the bare reference once,
      // then `deps.fetchImpl(...)` invokes it with `this === deps`, not `this === globalThis`.
      // The brand check inside a real WebIDL-native fetch (and this model of it) throws
      // SYNCHRONOUSLY, before any Promise is ever created -- exactly what production hit.
      const deps = { fetchImpl: globalThis.fetch };
      expect(() => deps.fetchImpl("https://example.test")).toThrow(/Illegal invocation/);
    } finally {
      restore();
    }
  });

  it("the `typeof fetch = fetch` default-parameter pattern (today's exact pattern in source-metadata.server.ts) is equally unsafe once passed through one more layer of indirection", () => {
    const restore = installThisSensitiveGlobalFetch();
    try {
      function withDefault(fetchImpl: typeof fetch = globalThis.fetch) {
        const wrapper = { fetchImpl };
        return wrapper.fetchImpl("https://example.test");
      }
      expect(() => withDefault()).toThrow(/Illegal invocation/);
    } finally {
      restore();
    }
  });
});

describe("Task 13E: fix — runtimeFetch is safe under the identical this-sensitive fake", () => {
  it("B. runtimeFetch succeeds when invoked directly against the this-sensitive fake global fetch", async () => {
    const restore = installThisSensitiveGlobalFetch();
    try {
      await expect(runtimeFetch("https://example.test")).resolves.toBeInstanceOf(Response);
    } finally {
      restore();
    }
  });

  it("runtimeFetch remains safe even after being captured into a plain object property and invoked through it (the exact detachment shape that broke the old pattern)", async () => {
    const restore = installThisSensitiveGlobalFetch();
    try {
      const deps = { fetchImpl: runtimeFetch };
      await expect(deps.fetchImpl("https://example.test")).resolves.toBeInstanceOf(Response);
    } finally {
      restore();
    }
  });

  it("runtimeFetch remains safe through multiple additional layers of detachment/re-extraction -- an arrow function ignores `this` entirely, so no amount of further passing-around can reintroduce the bug", async () => {
    const restore = installThisSensitiveGlobalFetch();
    try {
      const layer1 = { fetchImpl: runtimeFetch };
      const layer2 = layer1.fetchImpl; // re-extracted, exactly like the old bug's failure mode
      const layer3 = { fetchImpl: layer2 };
      await expect(layer3.fetchImpl("https://example.test")).resolves.toBeInstanceOf(Response);
    } finally {
      restore();
    }
  });

  it("G. a custom test-provided fetchImpl (dependency injection) never needs global binding at all -- it is the caller's own function, invoked as a plain value, and is completely unaffected by this fix", async () => {
    const calls: string[] = [];
    const customFetchImpl = (async (url: string | URL) => {
      calls.push(String(url));
      return new Response("{}");
    }) as typeof fetch;
    const deps = { fetchImpl: customFetchImpl };
    await deps.fetchImpl("https://example.test/custom");
    expect(calls).toEqual(["https://example.test/custom"]);
  });

  it("runtimeFetch is a genuine pass-through: real Response semantics are preserved (status/body), not merely 'does not throw'", async () => {
    const restore = installThisSensitiveGlobalFetch();
    try {
      const response = await runtimeFetch("https://example.test");
      const body = await response.text();
      expect(response.status).toBe(200);
      expect(body).toBe("{}");
    } finally {
      restore();
    }
  });
});
