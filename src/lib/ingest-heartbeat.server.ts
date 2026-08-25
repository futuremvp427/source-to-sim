export const INGEST_SUCCESS_HEARTBEAT_URL_ENV = "INGEST_SUCCESS_HEARTBEAT_URL";
export const INGEST_HEARTBEAT_TIMEOUT_MS = 5_000;

export type IngestHeartbeatResult =
  | { configured: false; ok: null; reason: "UNSET" }
  | { configured: true; ok: true; status: number }
  | { configured: true; ok: false; reason: "INVALID_URL" | "HTTP_STATUS" | "REQUEST_FAILED"; status?: number };

type HeartbeatDeps = {
  env?: Record<string, string | undefined>;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "warn">;
  timeoutMs?: number;
};

function safeEndpointLabel(url: URL): string {
  return url.hostname || "configured endpoint";
}

/**
 * Optional external dead-man's-switch ping for the scheduled ingest hook.
 *
 * This is intentionally best-effort: the provider is outside the ingestion
 * correctness path, so any configuration/provider/network failure is logged and
 * returned as diagnostic status, never thrown.
 */
export async function pingIngestSuccessHeartbeat(deps: HeartbeatDeps = {}): Promise<IngestHeartbeatResult> {
  const env = deps.env ?? (process.env as Record<string, string | undefined>);
  const logger = deps.logger ?? console;
  const rawUrl = (env[INGEST_SUCCESS_HEARTBEAT_URL_ENV] ?? "").trim();
  if (!rawUrl) return { configured: false, ok: null, reason: "UNSET" };

  let url: URL;
  try {
    url = new URL(rawUrl);
    if (url.protocol !== "https:" && url.protocol !== "http:") throw new Error("unsupported protocol");
  } catch {
    logger.warn("[ingest-heartbeat] configured heartbeat URL is invalid; heartbeat skipped");
    return { configured: true, ok: false, reason: "INVALID_URL" };
  }

  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), deps.timeoutMs ?? INGEST_HEARTBEAT_TIMEOUT_MS);
  try {
    const response = await (deps.fetchImpl ?? fetch)(url.toString(), {
      method: "GET",
      cache: "no-store",
      signal: controller.signal,
    });
    if (!response.ok) {
      logger.warn(`[ingest-heartbeat] provider returned HTTP ${response.status} for ${safeEndpointLabel(url)}`);
      return { configured: true, ok: false, reason: "HTTP_STATUS", status: response.status };
    }
    return { configured: true, ok: true, status: response.status };
  } catch (err) {
    const message = err instanceof Error ? err.name : "request failed";
    logger.warn(`[ingest-heartbeat] request failed for ${safeEndpointLabel(url)}: ${message}`);
    return { configured: true, ok: false, reason: "REQUEST_FAILED" };
  } finally {
    clearTimeout(timeout);
  }
}
