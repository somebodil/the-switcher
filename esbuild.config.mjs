import path from "node:path";
import esbuild from "esbuild";

// `node esbuild.config.mjs production` builds once. Without the argument it rebuilds on every change.
const production = process.argv[2] === "production";

/**
 * Builds src/regex-worker.ts by itself, for src/regex-guard.ts to import as
 * the text of its code: a plugin has one file of code, main.js, so the worker
 * cannot have a file of its own.
 */
const regexWorker = {
  name: "regex-worker",
  setup(build) {
    build.onResolve({ filter: /^virtual:regex-worker$/ }, () => ({
      path: "regex-worker",
      namespace: "virtual",
    }));
    build.onLoad({ filter: /.*/, namespace: "virtual" }, async () => {
      const entry = "src/regex-worker.ts";
      try {
        const result = await esbuild.build({
          entryPoints: [entry],
          bundle: true,
          format: "iife",
          target: "es2020",
          minify: production,
          write: false,
          metafile: true,
          logLevel: "silent",
        });
        return {
          contents: `export default ${JSON.stringify(result.outputFiles[0].text)};`,
          loader: "js",
          watchFiles: Object.keys(result.metafile.inputs).map((file) => path.resolve(file)),
        };
      } catch (error) {
        return {
          errors: error.errors ?? [{ text: String(error) }],
          watchFiles: [path.resolve(entry)],
        };
      }
    });
  },
};

const context = await esbuild.context({
  entryPoints: ["src/main.ts"],
  outfile: "main.js",
  bundle: true,
  format: "cjs",
  target: "es2020",
  // Obsidian provides it at run time
  external: ["obsidian"],
  plugins: [regexWorker],
  minify: production,
  sourcemap: production ? false : "inline",
  logLevel: "info",
});

if (production) {
  await context.rebuild();
  await context.dispose();
} else {
  await context.watch();
}
