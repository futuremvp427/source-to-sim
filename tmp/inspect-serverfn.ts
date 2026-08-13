import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "../src/lib/admin-auth";
const fn = createServerFn({ method: "GET" }).middleware([requireAdmin]).handler(async () => "ok");
console.log("serverfn", typeof fn);
console.log("serverfn keys", Object.keys(fn));
console.log("serverfn.toString", fn.toString());
console.log("fn.options", Object.keys(fn.options ?? {}));
console.log("fn.meta", fn.meta);
fn().then(r => console.log("result", r)).catch(e => console.log("error", e.message));
