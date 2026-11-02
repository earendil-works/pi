// A stand-in for `npm install` (the example needs no network): run in a plugin's directory, it copies every
// `file:` dependency of the plugin's package.json into its node_modules, as npm would install it.

import { cpSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";

const { dependencies = {} } = JSON.parse(readFileSync("package.json", "utf8"));
for (const [name, spec] of Object.entries(dependencies)) {
	if (!spec.startsWith("file:")) throw new Error(`fake npm: ${name}@${spec} is not a local package`);
	cpSync(resolve(spec.slice("file:".length)), join("node_modules", name), { recursive: true });
}
