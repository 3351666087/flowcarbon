// Bundles the server entry points into dist/server. Workspace packages (TypeScript sources) are bundled;
// third-party packages stay external and are installed in the image with `npm ci --omit=dev`.
import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

const out = "dist/server";
await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

const externalThirdParty = {
  name: "external-third-party",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, (args) => {
      if (args.path.startsWith("@flowcarbon/") || args.path.startsWith("node:")) return null;
      return { path: args.path, external: true };
    });
  },
};

await build({
  entryPoints: {
    api: "apps/api/src/server.ts",
    worker: "apps/worker/src/main.ts",
    migrate: "scripts/migrate-all.ts",
    seed: "packages/demo/src/cli.ts",
    pump: "packages/demo/src/pump-cli.ts",
    case: "packages/demo/src/case-cli.ts",
  },
  outdir: out,
  outExtension: { ".js": ".mjs" },
  bundle: true,
  platform: "node",
  format: "esm",
  target: "node22",
  sourcemap: "linked",
  legalComments: "none",
  plugins: [externalThirdParty],
  logLevel: "info",
});
await cp("packages/db/drizzle", `${out}/drizzle`, { recursive: true });
await writeFile(`${out}/package.json`, `${JSON.stringify({ type: "module", private: true }, null, 2)}\n`);
console.log(`server bundle written to ${out}`);
