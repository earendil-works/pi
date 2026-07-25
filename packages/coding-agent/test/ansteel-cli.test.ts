import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENV_AGENT_DIR } from "../src/config.ts";

const cliPath = resolve(__dirname, "../src/cli.ts");
const temporaryDirectories: string[] = [];

const COMPLETE_WORK_CARD = [
	"## Conclusion",
	"[L2] The implementation is ready for review.",
	"## Evidence",
	"[L1] Deterministic provider response.",
	"## Assumptions and Unknowns",
	"[L3] Production-provider behavior remains outside this test.",
	"## Alternatives and Trade-offs",
	"[L2] A live provider would add non-determinism.",
	"## Self-Refutation Conditions",
	"[L3] Re-run against a configured external provider.",
	"## Questions for Peers",
	"[L2] No further questions.",
].join("\n");

const DETERMINISTIC_PROVIDER_EXTENSION = `
import { fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";

const completeWorkCard = ${JSON.stringify(COMPLETE_WORK_CARD)};

function register(pi, provider, model, responses) {
	const faux = fauxProvider({ provider, models: [{ id: model }] });
	faux.setResponses(responses.map((response) => fauxAssistantMessage(response)));
	pi.registerProvider(faux.provider);
}

export default function (pi) {
	register(pi, "deterministic-tech", "tech", [
		completeWorkCard,
		"ISSUE: TL-1 | TARGET: staff-engineer\\nNO ISSUES | TARGET: qa-engineer",
		"RESOLUTION: STAFF-1 | RESOLVED\\nRESOLUTION: QA-1 | RESOLVED\\n\\n" + completeWorkCard,
		"VERDICT: APPROVE",
		"[L1] Consensus\\nAll 2 ledger entries are resolved.",
	]);
	register(pi, "deterministic-staff", "staff", [
		completeWorkCard,
		"ISSUE: STAFF-1 | TARGET: tech-lead\\nNO ISSUES | TARGET: qa-engineer",
		"RESOLUTION: TL-1 | RESOLVED\\n\\n" + completeWorkCard,
		"VERDICT: APPROVE",
	]);
	register(pi, "deterministic-qa", "qa", [
		completeWorkCard,
		"ISSUE: QA-1 | TARGET: tech-lead\\nNO ISSUES | TARGET: staff-engineer",
		completeWorkCard,
		"VERDICT: APPROVE",
	]);
}
`;

afterEach(() => {
	for (const directory of temporaryDirectories.splice(0)) {
		rmSync(directory, { recursive: true, force: true });
	}
});

function createTemporaryProject(): { agentDir: string; projectDir: string } {
	const root = mkdtempSync(join(tmpdir(), "pi-ansteel-cli-"));
	temporaryDirectories.push(root);
	const agentDir = join(root, "agent");
	const projectDir = join(root, "project");
	const extensionsDir = join(projectDir, ".pi", "extensions");
	mkdirSync(agentDir, { recursive: true });
	mkdirSync(extensionsDir, { recursive: true });
	writeFileSync(join(extensionsDir, "deterministic-ansteel.ts"), DETERMINISTIC_PROVIDER_EXTENSION, "utf8");
	writeFileSync(
		join(projectDir, ".pi", "ansteel.json"),
		JSON.stringify(
			{
				reportDirectory: ".pi/ansteel-reports",
				stageTimeoutMs: 5_000,
				maxToolCallsPerStage: 1,
				roles: {
					"tech-lead": { model: "deterministic-tech/tech", tools: [] },
					"staff-engineer": { model: "deterministic-staff/staff", tools: [] },
					"qa-engineer": { model: "deterministic-qa/qa", tools: [] },
				},
			},
			null,
			2,
		),
		"utf8",
	);
	return { agentDir, projectDir };
}

async function runCli(
	projectDir: string,
	agentDir: string,
): Promise<{ code: number | null; stdout: string; stderr: string }> {
	return await new Promise((resolvePromise, reject) => {
		const child = spawn(
			process.execPath,
			[
				cliPath,
				"-e",
				join(projectDir, ".pi", "extensions", "deterministic-ansteel.ts"),
				"--ansteel",
				"Reject a hallucinated ledger total",
			],
			{
				cwd: projectDir,
				env: {
					...process.env,
					[ENV_AGENT_DIR]: agentDir,
					TSX_TSCONFIG_PATH: resolve(__dirname, "../../../tsconfig.json"),
				},
				stdio: ["ignore", "pipe", "pipe"],
			},
		);
		let stdout = "";
		let stderr = "";
		child.stdout.on("data", (chunk) => {
			stdout += chunk.toString();
		});
		child.stderr.on("data", (chunk) => {
			stderr += chunk.toString();
		});
		child.on("error", reject);
		child.on("close", (code) => {
			resolvePromise({ code, stdout, stderr });
		});
	});
}

describe("Ansteel CLI", () => {
	it("rejects a deterministic provider consensus that manually states a ledger count and archives invalid-ledger-summary", async () => {
		const { agentDir, projectDir } = createTemporaryProject();

		const result = await runCli(projectDir, agentDir);

		expect(result.code).toBe(1);
		expect(result.stderr).not.toContain("No more faux responses queued");
		const reportMatch = /Ansteel review rejected: (.+)\r?\n?$/.exec(result.stdout);
		expect(reportMatch?.[1]).toBeDefined();
		const reportPath = reportMatch?.[1];
		if (!reportPath) throw new Error(`Could not find Ansteel report path in CLI output: ${result.stdout}`);
		expect(existsSync(reportPath)).toBe(true);
		const report = readFileSync(reportPath, "utf8");
		expect(report).toContain("- Termination reason: invalid-ledger-summary");
		expect(report).toContain("tech-lead / consensus manually stated a ledger count (2 ledger entries)");
		expect(report).toContain("- Total recorded challenges: 3");
	});
});
