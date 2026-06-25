import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import { resolve } from "path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../..");

// Workaround for vite-node 2.1.8 + Node >=22 compatibility with `node:sqlite`
// / `bun:sqlite`. vite-node's `normalizeModuleId` strips the `node:` prefix
// unless the id is in its hardcoded `prefixedBuiltins` set (only `node:test`).
// After the strip, downstream resolvers (vite's `tryNodeResolve`, vite-node's
// `isNodeBuiltin`) fail to recognise `sqlite` as a builtin because Node's
// `builtinModules` on >=22.5 returns namespaced entries only (`node:sqlite`),
// never the bare `sqlite`. As a result the loader tries to read `sqlite` as a
// file and fails.
//
// `server.deps.inline` alone (the form documented for vitest 2.x) is not
// enough on vite-node 2.1.8 because the prefix strip happens before
// `shouldExternalize` sees the id. We pair `inline` with a small Vite plugin
// that re-adds the `node:` prefix in `resolveId` and supplies a stub source
// in `load`. The stub uses `require`, which vite-node passes through to
// Node's CJS loader that resolves builtin module specifiers natively, so the
// runtime `await import("node:sqlite")` in
// `extensions/personal-assistant/sqlite.ts` returns the real Node module.
const sqliteBuiltinPlugin = {
  name: "webui:sqlite-builtin-shim",
  enforce: "pre" as const,
  resolveId(id: string) {
    if (id === "sqlite") {
      return { id: "node:sqlite", external: true };
    }
    if (id === "bun:sqlite") {
      return { id: "bun:sqlite", external: true };
    }
    return null;
  },
  load(id: string) {
    if (id === "node:sqlite" || id === "bun:sqlite") {
      return {
        code:
          "const mod = require(" +
          JSON.stringify(id) +
          ");\n" +
          "module.exports = mod;\n",
        map: null,
      };
    }
    return null;
  },
};

export default defineConfig({
  test: {
    include: ["server/test/**/*.test.ts", "server/lib/**/*.test.ts"],
    server: {
      deps: {
        inline: [
          /@earendil-works\/pi-personal-assistant/,
          "node:sqlite",
          "bun:sqlite",
        ],
      },
    },
  },
  plugins: [sqliteBuiltinPlugin],
  resolve: {
    alias: [
      { find: "@earendil-works/pi-ai/compat", replacement: resolve(repoRoot, "packages/ai/src/compat.ts") },
      { find: "@earendil-works/pi-ai/oauth", replacement: resolve(repoRoot, "packages/ai/src/oauth.ts") },
      { find: "@earendil-works/pi-ai", replacement: resolve(repoRoot, "packages/ai/src/index.ts") },
      { find: "@earendil-works/pi-agent-core", replacement: resolve(repoRoot, "packages/agent/src/index.ts") },
      { find: "@earendil-works/pi-coding-agent", replacement: resolve(repoRoot, "packages/coding-agent/src/index.ts") },
      { find: "@earendil-works/pi-personal-assistant", replacement: resolve(__dirname, "../../extensions/personal-assistant/index.ts") },
    ],
  },
});
