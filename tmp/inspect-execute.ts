import { createServerFn } from "@tanstack/react-start";
import { requireAdmin } from "../src/lib/admin-auth";
const fn = createServerFn({ method: "GET" }).middleware([requireAdmin]).handler(async () => "ok");
console.log("__executeServer", typeof fn.__executeServer, fn.__executeServer);
console.log("__executeServer.toString()", fn.__executeServer.toString().slice(0, 500));
