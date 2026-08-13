import { vi, describe, it, expect } from "vitest";
import { requireAdmin } from "../src/lib/admin-auth";

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: vi.fn(),
}));

import { getRequest } from "@tanstack/react-start/server";

describe("admin auth", () => {
  it("rejects unauthenticated", async () => {
    (getRequest as any).mockReturnValue({
      headers: {
        get: (name: string) => (name === "authorization" ? null : undefined),
      },
    });
    const requireSupabaseAuth = requireAdmin.options.middleware[0];
    await expect(
      requireSupabaseAuth.options.server({ next: async () => ({ result: "next" }), context: {} })
    ).rejects.toThrow("Unauthorized");
  });
});
