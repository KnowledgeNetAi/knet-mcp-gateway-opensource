import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Cloud Run runs the app as a plain Node server; standalone output keeps the
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
};

export default nextConfig;
