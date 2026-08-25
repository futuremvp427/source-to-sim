import { describe, expect, it, vi } from "vitest";

import { INGEST_SUCCESS_HEARTBEAT_URL_ENV, pingIngestSuccessHeartbeat } from "./ingest-heartbeat.server";

describe("pingIngestSuccessHeartbeat", () => {
  it("is a no-op when heartbeat configuration is unset", async () => {
    const fetchImpl = vi.fn();
    const result = await pingIngestSuccessHeartbeat({
      env: {},
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ configured: false, ok: null, reason: "UNSET" });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("pings the configured generic HTTP heartbeat endpoint after success", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(new Response(null, { status: 200 }));
    const result = await pingIngestSuccessHeartbeat({
      env: { [INGEST_SUCCESS_HEARTBEAT_URL_ENV]: "https://heartbeat.example/ping/secret-token" },
      fetchImpl: fetchImpl as unknown as typeof fetch,
    });

    expect(result).toEqual({ configured: true, ok: true, status: 200 });
    expect(fetchImpl).toHaveBeenCalledWith(
      "https://heartbeat.example/ping/secret-token",
      expect.objectContaining({ method: "GET", cache: "no-store" }),
    );
  });

  it("logs but does not throw when the heartbeat provider returns a failed status", async () => {
    const logger = { warn: vi.fn() };
    const result = await pingIngestSuccessHeartbeat({
      env: { [INGEST_SUCCESS_HEARTBEAT_URL_ENV]: "https://heartbeat.example/ping/secret-token" },
      fetchImpl: vi.fn().mockResolvedValue(new Response(null, { status: 503 })) as unknown as typeof fetch,
      logger,
    });

    expect(result).toEqual({ configured: true, ok: false, reason: "HTTP_STATUS", status: 503 });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("HTTP 503"));
    expect(logger.warn.mock.calls[0]![0]).not.toContain("secret-token");
  });

  it("logs but does not throw when the heartbeat request itself fails", async () => {
    const logger = { warn: vi.fn() };
    const result = await pingIngestSuccessHeartbeat({
      env: { [INGEST_SUCCESS_HEARTBEAT_URL_ENV]: "https://heartbeat.example/ping/secret-token" },
      fetchImpl: vi.fn().mockRejectedValue(new Error("network down")) as unknown as typeof fetch,
      logger,
    });

    expect(result).toEqual({ configured: true, ok: false, reason: "REQUEST_FAILED" });
    expect(logger.warn).toHaveBeenCalledWith(expect.stringContaining("heartbeat.example"));
    expect(logger.warn.mock.calls[0]![0]).not.toContain("secret-token");
  });
});
