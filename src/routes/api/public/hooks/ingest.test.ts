import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const source = readFileSync(new URL("./ingest.ts", import.meta.url), "utf8");

describe("scheduled ingest route authorization contract", () => {
  it("keeps the mutating scheduler hook POST-only", () => {
    expect(source).toMatch(/handlers:\s*\{[\s\S]*?POST:\s*\(\{\s*request\s*\}\)\s*=>\s*handle\(request\)/);
    expect(source).not.toMatch(/\bGET\s*:/);
  });

  it("requires the dedicated INGEST_HOOK_SECRET", () => {
    expect(source).toContain('process.env["INGEST_HOOK_SECRET"]');
    expect(source).toMatch(/if\s*\(\s*!expected\s*\|\|\s*provided\s*!==\s*expected\s*\)/);
    expect(source).toContain('status: 401');
  });

  it("does not accept browser-visible Supabase keys as a scheduler fallback", () => {
    expect(source).not.toMatch(/SUPABASE_(?:ANON|PUBLISHABLE)_KEY/);
    expect(source).not.toMatch(/VITE_SUPABASE/);
    expect(source).not.toMatch(/PUBLIC_SUPABASE/);
  });

  it("accepts only request credentials that are compared with the dedicated secret", () => {
    expect(source).toContain('request.headers.get("x-ingest-secret")');
    expect(source).toContain('request.headers.get("apikey")');
    expect(source).toMatch(/provided\s*!==\s*expected/);
  });
});
