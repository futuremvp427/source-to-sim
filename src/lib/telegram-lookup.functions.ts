import { createServerFn } from "@tanstack/react-start";

/** Server-only lookup. Returns only the numeric chat.id. */
export const findLatestPrivateStartChatIdFn = createServerFn({ method: "POST" }).handler(
  async (): Promise<number> => {
    const { findLatestPrivateStartChatId } = await import("./telegram-lookup.server");
    return findLatestPrivateStartChatId();
  },
);
