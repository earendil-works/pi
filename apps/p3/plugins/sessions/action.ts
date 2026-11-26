// An action a person starts from a view (a create, a removal, "Load more"): whether it runs and why it last failed,
// so a view disables its button meanwhile and shows the failure beside it.

import { BACKGROUND_CONTEXT, type Context } from "@earendil-works/p3/v1";
import { useState } from "react";

/** An action's state: `pending` while a run is under way, `error` the last run's failure (cleared by the next run). */
export type Action = {
	readonly pending: boolean;
	readonly error: string | undefined;
	/** Runs `call` unless one runs already; its failure is kept as `error`, never thrown. */
	run(call: (context: Context) => Promise<unknown>): void;
};

/** An action's state and its `run`, for one component. */
export function useAction(): Action {
	const [pending, setPending] = useState(false);
	const [error, setError] = useState<string | undefined>(undefined);
	return {
		pending,
		error,
		run: (call) => {
			if (pending) return;
			setPending(true);
			setError(undefined);
			call(BACKGROUND_CONTEXT).then(
				() => setPending(false),
				(failure: unknown) => {
					setPending(false);
					setError(failure instanceof Error ? failure.message : String(failure));
				},
			);
		},
	};
}
