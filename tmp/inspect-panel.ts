import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "../src/lib/admin-auth";
const getPmusPanel = createServerFn({ method: "GET" }).middleware([requireAdmin]).handler(async () => ({ ok: true }));
console.log("getPmusPanel keys", Object.keys(getPmusPanel));
console.log("getPmusPanel", getPmusPanel);
console.log("getPmusPanel.__executeServer options", (getPmusPanel as any).__executeServer?.toString?.().slice(0, 300));
