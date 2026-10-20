import { z } from "zod";

// A discriminated union on `method`, for the same reason `pagination` is one on
// `style`: it makes the shapes structurally distinct rather than bolting an
// optional `body` onto one open object. A GET carrying a `body` fails `.strict()`
// on the GET branch (a body on a GET is never sent and would read as
// configuration that configures nothing), and a POST without one fails the POST
// branch — a POST search with no filter payload is just a slower list tool.
//
// The gateway remains READ-ONLY. That is enforced by `toolSchema`'s refinement
// below (a POST tool must declare `list`), not by this union — see RequestDef in
// lib/types.ts for why the verb alone is not the guard, and what actual write
// support would additionally require.
const requestSchema = z.discriminatedUnion("method", [
  z
    .object({
      method: z.literal("GET"),
      path: z.string().startsWith("/"),
      query: z.record(z.string(), z.string()).optional(),
    })
    .strict(),
  z
    .object({
      method: z.literal("POST"),
      path: z.string().startsWith("/"),
      query: z.record(z.string(), z.string()).optional(),
      body: z.union([
        z.record(z.string(), z.unknown()),
        z.string().regex(/^\{\{\w+\}\}$/),
      ]),
    })
    .strict(),
  // PATCH exists only for writes — there is no such thing as a PATCH read, so
  // unlike POST it needs no disambiguation from the `write` block. DELETE is
  // deliberately absent: it has no field-level policy to express (there are no
  // fields, only a target), so the allowlist mechanism that governs every
  // other mutation would have nothing to say about it.
  z
    .object({
      method: z.literal("PATCH"),
      path: z.string().startsWith("/"),
      query: z.record(z.string(), z.string()).optional(),
      body: z.union([
        z.record(z.string(), z.unknown()),
        z.string().regex(/^\{\{\w+\}\}$/),
      ]),
    })
    .strict(),
]);

// A discriminated union on `style`, not an enum plus an open `params` bag: an
// offset tool must not be able to declare a `page` parameter name (or a page
// tool an `offset` one) — that fails the build here, rather than silently
// paging wrong at runtime. `.strict()` on each branch is what makes a
// cross-style `params` key (or any other typo) a build failure rather than a
// silently-ignored key.
const paginationSchema = z.discriminatedUnion("style", [
  z
    .object({
      style: z.literal("page"),
      perPage: z.number().int().positive(),
      maxPages: z.number().int().positive(),
      params: z.object({ page: z.string().optional(), perPage: z.string().optional() }).strict().optional(),
      pageCountAt: z.string().optional(),
      totalCountAt: z.string().optional(),
    })
    .strict(),
  z
    .object({
      style: z.literal("offset"),
      perPage: z.number().int().positive(),
      maxPages: z.number().int().positive(),
      params: z.object({ limit: z.string().optional(), offset: z.string().optional() }).strict().optional(),
      totalCountAt: z.string().optional(),
    })
    .strict(),
  // Cursor paging. `cursorAt` is the one required key that page/offset have no
  // analogue for, and it is required rather than defaulted for the reason given
  // on PaginationDef in lib/types.ts: a missing cursor path silently degrades to
  // a one-page result reported as complete. No `pageCountAt` on this branch —
  // a cursor API by construction does not know how many pages exist, and
  // declaring one would read as a truncation signal that never fires.
  z
    .object({
      style: z.literal("cursor"),
      perPage: z.number().int().positive(),
      maxPages: z.number().int().positive(),
      params: z.object({ limit: z.string().optional(), cursor: z.string().optional() }).strict().optional(),
      in: z.enum(["query", "body"]).optional(),
      cursorAt: z.string().min(1),
      totalCountAt: z.string().optional(),
    })
    .strict(),
]);

const listSchema = z
  .object({
    itemsAt: z.string(),
    pagination: paginationSchema,
    defaults: z.record(z.string(), z.string()).optional(),
    dedupeBy: z.string().optional(),
  })
  .strict();

const toolSchema = z
  .object({
    name: z.string().regex(/^[a-z][a-z0-9_]*$/),
    description: z.string().min(1),
    input: z.record(z.string(), z.unknown()),
    request: requestSchema.optional(),
    list: listSchema.optional(),
    write: z.object({ fieldsFrom: z.string().min(1) }).strict().optional(),
    audit: z.object({ redact: z.array(z.string()).optional() }).strict().optional(),
  })
  .strict()
  .superRefine((tool, ctx) => {
    // The structural form of "phase 1 is read-only", now that the method is no
    // longer a literal. POST is admitted so a search endpoint whose filters
    // won't fit in a query string can be onboarded; a create/update tool has
    // no collection to page and therefore no `list` block, so it fails here
    // rather than riding in on the widened verb. Not airtight — a determined
    // author could bolt a meaningless `list` onto a mutation — but it is an
    // enforced shape rather than a comment, and it makes a write tool
    // something someone has to deliberately disguise instead of something
    // that merely slips through.
    if (tool.request?.method === "POST" && !tool.list && !tool.write) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["request", "method"],
        message:
          `tool "${tool.name}": a POST tool must declare either a "list" block (it is a ` +
          `paginated search) or a "write" block (it is a mutation, and the write block is ` +
          `what names the argument its field allowlist governs). Declaring neither leaves ` +
          `the tool's effect undecidable from its config.`,
      });
    }

    // A write tool is defined by its `write` block, so these three rules are
    // what keep the block and the verb from disagreeing.
    if (tool.write) {
      if (tool.request && tool.request.method !== "POST" && tool.request.method !== "PATCH") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["request", "method"],
          message: `tool "${tool.name}": a write tool must use POST (create) or PATCH (update)`,
        });
      }
      // A mutation is not a collection read. Pairing the two would also make
      // the runtime page a write — re-submitting it once per page.
      if (tool.list) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["list"],
          message: `tool "${tool.name}": a write tool must not declare a "list" block`,
        });
      }
      // `fieldsFrom` naming an argument the tool does not accept would mean
      // the caller's field bag is never found, never checked against the write
      // allowlist, and never sent — a tool that silently writes nothing. A
      // typo here must fail the build, not the customer's first call.
      const properties = tool.input?.properties;
      if (properties && typeof properties === "object" && !Array.isArray(properties)) {
        if (!Object.hasOwn(properties as Record<string, unknown>, tool.write.fieldsFrom)) {
          ctx.addIssue({
            code: z.ZodIssueCode.custom,
            path: ["write", "fieldsFrom"],
            message:
              `tool "${tool.name}": write.fieldsFrom "${tool.write.fieldsFrom}" is not one of ` +
              `this tool's declared input properties`,
          });
        }
      }
    } else if (tool.request?.method === "PATCH") {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["request", "method"],
        message: `tool "${tool.name}": PATCH is a mutation and must declare a "write" block`,
      });
    }

    // A cursor tool paging in the body has nowhere to put the cursor unless
    // there is a body to put it in. Caught here because the two halves live in
    // different blocks of the same tool (`request.body` and
    // `list.pagination.in`), which no single-object `.strict()` can relate.
    if (tool.list?.pagination.style === "cursor" && tool.list.pagination.in === "body") {
      if (tool.request?.method !== "POST") {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ["list", "pagination", "in"],
          message: `tool "${tool.name}": pagination.in "body" requires a POST request with a body`,
        });
      }
    }
  });

export const appConfigSchema = z
  .object({
    app: z.string().regex(/^[a-z][a-z0-9-]*$/),
    displayName: z.string().min(1),
    baseUrl: z.string().url(),
    auth: z.discriminatedUnion("type", [
      // No upstream credential. Nothing else is accepted on this branch, so a
      // half-deleted OAuth block fails the build rather than being ignored.
      z.object({ type: z.literal("none") }).strict(),
      z
        .object({
          // An enum, not a literal: both grants run the same token-mint code
          // path in lib/adapters/auth.ts, which reads this value to choose
          // `grant_type`. Adding a third grant is a change there and here, not
          // a config-only change.
          type: z.enum(["oauth2_client_credentials", "oauth2_refresh_token"]),
          tokenUrl: z.string().url(),
          bodyFormat: z.enum(["json", "form"]),
          secrets: z.record(z.string(), z.string()),
          expiry: z
            .object({
              field: z.string(),
              coerce: z.literal("number"),
              skewSeconds: z.number().int().nonnegative(),
            })
            .strict(),
        })
        .strict(),
    ]),
    transport: z
      .object({
        minIntervalMs: z.number().int().nonnegative(),
        timeoutMs: z.number().int().positive(),
        retry: z
          .object({
            attempts: z.number().int().positive(),
            on: z.array(z.string()),
            respectRetryAfter: z.boolean(),
          })
          .strict(),
        // "ALSO FOLD IN" (Task 12 final review): `errors.extract` used to be declared here
        // ("sentence", optional) and read by nothing — `lib/http/client.ts`'s `summarize`
        // always runs its sentence-extraction heuristic whenever `format === "html"`, with no
        // branch that ever consults an `extract` value. `.strict()` on this object is exactly
        // what exists to prevent a "reads as configuration, configures nothing" key from
        // sitting in a committed `api.json` unnoticed; removing the schema key instead of
        // leaving it declared-but-inert closes the gap `.strict()` alone could not (a config
        // author writing `extract: "sentence"` was never rejected, since it matched the
        // schema).
        errors: z
          .object({
            format: z.enum(["json", "html"]),
          })
          .strict(),
        rateLimit: z
          .object({
            remainingHeader: z.string().min(1),
            resetHeader: z.string().min(1),
          })
          .strict()
          .optional(),
      })
      .strict(),
    tools: z.array(toolSchema),
    // Header name → Vault secret path. Resolved at call time and merged into
    // every upstream API request. Validated by loadCatalog to start with the
    // org/app prefix (same rule as auth.secrets paths).
    requestHeaders: z.record(z.string(), z.string()).optional(),
  })
  .strict();

// `.strict()` on the field rule is what rejects `deny`: the spec settled on
// allowlists only, and a silently-ignored deny key would read as enforcement.
const fieldRuleSchema = z.object({ allow: z.array(z.string()).min(1) }).strict();

// The WRITE rule is the same shape with one rule the read side does not have:
// no wildcards. `filterFields` grants a whole subtree for `"*"` or a trailing
// `".*"`, and the equivalent on the write side would let a caller overwrite
// any field the vendor ever adds — including ones that did not exist when
// anybody reviewed this role. Reading and writing are not symmetric, so a
// write allowlist must name every field it grants, and a wildcard is a build
// failure rather than a lint the way it is for `fields` (see orgs/orgs.test.ts).
const writeRuleSchema = z
  .object({
    allow: z
      .array(
        z
          .string()
          .min(1)
          .refine((f) => f !== "*" && !f.endsWith(".*"), {
            message:
              "a write allowlist must name every writable field — wildcards would grant fields " +
              "that did not exist when this role was reviewed",
          }),
      )
      .min(1),
  })
  .strict();

export const rolesConfigSchema = z
  .object({
    roles: z.record(
      z.string(),
      z.object({
        tools: z.array(z.string()),
        fields: z.record(z.string(), fieldRuleSchema),
        writes: z.record(z.string(), writeRuleSchema).optional(),
      }).strict(),
    ),
  })
  .strict();
