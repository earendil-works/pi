import { t } from "@earendil-works/pi-tui";
import chalk from "chalk";

const emittedDeprecationWarnings = new Set<string>();

export function warnDeprecation(message: string): void {
	if (emittedDeprecationWarnings.has(message)) return;
	emittedDeprecationWarnings.add(message);
	console.warn(chalk.yellow(t("codingAgent.packageManager.success.deprecatedWarning", { message })));
}

/** Clear deprecation warning state. Exported for tests. */
export function clearDeprecationWarningsForTests(): void {
	emittedDeprecationWarnings.clear();
}
