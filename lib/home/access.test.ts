import { beforeEach, describe, expect, it, vi } from "vitest";

const { fromMock } = vi.hoisted(() => ({ fromMock: vi.fn() }));
vi.mock("server-only", () => ({}));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: () => ({ from: fromMock }) }));

import { viewerRolesByOrg } from "@/lib/home/access";

describe("viewerRolesByOrg", () => {
  beforeEach(() => vi.clearAllMocks());

  it("scopes the role query to both the viewer and their organizations", async () => {
    const inMock = vi.fn().mockResolvedValue({
      data: [
        { org_id: "o1", role: "tech" },
        { org_id: "o1", role: "bookkeeper" },
      ],
      error: null,
    });
    const eqMock = vi.fn().mockReturnValue({ in: inMock });
    const selectMock = vi.fn().mockReturnValue({ eq: eqMock });
    fromMock.mockReturnValue({ select: selectMock });

    const roles = await viewerRolesByOrg("u1", ["o1", "o2"]);

    expect(fromMock).toHaveBeenCalledWith("role_assignments");
    expect(eqMock).toHaveBeenCalledWith("user_id", "u1");
    expect(inMock).toHaveBeenCalledWith("org_id", ["o1", "o2"]);
    expect(roles.get("o1")).toEqual(["bookkeeper", "tech"]);
  });

  it("does not issue an unscoped query for a viewer with no organizations", async () => {
    expect(await viewerRolesByOrg("u1", [])).toEqual(new Map());
    expect(fromMock).not.toHaveBeenCalled();
  });
});
