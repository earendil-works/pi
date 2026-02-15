import type { AgentTool } from "@kennyfrc/mu-ai";
import type { TSchema } from "@sinclair/typebox";

export interface ToolRegistrationMeta {
	sourceId: string;
	priority?: number;
}

interface ToolRegistration {
	tool: AgentTool<TSchema, unknown>;
	sourceId: string;
	priority: number;
	seq: number;
}

function pickActive(registrations: ToolRegistration[]): ToolRegistration | undefined {
	if (registrations.length === 0) return undefined;
	return registrations.slice().sort((a, b) => b.priority - a.priority || b.seq - a.seq)[0];
}

export class ToolRegistry {
	private registrationsByName = new Map<string, ToolRegistration[]>();
	private seq = 0;

	registerTool<TParamsSchema extends TSchema, TOutput>(
		tool: AgentTool<TParamsSchema, TOutput>,
		meta: ToolRegistrationMeta,
	): void {
		const name = tool.name;
		const regs = this.registrationsByName.get(name) ?? [];

		regs.push({
			tool: tool as unknown as AgentTool<TSchema, unknown>,
			sourceId: meta.sourceId,
			priority: meta.priority ?? 0,
			seq: this.seq++,
		});

		this.registrationsByName.set(name, regs);
	}

	getTool(name: string): AgentTool<TSchema, unknown> | undefined {
		const regs = this.registrationsByName.get(name);
		const active = regs ? pickActive(regs) : undefined;
		return active?.tool;
	}

	listTools(): Array<AgentTool<TSchema, unknown>> {
		const names = Array.from(this.registrationsByName.keys()).sort();
		const tools: Array<AgentTool<TSchema, unknown>> = [];

		for (const name of names) {
			const tool = this.getTool(name);
			if (tool) tools.push(tool);
		}

		return tools;
	}

	unregisterBySourceId(sourceId: string): void {
		for (const [name, regs] of this.registrationsByName) {
			const kept = regs.filter((r) => r.sourceId !== sourceId);
			if (kept.length === 0) {
				this.registrationsByName.delete(name);
			} else {
				this.registrationsByName.set(name, kept);
			}
		}
	}
}
