import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createStaticFacetLoader, defineFacet } from "@earendil-works/chord";
import { AgentHarness, BACKGROUND_CONTEXT } from "@earendil-works/pi-agent-core";
import { createModels, fauxAssistantMessage, fauxProvider } from "@earendil-works/pi-ai";
import { consumeInternalProcessRole } from "../../src/experimental/process.ts";
import { runSessionWorkerWithHarness } from "../../src/experimental/session-worker.ts";
import { KeyedProbe } from "./keyed-service.ts";

if (process.argv[1] !== undefined && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	const role = consumeInternalProcessRole();
	if (role !== "session-worker") throw new Error("Faux Session worker requires a session-worker invocation");
	void runSessionWorkerWithHarness(process.argv.slice(2), async (session, options) => {
		if (options.provider !== "anthropic" || options.model !== "claude-sonnet-4-5") {
			throw new Error(`Unexpected faux worker model: ${options.provider}/${options.model}`);
		}
		const faux = fauxProvider();
		faux.setResponses([fauxAssistantMessage("deterministic remote answer", { timestamp: 20 })]);
		const models = createModels();
		models.setProvider(faux.provider);
		const harness = (
			await AgentHarness.create(
				{
					session,
					models,
					model: faux.getModel(),
					tools: [],
					resources: {},
				},
				BACKGROUND_CONTEXT,
			)
		).harness;
		const keyedProbeFacet = defineFacet({
			id: "@test/keyed-probe",
			setup(env) {
				const probes = env.provideMany(KeyedProbe);
				const spawn = (value: string): void => {
					const state = env.replicatedState({ value });
					let close = (): void => {};
					close = probes.spawn("probe", {
						state,
						async replace(next) {
							close();
							spawn(next);
						},
						async wait(context) {
							const signal = context.abortSignal;
							if (signal === undefined) throw new Error("Probe wait requires cancellation");
							if (signal.aborted) throw abortError(signal);
							await new Promise<void>((_resolve, reject) => {
								signal.addEventListener("abort", () => reject(abortError(signal)), { once: true });
							});
						},
					});
				};
				env.onActivate(() => spawn("first"));
			},
		});
		return { harness, facetLoader: createStaticFacetLoader([keyedProbeFacet]) };
	}).catch((error: unknown) => {
		console.error(error);
		process.exit(1);
	});
}

function abortError(signal: AbortSignal): Error {
	const reason: unknown = signal.reason;
	return reason instanceof Error ? reason : new DOMException("The operation was aborted", "AbortError");
}
