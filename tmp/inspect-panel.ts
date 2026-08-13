import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "../src/lib/admin-auth";
const getPmusPanel = createServerFn({ method: "GET" }).middleware([requireAdmin]).handler(async () => ({ ok: true }));
for (const [k, v] of Object.entries(getPmusPanel)) {
  console.log(k, typeof v, v?.toString?.()?.slice?.(0, 100));
}
console.log("executeServer:", getPmusPanel.__executeServer?.toString());
