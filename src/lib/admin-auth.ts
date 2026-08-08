import { createMiddleware } from "@tanstack/react-start";

import { requireSupabaseAuth } from "@/integrations/supabase/auth-middleware";

/**
 * Authorization boundary for every privileged control-plane mutation.
 *
 * requireSupabaseAuth validates the bearer token server-side; this middleware
 * then requires an explicit `admin` grant in public.user_roles (checked through
 * the security-definer has_role function as the calling user, never with the
 * service role). Unauthenticated or non-admin requests never reach the handler.
 */
export const requireAdmin = createMiddleware({ type: "function" })
  .middleware([requireSupabaseAuth])
  .server(async ({ next, context }) => {
    const { data, error } = await context.supabase.rpc("has_role", {
      _user_id: context.userId,
      _role: "admin",
    });
    if (error) throw new Error("Forbidden: role check failed");
    if (data !== true) throw new Error("Forbidden: administrator role required");
    return next({ context });
  });
