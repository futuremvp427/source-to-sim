import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "../src/lib/admin-auth";
const getPmusPanel = createServerFn({ method: "GET" }).middleware([requireAdmin]).handler(async () => ({ ok: true }));
console.dir(getPmusPanel, { depth: 5 });
