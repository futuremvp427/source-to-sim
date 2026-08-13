import { requireAdmin } from "../src/lib/admin-auth";
console.log("requireAdmin keys:", Object.keys(requireAdmin));
console.log("requireAdmin prototype:", Object.getPrototypeOf(requireAdmin));
console.log("requireAdmin", requireAdmin);
