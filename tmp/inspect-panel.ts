import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "../src/lib/admin-auth";
const getPmusPanel = createServerFn({ method: "GET" }).middleware([requireAdmin]).handler(async () => ({ ok: true }));
const names = Object.getOwnPropertyNames(getPmusPanel);
console.log(names);
const proto = Object.getPrototypeOf(getPmusPanel);
console.log(proto === Function.prototype);
console.log("__executeServer own props:", Object.getOwnPropertyNames(getPmusPanel.__executeServer));
