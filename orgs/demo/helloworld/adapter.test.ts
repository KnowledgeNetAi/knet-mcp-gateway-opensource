import { describe, expect, it } from "vitest";
import { adapter } from "./adapter";
import type { UpstreamContext } from "@/lib/adapters/types";
import type { AppConfig, ToolDef } from "@/lib/types";

const ctx: UpstreamContext = {
  config: {} as AppConfig,
  log: () => {},
  get: async () => {
    throw new Error("hello must not call the upstream");
  },
};
const tool = { name: "hello" } as ToolDef;

describe("demo/helloworld adapter", () => {
  it("greets the name it is given", async () => {
    const out = await adapter.tools.hello.compose!({ name: "Ada" }, tool, ctx);
    expect(out).toMatchObject({ message: "Hello, Ada!", greeted: "Ada" });
  });

  it("greets the world when no name is given", async () => {
    const out = await adapter.tools.hello.compose!({}, tool, ctx);
    expect(out).toMatchObject({ message: "Hello, world!", greeted: "world" });
  });
});
