import { styleText } from "node:util";

const emittedDeprecationWarnings = new Set<string>();

export function warnDeprecation(message: string): void {
	if (emittedDeprecationWarnings.has(message)) return;
	emittedDeprecationWarnings.add(message);
	console.warn(styleText("yellow", `Deprecation warning: ${message}`));
}

/** Clear deprecation warning state. Exported for tests. */
export function clearDeprecationWarningsForTests(): void {
	emittedDeprecationWarnings.clear();
}
