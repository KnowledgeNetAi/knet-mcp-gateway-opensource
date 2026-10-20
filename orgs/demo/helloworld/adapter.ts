import type { AppAdapter } from "@/lib/adapters/types";
import type { Json } from "@/lib/types";

// The demo app's code half. Most tools need none: `user_search`, `user_get` and `user_create`
// are fully declarative in api.json. `hello` declares no `request`, so it must be answered by a
// `compose` hook, and this is that hook. It never calls `ctx.get`, so it never reaches the
// upstream. Copy this shape when a tool's answer has to be computed rather than fetched.

function nameOf(args: Json): string {
  const name = args && typeof args === "object" && !Array.isArray(args) ? args.name : undefined;
  return typeof name === "string" && name.trim() !== "" ? name.trim() : "world";
}

export const adapter: AppAdapter = {
  tools: {
    hello: {
      compose: async (args) => {
        const greeted = nameOf(args);
        return { message: `Hello, ${greeted}!`, greeted, servedAt: new Date().toISOString() };
      },
    },
  },
};
