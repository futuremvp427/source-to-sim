import { createServerFn } from "@tanstack/react-start";

import type { GeneralShadowData } from "./general-shadow.server";

/**
 * General Shadow read model — two general-market wallets, independent ledgers.
 * Read-only: there is no order, signing or mutation path in this module.
 */
export const getGeneralShadow = createServerFn({ method: "GET" }).handler(
  async (): Promise<GeneralShadowData> => {
    const { loadGeneralShadow } = await import("./general-shadow.server");
    return loadGeneralShadow();
  },
);