// Build-time assertion: the agent route imports @earendil-works/pi-coding-agent, which resolves to a built
// workspace artifact. Fail the build if that file is missing rather than at the first enabled request.
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

const entry = fileURLToPath(import.meta.resolve("@earendil-works/pi-coding-agent"));
if (!existsSync(entry)) {
  console.error(`Agent entry point is missing: ${entry}`);
  process.exit(1);
}
console.log(`Agent entry point present: ${entry}`);
