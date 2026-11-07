// Proxy-me (LLM for escalations only). Never in hot loop. Structured JSON out.
export interface ProxyDecision {
	decision: "answer" | "redirect" | "approve" | "escalate_human";
	message: string;
	rationale: string;
	confidence: number;
}

export function alwaysEscalate(reason: string): ProxyDecision {
	return { decision: "escalate_human", message: "", rationale: reason, confidence: 0 };
}

export function parseProxyOutput(text: string): ProxyDecision {
	try {
		const obj = JSON.parse(text) as Record<string, unknown>;
		const decision = obj.decision;
		if (decision === "answer" || decision === "redirect" || decision === "approve" || decision === "escalate_human") {
			return {
				decision,
				message: typeof obj.message === "string" ? obj.message : "",
				rationale: typeof obj.rationale === "string" ? obj.rationale : "",
				confidence: typeof obj.confidence === "number" ? obj.confidence : 0,
			};
		}
	} catch {
		/* fall through */
	}
	return alwaysEscalate("unparseable proxy output");
}

export function needsHumanEscalation(d: ProxyDecision, irreversible: boolean, raisedBudget: boolean): boolean {
	if (irreversible || raisedBudget) return true;
	if (d.confidence < 0.7) return true;
	return d.decision === "escalate_human";
}
