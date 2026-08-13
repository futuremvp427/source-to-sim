import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "../src/lib/admin-auth";
const getPmusPanel = createServerFn({ method: "GET" }).middleware([requireAdmin]).handler(async () => ({ ok: true }));
console.log("getPmusPanel.options keys", Object.keys(getPmusPanel.options ?? {}));
console.log("getPmusPanel.options.middleware", getPmusPanel.options.middleware?.length);
console.log("getPmusPanel.options.server", typeof getPmusPanel.options.server);
console.log("getPmusPanel.options.server.toString()", getPmusPanel.options.server?.toString?.().slice(0, 200));
