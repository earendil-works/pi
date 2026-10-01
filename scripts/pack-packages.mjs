#!/usr/bin/env node

import { resolve } from "node:path";
import { parseArgs } from "node:util";
import { produceArtifactSet } from "./package-artifacts.mjs";

function printUsage() {
	console.log(`Usage: node scripts/pack-packages.mjs --out <dir> [options]

Builds every public package and writes one coherent local artifact set.

Options:
  --out <dir>            Output directory; .artifacts/ is ignored by Git
  --force                Replace an existing output directory
  --offline-model-data   Build with already-hydrated model data
  --skip-build           Pack existing build output without rebuilding
  --help                 Show this help
`);
}

const { values } = parseArgs({
	options: {
		force: { type: "boolean", default: false },
		help: { type: "boolean", default: false },
		"offline-model-data": { type: "boolean", default: false },
		out: { type: "string" },
		"skip-build": { type: "boolean", default: false },
	},
});
if (values.help) {
	printUsage();
	process.exit(0);
}
if (!values.out) throw new Error("--out is required");

const artifactSet = produceArtifactSet({
	build: !values["skip-build"],
	force: values.force,
	offlineModelData: values["offline-model-data"],
	outDir: values.out,
	repoRoot: process.cwd(),
});
console.log(`\nLocal package artifacts created: ${artifactSet.artifactDirectory}`);
console.log(`Manifest: ${artifactSet.manifestPath}`);
console.log("\nConnect an external npm project with:");
console.log(
	`  node ${resolve("scripts/use-local-packages.mjs")} --manifest ${artifactSet.manifestPath} --consumer <project> --package <name>`,
);
