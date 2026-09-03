import type { Context, RemoteServices } from "@earendil-works/chord";
import { BACKGROUND_CONTEXT } from "@earendil-works/chord/context";
import type { Client } from "@earendil-works/pi-client";
import {
	createServerServiceSource,
	createSessionServiceSource,
	type ServerServiceSource,
	type ServiceSourceOptions,
	type SessionServiceSource,
} from "../src/experimental/services/connection.ts";

interface ServiceBindingOptions extends ServiceSourceOptions {
	readonly services: readonly { readonly id: string }[];
}

/** Test helper for binding server services without a facet host. */
export function createServerServiceBinding(
	client: Client,
	options: ServiceBindingOptions,
): ServerServiceSource & RemoteServices {
	const source = createServerServiceSource(client, options);
	const services = source.open({
		services: options.services,
		assertAccess() {},
		onError: options.onError ?? (() => {}),
	});
	const activation = services.ready(BACKGROUND_CONTEXT);
	void activation.catch(options.onError ?? (() => {}));
	const ready = async (context: Context): Promise<void> => {
		await activation;
		await services.ready(context);
	};
	return {
		acceptsUnavailableServices: source.acceptsUnavailableServices,
		connection: source.connection,
		catalogue: (context) => source.catalogue(context),
		open: (openOptions) => source.open(openOptions),
		use: (service) => services.use(service),
		observe: (service, handler) => services.observe(service, handler),
		ready,
		async dispose(context) {
			const results = await Promise.allSettled([services.dispose(context), source.dispose(context)]);
			throwFailures(results, "Failed to dispose server service binding");
		},
	};
}

/** Test helper for binding selected-Session services without a facet host. */
export function createSessionServiceBinding(
	client: Client,
	options: ServiceBindingOptions,
): SessionServiceSource & RemoteServices {
	const source = createSessionServiceSource(client, options);
	const services = source.open({
		services: options.services,
		assertAccess() {},
		onError: options.onError ?? (() => {}),
	});
	const activation = services.ready(BACKGROUND_CONTEXT);
	void activation.catch(options.onError ?? (() => {}));
	const ready = async (context: Context): Promise<void> => {
		await activation;
		const attachment = source.attachment.value;
		if (attachment?.status === "detached") await source.whenDetached(context);
		else if (attachment !== undefined) await source.whenAttached(attachment.sessionId, context);
	};
	return {
		get acceptsUnavailableServices() {
			return source.acceptsUnavailableServices;
		},
		attachment: source.attachment,
		catalogue: (context) => source.catalogue(context),
		open: (openOptions) => source.open(openOptions),
		use: (service) => services.use(service),
		observe: (service, handler) => services.observe(service, handler),
		ready,
		whenAttached: (sessionId, context) => source.whenAttached(sessionId, context),
		whenDetached: (context) => source.whenDetached(context),
		async dispose(context) {
			const results = await Promise.allSettled([services.dispose(context), source.dispose(context)]);
			throwFailures(results, "Failed to dispose Session service binding");
		},
	};
}

function throwFailures(results: readonly PromiseSettledResult<unknown>[], message: string): void {
	const errors = results.flatMap((result) => (result.status === "rejected" ? [result.reason] : []));
	if (errors.length === 1) throw errors[0];
	if (errors.length > 1) throw new AggregateError(errors, message);
}
