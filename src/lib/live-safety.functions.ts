import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireAdmin } from "./admin-auth";
import type { LiveSafetyData, SafetyActionResult } from "./live-safety.server";

/** Read-only live-safety status: qualification, caps, stage, allocation. */
export const getLiveSafety = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async (): Promise<LiveSafetyData> => {
    const { loadLiveSafety } = await import("./live-safety.server");
    return loadLiveSafety();
  });

export const setKillSwitch = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((data) => z.object({ engaged: z.boolean() }).parse(data))
  .handler(async ({ data, context }): Promise<SafetyActionResult> => {
    const { engageKillSwitch, releaseKillSwitch } = await import("./live-safety.server");
    return data.engaged
      ? engageKillSwitch(context.userId)
      : releaseKillSwitch(context.userId);
  });

export const armLiveActivation = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async ({ context }): Promise<SafetyActionResult> => {
    const { armActivation } = await import("./live-safety.server");
    return armActivation(context.userId);
  });

export const confirmLiveActivation = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((data) => z.object({ confirmPhrase: z.string() }).parse(data))
  .handler(async ({ data, context }): Promise<SafetyActionResult> => {
    const { confirmActivation } = await import("./live-safety.server");
    return confirmActivation(context.userId, data.confirmPhrase);
  });

export const abortLiveActivation = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async ({ context }): Promise<SafetyActionResult> => {
    const { abortActivation } = await import("./live-safety.server");
    return abortActivation(context.userId);
  });
