import { writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { build } from "esbuild";

const outputPath = join(tmpdir(), "pi-browser-smoke.js");
const baseOutputPath = join(tmpdir(), "pi-browser-base-smoke.js");
const selectiveOutputPath = join(tmpdir(), "pi-browser-selective-smoke.js");
const errorLogPath = join(tmpdir(), "pi-browser-smoke-errors.log");
const providerImplementationInputs = [
	"packages/ai/src/providers/amazon-bedrock.ts",
	"packages/ai/src/providers/anthropic.ts",
	"packages/ai/src/providers/azure-openai-responses.ts",
	"packages/ai/src/providers/google.ts",
	"packages/ai/src/providers/google-vertex.ts",
	"packages/ai/src/providers/images/openrouter.ts",
	"packages/ai/src/providers/mistral.ts",
	"packages/ai/src/providers/openai-codex-responses.ts",
	"packages/ai/src/providers/openai-completions.ts",
	"packages/ai/src/providers/openai-responses.ts",
];

try {
	await build({
		entryPoints: ["scripts/browser-smoke-entry.ts"],
		bundle: true,
		platform: "browser",
		format: "esm",
		logLevel: "silent",
		outfile: outputPath,
	});
	const baseBuild = await build({
		stdin: {
			contents: `import { complete } from "@earendil-works/pi-ai/base";\nimport { Agent } from "@earendil-works/pi-agent-core/base";\nconsole.log(typeof complete, typeof Agent);\n`,
			resolveDir: process.cwd(),
			sourcefile: "pi-browser-base-smoke-entry.ts",
		},
		bundle: true,
		platform: "browser",
		format: "esm",
		logLevel: "silent",
		metafile: true,
		outfile: baseOutputPath,
	});
	const bundledInputs = new Set(Object.keys(baseBuild.metafile.inputs));
	const reachableProviderImplementations = providerImplementationInputs.filter((input) => bundledInputs.has(input));
	if (reachableProviderImplementations.length > 0) {
		throw new Error(`Base browser bundle reached provider implementations:\n${reachableProviderImplementations.join("\n")}`);
	}
	await build({
		stdin: {
			contents: `import { register as registerAnthropic } from "@earendil-works/pi-ai/anthropic";\nimport { register as registerOpenAICompletions } from "@earendil-works/pi-ai/openai-completions";\nimport { register as registerOpenRouterImages } from "@earendil-works/pi-ai/openrouter-images";\nconsole.log(typeof registerAnthropic, typeof registerOpenAICompletions, typeof registerOpenRouterImages);\n`,
			resolveDir: process.cwd(),
			sourcefile: "pi-browser-selective-smoke-entry.ts",
		},
		bundle: true,
		platform: "browser",
		format: "esm",
		logLevel: "silent",
		outfile: selectiveOutputPath,
	});
	process.exit(0);
} catch (error) {
	let detailedErrors = "";
	if (error && typeof error === "object" && "errors" in error && Array.isArray(error.errors)) {
		detailedErrors = error.errors
			.map((entry) => {
				const location = entry.location
					? `${entry.location.file}:${entry.location.line}:${entry.location.column}`
					: "";
				return [location, entry.text].filter(Boolean).join(" ");
			})
			.join("\n");
	}

	const baseError = error instanceof Error ? (error.stack ?? error.message) : String(error);
	writeFileSync(errorLogPath, [detailedErrors, baseError].filter(Boolean).join("\n\n"), "utf-8");
	console.error(`Browser smoke check failed. See ${errorLogPath}`);
	process.exit(1);
}
