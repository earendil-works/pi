import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import { createModels, type FauxProviderHandle, type FauxResponseStep, fauxProvider } from "@earendil-works/pi-ai";
import { type Conversation, createRegistry, Harness, MemoryStorage } from "@earendil-works/pi-durable";

export interface FauxConversation {
	readonly faux: FauxProviderHandle;
	readonly harness: Harness;
	readonly conversation: Conversation;
	close(): Promise<void>;
}

/** An in-memory durable Harness whose root conversation answers with the faux provider. */
export async function openFauxConversation(responses: FauxResponseStep[] = []): Promise<FauxConversation> {
	const faux = fauxProvider();
	faux.setResponses(responses);
	const models = createModels();
	models.setProvider(faux.provider);
	const harness = await Harness.open(new MemoryStorage(), { models, registry: createRegistry() }, BACKGROUND_CONTEXT);
	const model = faux.getModel();
	const conversation = await harness.root(BACKGROUND_CONTEXT, {
		agent: { model: { provider: model.provider, modelId: model.id } },
	});
	return { faux, harness, conversation, close: () => harness.close(BACKGROUND_CONTEXT) };
}

/** A faux response that never arrives; it ends only when its generation is aborted. */
export function pendingResponse(): { readonly step: FauxResponseStep; readonly reached: Promise<void> } {
	let reach!: () => void;
	const reached = new Promise<void>((resolve) => {
		reach = resolve;
	});
	const step: FauxResponseStep = (_context, options) =>
		new Promise((_resolve, reject) => {
			reach();
			const signal = options!.signal!;
			signal.addEventListener("abort", () => reject(signal.reason), { once: true });
		});
	return { step, reached };
}
