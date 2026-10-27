import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { installConsumer } from "../../../scripts/local-package-install.mjs";
import { produceArtifactSet } from "../../../scripts/package-artifacts.mjs";
import { codingAgentName } from "../../../scripts/coding-agent-smoke.mjs";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const outputDirectory = process.argv[2];
if (!outputDirectory || process.argv.length !== 3) {
	throw new Error("Usage: node packages/evals/docker/install-runtime.mjs <output-directory>");
}

const evalPackage = JSON.parse(readFileSync(join(repositoryRoot, "packages/evals/package.json"), "utf8"));
const artifactSet = produceArtifactSet({
	build: false,
	outDir: join(outputDirectory, "artifacts"),
	repoRoot: repositoryRoot,
	// Docker build contexts may omit Git metadata; this artifact set is consumed only within this image build.
	source: null,
});
const artifactNames = new Set(artifactSet.packages.map((pkg) => pkg.name));
const evaluatorDependencies = Object.entries(evalPackage.devDependencies).filter(([name]) => !artifactNames.has(name));
const installDirectory = join(outputDirectory, "install");
installConsumer({ artifactSet, directory: installDirectory, packageNames: [codingAgentName] });
execFileSync(
	"npm",
	[
		"install",
		"--ignore-scripts",
		"--omit=dev",
		"--no-audit",
		"--no-fund",
		"--no-save",
		...evaluatorDependencies.map(([name, version]) => `${name}@${version}`),
	],
	{ cwd: installDirectory, stdio: "inherit" },
);

for (const packageName of artifactNames) {
	if (packageName === codingAgentName) continue;
	const packageDirectory = join(installDirectory, "node_modules", ...packageName.split("/"));
	if (!existsSync(packageDirectory)) continue;
	for (const entry of readdirSync(packageDirectory, { withFileTypes: true })) {
		if (
			(entry.isDirectory() && ["docs", "examples", "src", "test", "tests"].includes(entry.name)) ||
			(entry.isFile() && /^(?:readme|changelog)(?:\..+)?$/i.test(entry.name))
		) {
			rmSync(join(packageDirectory, entry.name), { force: true, recursive: true });
		}
	}
}

const runtimeRoot = join(outputDirectory, "root");
const runtimeEvalRoot = join(runtimeRoot, "packages/evals");
mkdirSync(join(runtimeEvalRoot, "docker"), { recursive: true });
for (const file of ["package.json", "vitest.base.ts"]) {
	cpSync(join(repositoryRoot, file), join(runtimeRoot, file));
}
for (const file of ["package.json", "vitest.evals.config.ts"]) {
	cpSync(join(repositoryRoot, "packages/evals", file), join(runtimeEvalRoot, file));
}
for (const directory of ["src", "evals"]) {
	cpSync(join(repositoryRoot, "packages/evals", directory), join(runtimeEvalRoot, directory), { recursive: true });
}
cpSync(
	join(repositoryRoot, "packages/evals/docker/entrypoint.ts"),
	join(runtimeEvalRoot, "docker/entrypoint.ts"),
);
