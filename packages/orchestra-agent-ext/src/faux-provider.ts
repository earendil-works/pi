// Faux provider extension for real RPC E2E (no API keys, no mocks of Pi itself).
// Registers the in-repo faux provider (scripted streamed tool calls) as a native provider.
// Responses are scripted via env ORCHESTRA_FAUX_SCRIPT (JSON array). Default: one edit tool call then done.
import { fauxAssistantMessage, fauxProvider, fauxToolCall } from "@earendil-works/pi-ai";

export function registerFauxProvider(pi: { registerProvider: (p: unknown) => void }): void {
	const raw = process.env.ORCHESTRA_FAUX_SCRIPT ?? "";
	let steps: unknown[] = [];
	try {
		steps = raw ? (JSON.parse(raw) as unknown[]) : [];
	} catch {
		steps = [];
	}
	const faux = fauxProvider({ provider: "faux-rpc" });
	const responses =
		steps.length > 0
			? steps.map((s) => {
					const obj = s as { text?: string; tool?: { name: string; args: Record<string, unknown> } | null };
					if (obj.tool)
						return fauxAssistantMessage([fauxToolCall(obj.tool.name, obj.tool.args as never)], {
							stopReason: "toolUse",
						});
					return fauxAssistantMessage(String(obj.text ?? "done"));
				})
			: [
					fauxAssistantMessage([fauxToolCall("write", { path: "test.txt", content: "hi" } as never)], {
						stopReason: "toolUse",
					}),
					fauxAssistantMessage("done"),
				];
	faux.setResponses(responses as never);
	pi.registerProvider(faux.provider);
}
