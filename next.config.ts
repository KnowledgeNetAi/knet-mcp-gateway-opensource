import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // The container runs the app as a plain Node server; standalone output keeps the
  // runtime image small by tracing only the files actually imported.
  //
  // `orgs/**` is the one thing to watch. `getCatalog` reads it with
  // readdirSync/readFileSync at `join(process.cwd(), "orgs")`, not via a static
  // import — and the note in lib/mcp/catalog.ts verified tracing only for a
  // *Vercel* lambda, a different build target than this. Measured directly on
  // Next 16.3.5: `next build` DOES trace orgs/** into .next/standalone. The
  // Dockerfile still copies it explicitly, because the failure mode if that ever
  // changes is silent — see the Dockerfile.
  output: "standalone",

  // Applied to every response. Framing is refused everywhere because the
  // OAuth consent screen is one click from granting access, and no page here
  // is meant to be embedded. `same-origin` keeps OAuth query parameters on
  // the consent and login pages from leaking to other sites. Not
  // `no-referrer`: under it browsers send `Origin: null` on a plain form POST,
  // which fails the consent decision's origin check and Next's Server Action
  // check.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Frame-Options", value: "DENY" },
          { key: "Content-Security-Policy", value: "frame-ancestors 'none'" },
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "Strict-Transport-Security", value: "max-age=31536000" },
        ],
      },
    ];
  },
};

export default nextConfig;
