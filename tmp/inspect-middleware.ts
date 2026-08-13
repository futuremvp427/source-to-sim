import { requireAdmin } from "../src/lib/admin-auth";
console.log("requireAdmin callable:", typeof requireAdmin);
console.log("requireAdmin.options.middleware length:", requireAdmin.options.middleware.length);
for (let i = 0; i < requireAdmin.options.middleware.length; i++) {
  const m = requireAdmin.options.middleware[i];
  console.log(`middleware[${i}] keys:`, Object.keys(m));
  console.log(`middleware[${i}].options.server:`, typeof m.options?.server, m.options?.server?.toString?.().slice(0, 100));
}
