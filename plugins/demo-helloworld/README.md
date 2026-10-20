# Demo: Hello World

Example Claude plugin for the `demo/helloworld` app. It shows the layout
`lib/plugins/catalog.ts` serves from the home page: a manifest, a bundled
`.mcp.json` pointing at this gateway, and skills that each carry a copy of
`plugins/shared/demo-helloworld.md`.

Before you ship your own, set the URL in `.mcp.json` to your gateway's public
origin. OAuth tokens are bound to that origin, so a plugin pointing at another
host will not connect. Build the zip with:

```bash
scripts/build-plugin.sh demo-helloworld
```
