import { type StreamFn, setDefaultStreamFn } from "@earendil-works/pi-agent-core";
import { getApiProvider } from "@earendil-works/pi-ai/compat";

/**
 * Build the stream function used by the agent loop: dispatch to the registered
 * API provider for the model's `api`.
 */
export function createStreamFn(): StreamFn {
	return ((model, context, options) => {
		const api = getApiProvider(model.api);
		if (!api) {
			throw new Error(`No API provider registered for api: ${model.api}`);
		}
		return api.streamSimple(model, context, options);
	}) as StreamFn;
}

let installed = false;

/**
 * Install the default stream function for agent loops created without an
 * explicit stream fn. Idempotent.
 */
export function installStreamFn(): void {
	if (installed) {
		return;
	}
	installed = true;
	setDefaultStreamFn(createStreamFn());
}
