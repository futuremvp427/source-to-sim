import { describe, expect, it, vi } from "vitest";

/**
 * Regression test for the source_event_key audit-trail bug: the RPC payload
 * sent to create_or_get_live_pilot_intent_atomic must carry the source
 * event's `event_key` text field (RawSourceEvent.eventKey), NOT its uuid
 * primary key (RawSourceEvent.id). Sending `id` there would silently
 * corrupt every live_order_intents.source_event_key value.
 *
 * Mocks the same module seam other live-pilot tests use for supabaseAdmin
 * (see poligarch-safety.server.test.ts) so this exercises the real
 * createOrGetLivePilotIntent RPC wrapper, not just previewPoligarchLiveOrder's
 * injected-dependency indirection (which never calls the real wrapper).
 */

const rpcMock = vi.fn(async (_fnName: string, _args: Record<string, unknown>) => ({
  data: { intent_id: "intent-1", created: true, status: "PREVIEWED" },
  error: null,
}));

vi.mock("@/integrations/supabase/client.server", () => ({
  supabaseAdmin: {
    rpc: (fnName: string, args: Record<string, unknown>) => rpcMock(fnName, args),
  },
}));

const { createOrGetLivePilotIntent } = await import("./poligarch-preview.server");
const { POLIGARCH_V2_EXPERIMENT_NAME, POLIGARCH_V2_WALLET, POLIGARCH_LIVE_PILOT_ID } = await import(
  "./poligarch-config"
);

describe("createOrGetLivePilotIntent RPC payload", () => {
  it("sends source_events.event_key (eventKey), not the uuid id, as source_event_key", async () => {
    await createOrGetLivePilotIntent({
      id: "evt-uuid-1",
      eventKey: "evt-1-key",
      experimentId: "exp-1",
      experimentName: POLIGARCH_V2_EXPERIMENT_NAME,
      wallet: POLIGARCH_V2_WALLET,
      conditionId: "0xcond",
      asset: "tok-a",
      marketTitle: "Will it snow in Chicago by Feb 1?",
      outcome: "YES",
      side: "BUY",
      price: 0.5,
      sourceTs: 1_700_000_000,
    });

    expect(rpcMock).toHaveBeenCalledTimes(1);
    const [fnName, args] = rpcMock.mock.calls[0]!;
    expect(fnName).toBe("create_or_get_live_pilot_intent_atomic");
    const payload = args["p_payload"] as Record<string, unknown>;
    expect(payload["source_event_key"]).toBe("evt-1-key");
    expect(payload["source_event_key"]).not.toBe("evt-uuid-1");
    expect(args["p_source_event_id"]).toBe("evt-uuid-1");
    expect(args["p_pilot_id"]).toBe(POLIGARCH_LIVE_PILOT_ID);
  });
});
