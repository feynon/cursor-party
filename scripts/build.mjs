import { cp, mkdir, rm, writeFile } from "node:fs/promises";
import { build } from "esbuild";

await rm("dist", { recursive: true, force: true });
await mkdir("dist", { recursive: true });
await cp("public", "dist", { recursive: true });
await build({
  entryPoints: ["src/cursors.tsx"],
  outfile: "dist/cursors.js",
  bundle: true,
  minify: true,
  format: "iife",
  platform: "browser",
  target: "es2020",
  alias: { react: "@preact/compat", "react-dom": "@preact/compat" },
});
await writeFile("dist/_headers", "/cursors.js\n  Cache-Control: public, max-age=300\n");
