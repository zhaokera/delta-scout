import { copyFile, mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionRoot = resolve(
  projectRoot,
  "extensions/panzhi-auto-refresh"
);
const outputDirectory = resolve(
  projectRoot,
  "extensions/panzhi-auto-refresh/dist"
);

await rm(outputDirectory, { recursive: true, force: true });
await mkdir(outputDirectory, { recursive: true });

await build({
  entryPoints: {
    background: resolve(
      projectRoot,
      "extensions/panzhi-auto-refresh/src/background.ts"
    ),
    content: resolve(
      projectRoot,
      "extensions/panzhi-auto-refresh/src/content.ts"
    )
  },
  outdir: outputDirectory,
  bundle: true,
  charset: "utf8",
  format: "esm",
  legalComments: "none",
  logLevel: "info",
  minify: false,
  platform: "browser",
  sourcemap: false,
  target: ["chrome120"],
  treeShaking: true
});

await copyFile(
  resolve(extensionRoot, "manifest.json"),
  resolve(outputDirectory, "manifest.json")
);
