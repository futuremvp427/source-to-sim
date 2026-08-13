import { vi, describe, it, expect } from "vitest";

vi.mock("@tanstack/react-start/server", () => ({
  getRequest: vi.fn(),
}));

import { getRequest } from "@tanstack/react-start/server";
import { requireAdmin } from "./admin-auth";

const mockedGetRequest = vi.mocked(getRequest);

describe("requireAdmin middleware", () => {
  it("rejects unauthenticated", async () => {
    mockedGetRequest.mockReturnValue({
      headers: {
        get: (name: string) => (name === "authorization" ? null : undefined),
      },
    } as any);
    const requireSupabaseAuth = requireAdmin.options.middleware[0];
    await expect(
      requireSupabaseAuth.options.server({ next: async () => ({ result: "next" }), context: {} })
    ).rejects.toThrow("Unauthorized");
  });
});
