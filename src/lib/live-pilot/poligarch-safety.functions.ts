import { createServerFn } from "@tanstack/react-start";
import { z } from "zod";

import { requireAdmin } from "../admin-auth";
import type { PilotSafetyState } from "./poligarch-safety-core";

/** Read-only Poligarch V2 live-pilot safety state: kill switch, stage, caps. */
export const getPoligarchPilotSafety = createServerFn({ method: "GET" })
  .middleware([requireAdmin])
  .handler(async (): Promise<PilotSafetyState> => {
    const { loadPoligarchPilotSafety } = await import("./poligarch-safety.server");
    return loadPoligarchPilotSafety();
  });

export const setPoligarchKillSwitch = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((data) => z.object({ engaged: z.boolean() }).parse(data))
  .handler(async ({ data, context }): Promise<void> => {
    const { engagePoligarchKillSwitch, releasePoligarchKillSwitch } =
      await import("./poligarch-safety.server");
    return data.engaged
      ? engagePoligarchKillSwitch(context.userId)
      : releasePoligarchKillSwitch(context.userId);
  });

export const enterPoligarchPreviewStage = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async ({ context }): Promise<void> => {
    const { enterPreviewStage } = await import("./poligarch-safety.server");
    return enterPreviewStage(context.userId);
  });

export const enterPoligarchLivePilotStage = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .inputValidator((data) => z.object({ confirmPhrase: z.string() }).parse(data))
  .handler(async ({ data, context }): Promise<void> => {
    const { enterLivePilotStage } = await import("./poligarch-safety.server");
    return enterLivePilotStage(context.userId, data.confirmPhrase);
  });

export const abortPoligarchToLocked = createServerFn({ method: "POST" })
  .middleware([requireAdmin])
  .handler(async ({ context }): Promise<void> => {
    const { abortToLocked } = await import("./poligarch-safety.server");
    return abortToLocked(context.userId);
  });
