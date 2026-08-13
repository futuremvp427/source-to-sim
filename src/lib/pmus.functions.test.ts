import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "fs";
import { resolve } from "path";

// Set environment variables required by the Supabase auth middleware.
process.env["SUPABASE_URL"] = "https://fake-test.supabase.co";
process.env["SUPABASE_PUBLISHABLE_KEY"] = "sb_publishable_fake_test_key";

vi.mock("@tanstack/react-start/server", async () => {
  const actual = await vi.importActual("@tanstack/react-start/server");
  return {
    ...actual,
    getRequest: vi.fn(),
  };
});

vi.mock("@supabase/supabase-js", async () => {
  const actual = await vi.importActual("@supabase/supabase-js");
  return {
    ...actual,
    createClient: vi.fn(),
  };
});

vi.mock("./pmus/verify.server", () => ({
  loadPmusPanel: vi.fn(async () => {
    const panel: import("./pmus/verify.server").PmusPanelData = {
      connection: {
        provider: "Polymarket US",
        configured: false,
        connected: false,
        status: "not_configured",
        detail: "test panel",
        lastVerifiedAt: null,
        accountSummary: null,
      },
      pending: [],
      recent: [],
      counts: { pending: 0, approved: 0, rejected: 0, ineligible: 0 },
      automation: {
        weatherMarketCount: 0,
        newMarketCount: 0,
        lastScanAt: null,
        lastScanStatus: null,
        lastCompatibilityCheckAt: null,
        lastExactMatchAt: null,
        pendingPreviews: 0,
        message: "test",
      },
    };
    return panel;
  }),
}));

import { getRequest } from "@tanstack/react-start/server";
import { createClient } from "@supabase/supabase-js";
import { requireAdmin } from "./admin-auth";
import { loadPmusPanel } from "./pmus/verify.server";

const mockedGetRequest = vi.mocked(getRequest);
const mockedCreateClient = vi.mocked(createClient);

type AuthContext = Awaited<
  ReturnType<
    NonNullable<NonNullable<(typeof requireAdmin)["options"]["middleware"]>["options"]["server"]>
  >
>["context"];

function createMockSupabaseClient({ isAdmin }: { isAdmin: boolean }) {
  return {
    auth: {
      getClaims: vi.fn(async () => ({
        data: { claims: { sub: "test-user-id" } },
        error: null,
      })),
    },
    rpc: vi.fn(async (name: string, args: { _user_id: string; _role: string }) => {
      if (name === "has_role") {
        return { data: args._role === "admin" && isAdmin, error: null };
      }
      return { data: null, error: null };
    }),
  };
}

function setAuthHeader(header: string | null) {
  mockedGetRequest.mockReturnValue({
    headers: {
      get: (name: string) => (name.toLowerCase() === "authorization" ? header : null),
    },
  } as any);
}

async function runAuthChain(isAdmin: boolean) {
  const mockSupabase = createMockSupabaseClient({ isAdmin });
  mockedCreateClient.mockReturnValue(mockSupabase as any);

  const middlewares = (requireAdmin as any).options.middleware;
  const requireSupabaseAuth = middlewares[0];

  const authResult = await requireSupabaseAuth.options.server({
    next: async (ctx: any) => ({ context: ctx }),
    context: {},
  } as any);

  const adminResult = await (requireAdmin as any).options.server({
    next: async (ctx: any) => ({ context: ctx }),
    context: authResult.context,
  } as any);

  return adminResult.context as AuthContext;
}

async function runPmusPanelWithAuth(authHeader: string | null, isAdmin = false) {
  setAuthHeader(authHeader);
  if (!authHeader) {
    const middlewares = (requireAdmin as any).options.middleware;
    const requireSupabaseAuth = middlewares[0];
    return requireSupabaseAuth.options.server({
      next: async () => ({ result: "next" } as any),
      context: {},
    } as any);
  }

  await runAuthChain(isAdmin);
  return loadPmusPanel();
}

describe("getPmusPanel admin authorization", () => {
  it("rejects an unauthenticated request", async () => {
    await expect(runPmusPanelWithAuth(null)).rejects.toThrow("Unauthorized");
  });

  it("rejects an authenticated non-admin request", async () => {
    await expect(runPmusPanelWithAuth("Bearer valid.admin.token", false)).rejects.toThrow(
      "Forbidden: administrator role required",
    );
  });

  it("succeeds for an authenticated admin and returns the panel", async () => {
    const result = await runPmusPanelWithAuth("Bearer valid.admin.token", true);
    expect(result).toHaveProperty("connection");
    expect(result.connection.provider).toBe("Polymarket US");
    expect(loadPmusPanel).toHaveBeenCalled();
  });
});

describe("admin regression guards", () => {
  const source = readFileSync(resolve(__dirname, "./pmus.functions.ts"), "utf-8");

  it("keeps verifyPmusConnectionFn protected by requireAdmin", () => {
    const match = source.match(
      /export\s+const\s+verifyPmusConnectionFn\s*=\s*createServerFn[\s\S]*?\.middleware\(\[requireAdmin\]\)/,
    );
    expect(match).toBeTruthy();
  });

  it("keeps decidePmusPreview protected by requireAdmin", () => {
    const match = source.match(
      /export\s+const\s+decidePmusPreview\s*=\s*createServerFn[\s\S]*?\.middleware\(\[requireAdmin\]\)/,
    );
    expect(match).toBeTruthy();
  });
});
