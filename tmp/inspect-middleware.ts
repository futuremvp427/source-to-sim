import { requireAdmin } from "../src/lib/admin-auth";
console.log("options.server:", requireAdmin.options.server);
console.log("typeof options.server:", typeof requireAdmin.options.server);
console.log("options.server.toString():", requireAdmin.options.server.toString().slice(0, 200));
console.log("options.server length:", requireAdmin.options.server.length);
