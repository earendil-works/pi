export interface ExplicitHandoffScheduleOptions {
	pauseQueueDrain: () => void;
	execute: () => void;
	defer?: (task: () => void) => void;
}

export interface ExplicitHandoffSubmitOptions {
	message: string;
	prompt: (message: string) => Promise<void>;
	submitViaInput?: (message: string) => void;
}

export type ExplicitHandoffSubmitResult = "input" | "prompt";

export function scheduleExplicitHandoff(options: ExplicitHandoffScheduleOptions): void {
	const { pauseQueueDrain, execute, defer = queueMicrotask } = options;

	pauseQueueDrain();
	defer(execute);
}

export async function submitExplicitHandoff(
	options: ExplicitHandoffSubmitOptions,
): Promise<ExplicitHandoffSubmitResult> {
	const { message, prompt, submitViaInput } = options;

	if (submitViaInput) {
		submitViaInput(message);
		return "input";
	}

	await prompt(message);
	return "prompt";
}
