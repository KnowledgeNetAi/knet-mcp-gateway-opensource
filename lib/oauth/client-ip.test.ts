import { describe, expect, it } from "vitest";
import { NextRequest } from "next/server";


import { clientIp } from "@/lib/oauth/client-ip";

const req = (xff?: string) =>
  new NextRequest("https://gw.example.com/oauth/register", {
    method: "POST",
    headers: xff ? { "x-forwarded-for": xff } : {},
  });

describe("clientIp", () => {
  it("uses the address the nearest proxy appended, not one the client sent", () => {
    expect(clientIp(req("10.9.1.1, 198.51.100.7"))).toBe("198.51.100.7");
    expect(clientIp(req("10.9.2.1, 198.51.100.7"))).toBe("198.51.100.7");
  });

  it("falls back when no forwarding header is present", () => {
    expect(clientIp(req())).toBe("unknown");
  });
});
