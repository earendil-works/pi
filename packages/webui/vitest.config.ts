import { defineConfig } from "vitest/config";
import { fileURLToPath } from "url";
import { resolve } from "path";

const __dirname = fileURLToPath(new URL(".", import.meta.url));
const repoRoot = resolve(__dirname, "../..");

export default defineConfig({
  test: {
    include: ["server/test/**/*.test.ts"],
  },
  resolve: {
    alias: {
      "@earendil-works/pi-ai": resolve(repoRoot, "packages/ai/src/index.ts"),
      "@earendil-works/pi-ai/oauth": resolve(repoRoot, "packages/ai/src/oauth.ts"),
      "@earendil-works/pi-agent-core": resolve(repoRoot, "packages/agent/src/index.ts"),
      "@earendil-works/pi-coding-agent": resolve(repoRoot, "packages/coding-agent/src/index.ts"),
      "@earendil-works/pi-personal-assistant": resolve(__dirname, "../../extensions/personal-assistant/index.ts"),
    },
  },
});
