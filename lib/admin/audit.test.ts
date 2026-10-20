import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Viewer } from "@/lib/authz/viewer";

// `vi.hoisted` is required because `vi.mock` factories are hoisted above
// imports, so the mock can't close over an ordinary module-scope `const`
// declared after it. Follows the pattern in `lib/secrets/vault.test.ts`.
const { insertMock, fromMock } = vi.hoisted(() => ({
  insertMock: vi.fn(),
  fromMock: vi.fn(),
}));

vi.mock("@/lib/supabase/admin", () => ({
  createAdminClient: () => ({ from: fromMock }),
}));

import { writeAdminAudit } from "@/lib/admin/audit";

function makeViewer(overrides: Partial<Viewer> = {}): Viewer {
  return {
    userId: "u1",
    email: "a@b.co",
    isSuperAdmin: false,
    orgs: [],
    ...overrides,
  };
}

beforeEach(() => {
  vi.clearAllMocks();
  fromMock.mockImplementation((table: string) => {
    if (table !== "admin_audit_events") throw new Error(`unexpected table ${table}`);
    return { insert: insertMock };
  });
  insertMock.mockResolvedValue({ error: null });
});

describe("writeAdminAudit", () => {
  it("stamps actor_user_id and actor_was_super from the viewer", async () => {
    const viewer = makeViewer({ userId: "u42", isSuperAdmin: true });
    await writeAdminAudit({
      viewer,
      orgId: "org-1",
      action: "org.create",
      outcome: "ok",
    });

    expect(insertMock).toHaveBeenCalledTimes(1);
    const inserted = insertMock.mock.calls[0][0];
    expect(inserted.actor_user_id).toBe("u42");
    expect(inserted.actor_was_super).toBe(true);
    expect(inserted.org_id).toBe("org-1");
    expect(inserted.action).toBe("org.create");
    expect(inserted.outcome).toBe("ok");
  });

  // The single most important assertion here: a caller cannot under-report
  // that a super admin performed the action by passing its own flag —
  // there is no such flag in the input shape at all, but this guards
  // against a future refactor accidentally reading from somewhere else.
  it("derives actor_was_super from the viewer, not from any caller-supplied value", async () => {
    const viewer = makeViewer({ isSuperAdmin: false });
    await writeAdminAudit({
      viewer,
      orgId: null,
      action: "member.invite",
      // @ts-expect-error -- deliberately probing that a stray flag on the
      // input object cannot influence the stored actor_was_super.
      actor_was_super: true,
      outcome: "ok",
    });

    const inserted = insertMock.mock.calls[0][0];
    expect(inserted.actor_was_super).toBe(false);
  });

  it("never writes a value under a key named secret, password, client_secret, target_id, token, api_key, or key", async () => {
    const viewer = makeViewer();
    await writeAdminAudit({
      viewer,
      orgId: "o1",
      action: "credential.write",
      detail: {
        key: "client_secret", // the NAME of a field is legitimate data
        client_secret: "shhh",
        secret: "shh2",
        password: "hunter2",
        target_id: "victim-id",
        token: "t0k3n",
        api_key: "ak-123",
        note: "servicefusion credentials rotated",
      },
      outcome: "ok",
    });

    const inserted = insertMock.mock.calls[0][0];
    const serialized = JSON.stringify(inserted.detail);
    expect(serialized).not.toMatch(/shhh/);
    expect(serialized).not.toMatch(/shh2/);
    expect(serialized).not.toMatch(/hunter2/);
    expect(serialized).not.toMatch(/victim-id/);
    expect(serialized).not.toMatch(/t0k3n/);
    expect(serialized).not.toMatch(/ak-123/);

    expect(inserted.detail.key).toBe("client_secret");
    expect(inserted.detail.client_secret).toBe("[redacted]");
    expect(inserted.detail.secret).toBe("[redacted]");
    expect(inserted.detail.password).toBe("[redacted]");
    expect(inserted.detail.target_id).toBe("[redacted]");
    expect(inserted.detail.token).toBe("[redacted]");
    expect(inserted.detail.api_key).toBe("[redacted]");
    expect(inserted.detail.note).toBe("servicefusion credentials rotated");
  });

  it("redacts a secret value nested at any depth, not only at the top level", async () => {
    const viewer = makeViewer();
    await writeAdminAudit({
      viewer,
      orgId: "o1",
      action: "credential.write",
      detail: {
        connection: {
          servicefusion: {
            fields: [{ client_secret: "deep-shhh", label: "Client secret" }],
          },
        },
      },
      outcome: "ok",
    });

    const inserted = insertMock.mock.calls[0][0];
    const serialized = JSON.stringify(inserted.detail);
    expect(serialized).not.toMatch(/deep-shhh/);
    expect(inserted.detail.connection.servicefusion.fields[0].client_secret).toBe(
      "[redacted]",
    );
    expect(inserted.detail.connection.servicefusion.fields[0].label).toBe("Client secret");
  });

  it("stores null detail when detail is omitted", async () => {
    const viewer = makeViewer();
    await writeAdminAudit({
      viewer,
      orgId: "o1",
      action: "apikey.issue",
      outcome: "ok",
    });

    const inserted = insertMock.mock.calls[0][0];
    expect(inserted.detail).toBeNull();
  });

  it("passes target through untouched", async () => {
    const viewer = makeViewer();
    await writeAdminAudit({
      viewer,
      orgId: "o1",
      action: "apikey.revoke",
      target: "key-abc123",
      outcome: "denied",
    });

    const inserted = insertMock.mock.calls[0][0];
    expect(inserted.target).toBe("key-abc123");
    expect(inserted.outcome).toBe("denied");
  });

  it("never throws when the insert fails — an audit failure must not fail the action", async () => {
    insertMock.mockResolvedValue({ error: { message: "boom" } });
    const viewer = makeViewer();
    await expect(
      writeAdminAudit({
        viewer,
        orgId: "o1",
        action: "role.assign",
        outcome: "ok",
      }),
    ).resolves.toBeUndefined();
  });

  it("never throws when the client itself throws synchronously", async () => {
    fromMock.mockImplementation(() => {
      throw new Error("connection reset");
    });
    const viewer = makeViewer();
    await expect(
      writeAdminAudit({
        viewer,
        orgId: "o1",
        action: "role.revoke",
        outcome: "error",
      }),
    ).resolves.toBeUndefined();
  });

  it("never throws when insert() itself rejects", async () => {
    insertMock.mockRejectedValue(new Error("network down"));
    const viewer = makeViewer();
    await expect(
      writeAdminAudit({
        viewer,
        orgId: null,
        action: "superadmin.grant",
        outcome: "ok",
      }),
    ).resolves.toBeUndefined();
  });

  it("handles a circular detail object without throwing, redacting the rest normally", async () => {
    const viewer = makeViewer();
    const cyclic: Record<string, unknown> = { note: "ok", client_secret: "cyc-shhh" };
    cyclic.self = cyclic;

    await expect(
      writeAdminAudit({
        viewer,
        orgId: "o1",
        action: "credential.write",
        detail: cyclic,
        outcome: "ok",
      }),
    ).resolves.toBeUndefined();

    const inserted = insertMock.mock.calls[0][0];
    expect(inserted.detail.client_secret).toBe("[redacted]");
    expect(inserted.detail.note).toBe("ok");
    expect(JSON.stringify(inserted.detail)).not.toMatch(/cyc-shhh/);
  });
});
