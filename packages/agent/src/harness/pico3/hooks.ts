import type { AnyKind, HookInfo, HookRunner, Id, Namespace } from "./types.ts";

export interface HookRegistration {
	namespace: Namespace;
	kind: AnyKind;
	handlers: object;
	conversationId?: Id;
	subtree?: boolean;
}

export function createHookRunners(
	registrations: () => readonly HookRegistration[],
	ancestors: (conversationId: Id) => readonly Id[],
	onReport: (error: unknown) => void,
) {
	return <H extends object>(kind: AnyKind, info: Omit<HookInfo, "kind">): HookRunner<H> => {
		const handlers = () =>
			registrations()
				.filter((registration) => registration.kind === kind)
				.filter(
					(registration) =>
						registration.conversationId === undefined ||
						registration.conversationId === info.conversationId ||
						(registration.subtree === true &&
							ancestors(info.conversationId).includes(registration.conversationId)),
				)
				.map((registration) => ({
					handlers: registration.handlers as Partial<H>,
					namespace: registration.namespace,
					api: { ...info, kind: kind.name },
				}));
		return {
			handlers,
			async each(ctx, fn, onValue) {
				for (const binding of handlers()) {
					try {
						const v = await fn(binding.handlers, binding.api);
						if (v !== undefined && onValue?.(v as never) === true) return;
					} catch (error) {
						if (ctx.abortSignal?.aborted) throw error;
						onReport(error);
					}
				}
			},
		};
	};
}
