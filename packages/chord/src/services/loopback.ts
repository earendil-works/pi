import type { RemoteServiceTransport } from "../types.ts";
import type { RemoteServiceProvider } from "./provider.ts";

/** Connects a provider to a binding without changing remote service semantics. */
export function createLoopbackServiceTransport(provider: RemoteServiceProvider): RemoteServiceTransport {
	return {
		invoke: (call, context) => provider.invoke(call, context),
		subscribe: async (serviceId, mode, listener) => {
			const subscription = provider.subscribe(serviceId, mode, listener);
			return {
				snapshot: subscription.snapshot,
				activate: () => subscription.activate(),
				close: () => subscription.close(),
			};
		},
	};
}
