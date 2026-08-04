import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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

const rootManifest = JSON.parse(await readFile(
  resolve(extensionRoot, "manifest.json"),
  "utf8"
));
const stripDistributionPrefix = (path) => path.replace(/^dist\//u, "");
const distributionManifest = {
  ...rootManifest,
  background: {
    ...rootManifest.background,
    service_worker: stripDistributionPrefix(
      rootManifest.background.service_worker
    )
  },
  content_scripts: rootManifest.content_scripts.map((entry) => ({
    ...entry,
    js: entry.js.map(stripDistributionPrefix)
  }))
};

await writeFile(
  resolve(outputDirectory, "manifest.json"),
  `${JSON.stringify(distributionManifest, null, 2)}\n`,
  "utf8"
);
