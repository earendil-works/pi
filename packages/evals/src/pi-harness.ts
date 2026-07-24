import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
	createAgentSession,
	DefaultResourceLoader,
	ModelRuntime,
	SessionManager,
	SettingsManager,
} from "@earendil-works/pi-coding-agent";
import { type PiAiCreateAgentArgs, type PiAiRuntime, type PiAiToolset, piAiHarness } from "@vitest-evals/harness-pi-ai";

type EvalSession = Awaited<ReturnType<typeof createAgentSession>>["session"];

interface EvalRunResult {
	output: string;
	metrics: {
		provider: string;
		model: string;
		inputTokens: number;
		outputTokens: number;
		totalTokens: number;
	};
}

async function cleanupEvalResources(session: EvalSession | undefined, removeRoot: () => Promise<void>): Promise<void> {
	const failures: unknown[] = [];
	if (session) {
		try {
			session.dispose();
		} catch (error) {
			failures.push(error);
		}
	}
	try {
		await removeRoot();
	} catch (error) {
		failures.push(error);
	}
	if (failures.length === 1) {
		throw failures[0];
	}
	if (failures.length > 1) {
		throw new AggregateError(failures, "Pi eval session disposal and temporary directory cleanup failed.");
	}
}

function getRequiredModelSelection(): { provider: string; model: string } {
	const provider = process.env.PI_PROVIDER?.trim();
	const model = process.env.PI_MODEL?.trim();
	if (!provider || !model) {
		throw new Error("PI_PROVIDER and PI_MODEL must both be set for eval runs.");
	}
	return { provider, model };
}

async function createPiEvalAgent({ context }: PiAiCreateAgentArgs<string>) {
	const signal = context.signal;
	signal?.throwIfAborted();
	const selection = getRequiredModelSelection();
	const modelRuntime = await ModelRuntime.create();
	signal?.throwIfAborted();
	const model = modelRuntime.getModel(selection.provider, selection.model);
	if (!model) {
		throw new Error(`Eval model not found: ${selection.provider}/${selection.model}`);
	}
	const auth = await modelRuntime.checkAuth(selection.provider);
	signal?.throwIfAborted();
	if (!auth) {
		throw new Error(`No authentication configured for eval model ${selection.provider}/${selection.model}.`);
	}

	const root = await mkdtemp(join(tmpdir(), "pi-eval-"));
	const cwd = join(root, "workspace");
	const agentDir = join(root, "agent");
	const cleanup = () => rm(root, { recursive: true, force: true });
	let session: EvalSession | undefined;
	try {
		signal?.throwIfAborted();
		await Promise.all([mkdir(cwd), mkdir(agentDir)]);
		signal?.throwIfAborted();

		const settingsManager = SettingsManager.inMemory();
		const resourceLoader = new DefaultResourceLoader({
			cwd,
			agentDir,
			settingsManager,
			noExtensions: true,
			noSkills: true,
			noPromptTemplates: true,
			noThemes: true,
			noContextFiles: true,
		});
		await resourceLoader.reload();
		signal?.throwIfAborted();

		session = (
			await createAgentSession({
				cwd,
				agentDir,
				model,
				modelRuntime,
				thinkingLevel: "off",
				noTools: "all",
				resourceLoader,
				settingsManager,
				sessionManager: SessionManager.inMemory(cwd),
			})
		).session;
		signal?.throwIfAborted();
	} catch (error) {
		try {
			await cleanupEvalResources(session, cleanup);
		} catch (cleanupError) {
			throw new AggregateError([error, cleanupError], "Pi eval setup failed and cleanup also failed.");
		}
		throw error;
	}
	if (!session) {
		throw new Error("Pi eval session setup completed without a session.");
	}

	return {
		agent: session.agent,
		async run(input: string, runtime: PiAiRuntime<PiAiToolset<string>, string>) {
			const abort = () => void session.abort();
			runtime.signal?.addEventListener("abort", abort, { once: true });
			let result: EvalRunResult;
			try {
				runtime.signal?.throwIfAborted();
				await session.prompt(input);
				const assistant = session.messages
					.slice()
					.reverse()
					.find((message) => message.role === "assistant");
				if (!assistant) {
					throw new Error("Pi eval did not produce an assistant message.");
				}
				if (assistant.stopReason !== "stop") {
					throw new Error(assistant.errorMessage ?? `Pi eval stopped unexpectedly: ${assistant.stopReason}`);
				}

				const output = session.getLastAssistantText();
				if (!output) {
					throw new Error("Pi eval produced an empty assistant response.");
				}

				const stats = session.getSessionStats();
				runtime.events.assistant(output, {
					provider: model.provider,
					model: model.id,
				});
				result = {
					output,
					metrics: {
						provider: model.provider,
						model: model.id,
						inputTokens: stats.tokens.input,
						outputTokens: stats.tokens.output,
						totalTokens: stats.tokens.total,
					},
				};
			} catch (error) {
				runtime.signal?.removeEventListener("abort", abort);
				try {
					await cleanupEvalResources(session, cleanup);
				} catch (cleanupError) {
					throw new AggregateError([error, cleanupError], "Pi eval run failed and cleanup also failed.");
				}
				throw error;
			}
			runtime.signal?.removeEventListener("abort", abort);
			await cleanupEvalResources(session, cleanup);
			return result;
		},
	};
}

export const piCodingAgentHarness = piAiHarness({
	name: "pi-coding-agent",
	agent: createPiEvalAgent,
});
