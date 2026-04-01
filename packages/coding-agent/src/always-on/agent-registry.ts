import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join, resolve } from "node:path";

export type AlwaysOnThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface AlwaysOnAgentConfig {
	agentId: string;
	workspacePath: string;
	provider: string;
	modelId: string;
	thinkingLevel: AlwaysOnThinkingLevel;
	enabled: boolean;
	createdAt: string;
}

export interface AlwaysOnAgentRegistryState {
	agents: AlwaysOnAgentConfig[];
	globalDefaultAgentId: string | null;
}

export interface CreateAlwaysOnAgentInput {
	agentId?: string;
	workspacePath: string;
	provider: string;
	modelId: string;
	thinkingLevel: AlwaysOnThinkingLevel;
	timestamp: string;
}

export interface SetAlwaysOnGlobalDefaultInput {
	agentId: string;
	timestamp: string;
}

export interface ResolveAlwaysOnTargetInput {
	agentId?: string;
	workspacePath?: string;
}

export interface AgentCreatedFact {
	type: "agent_created";
	agentId: string;
	workspacePath: string;
	provider: string;
	modelId: string;
	thinkingLevel: AlwaysOnThinkingLevel;
	timestamp: string;
}

export interface AgentDisabledFact {
	type: "agent_disabled";
	agentId: string;
	timestamp: string;
}

export interface WorkspaceDefaultSetFact {
	type: "workspace_default_set";
	agentId: string;
	timestamp: string;
}

export type AlwaysOnAgentFact = AgentCreatedFact | AgentDisabledFact | WorkspaceDefaultSetFact;

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}

function requireNonEmptyString(record: Record<string, unknown>, key: string, lineNumber: number): string {
	const value = record[key];
	if (typeof value !== "string" || value.trim().length === 0) {
		throw new Error(`Invalid agents.jsonl fact on line ${lineNumber}: missing ${key}`);
	}
	return value;
}

function asThinkingLevel(value: string, lineNumber: number): AlwaysOnThinkingLevel {
	if (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	) {
		return value;
	}
	throw new Error(`Invalid agents.jsonl fact on line ${lineNumber}: invalid thinkingLevel`);
}

function parseAgentFact(line: string, lineNumber: number): AlwaysOnAgentFact {
	let parsed: unknown;
	try {
		parsed = JSON.parse(line);
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Invalid agents.jsonl fact on line ${lineNumber}: ${message}`);
	}

	if (!isRecord(parsed)) {
		throw new Error(`Invalid agents.jsonl fact on line ${lineNumber}: expected an object`);
	}

	const type = requireNonEmptyString(parsed, "type", lineNumber);
	if (type === "agent_created") {
		return {
			type,
			agentId: requireNonEmptyString(parsed, "agentId", lineNumber),
			workspacePath: requireNonEmptyString(parsed, "workspacePath", lineNumber),
			provider: requireNonEmptyString(parsed, "provider", lineNumber),
			modelId: requireNonEmptyString(parsed, "modelId", lineNumber),
			thinkingLevel: asThinkingLevel(requireNonEmptyString(parsed, "thinkingLevel", lineNumber), lineNumber),
			timestamp: requireNonEmptyString(parsed, "timestamp", lineNumber),
		};
	}

	if (type === "agent_disabled") {
		return {
			type,
			agentId: requireNonEmptyString(parsed, "agentId", lineNumber),
			timestamp: requireNonEmptyString(parsed, "timestamp", lineNumber),
		};
	}

	if (type === "workspace_default_set") {
		return {
			type,
			agentId: requireNonEmptyString(parsed, "agentId", lineNumber),
			timestamp: requireNonEmptyString(parsed, "timestamp", lineNumber),
		};
	}

	throw new Error(`Invalid agents.jsonl fact on line ${lineNumber}: unsupported type ${type}`);
}

export function getAlwaysOnBaseDir(baseDir?: string): string {
	return resolve(baseDir ?? process.env.MU_CODING_AGENT_DIR ?? join(homedir(), ".mu", "agent"));
}

export function getAlwaysOnAgentsLedgerPath(baseDir?: string): string {
	return join(getAlwaysOnBaseDir(baseDir), "always-on", "agents.jsonl");
}

export function readAlwaysOnAgentFacts(baseDir?: string): AlwaysOnAgentFact[] {
	const ledgerPath = getAlwaysOnAgentsLedgerPath(baseDir);
	if (!existsSync(ledgerPath)) {
		return [];
	}

	const trimmed = readFileSync(ledgerPath, "utf8").trim();
	if (trimmed.length === 0) {
		return [];
	}

	return trimmed.split("\n").map((line, index) => parseAgentFact(line, index + 1));
}

export function deriveAlwaysOnAgentRegistryState(facts: AlwaysOnAgentFact[]): AlwaysOnAgentRegistryState {
	const agents = new Map<string, AlwaysOnAgentConfig>();
	let globalDefaultAgentId: string | null = null;

	for (const fact of facts) {
		if (fact.type === "agent_created") {
			if (agents.has(fact.agentId)) {
				throw new Error(`Duplicate always-on agent id: ${fact.agentId}`);
			}
			agents.set(fact.agentId, {
				agentId: fact.agentId,
				workspacePath: fact.workspacePath,
				provider: fact.provider,
				modelId: fact.modelId,
				thinkingLevel: fact.thinkingLevel,
				enabled: true,
				createdAt: fact.timestamp,
			});
			continue;
		}

		if (fact.type === "agent_disabled") {
			const existing = agents.get(fact.agentId);
			if (!existing) {
				throw new Error(`Cannot disable missing always-on agent: ${fact.agentId}`);
			}
			existing.enabled = false;
			continue;
		}

		const existing = agents.get(fact.agentId);
		if (!existing) {
			throw new Error(`Cannot set default to missing always-on agent: ${fact.agentId}`);
		}
		if (!existing.enabled) {
			throw new Error(`Cannot set default to disabled always-on agent: ${fact.agentId}`);
		}
		globalDefaultAgentId = fact.agentId;
	}

	return {
		agents: [...agents.values()],
		globalDefaultAgentId,
	};
}

function appendAlwaysOnAgentFact(baseDir: string, fact: AlwaysOnAgentFact): void {
	const ledgerPath = getAlwaysOnAgentsLedgerPath(baseDir);
	mkdirSync(dirname(ledgerPath), { recursive: true });
	appendFileSync(ledgerPath, `${JSON.stringify(fact)}\n`, "utf8");
}

function generateAlwaysOnAgentId(): string {
	return `ao-${randomUUID().slice(0, 8)}`;
}

function requireAgentById(state: AlwaysOnAgentRegistryState, agentId: string): AlwaysOnAgentConfig {
	const agent = state.agents.find((entry) => entry.agentId === agentId && entry.enabled);
	if (!agent) {
		throw new Error(`Always-on agent ${agentId} not found`);
	}
	return agent;
}

function formatAgentTuple(agent: AlwaysOnAgentConfig): string {
	return `${agent.provider} / ${agent.modelId} / ${agent.thinkingLevel}`;
}

function formatDefaultLabel(state: AlwaysOnAgentRegistryState, agentId: string): string {
	return state.globalDefaultAgentId === agentId ? " [global default]" : "";
}

export function createAlwaysOnAgentRegistry(options: { baseDir?: string } = {}) {
	const baseDir = getAlwaysOnBaseDir(options.baseDir);

	return {
		createAgent(input: CreateAlwaysOnAgentInput): { agentId: string; becameGlobalDefault: boolean } {
			const state = deriveAlwaysOnAgentRegistryState(readAlwaysOnAgentFacts(baseDir));
			const agentId = input.agentId?.trim().length ? input.agentId.trim() : generateAlwaysOnAgentId();
			if (state.agents.some((agent) => agent.agentId === agentId)) {
				throw new Error(`Always-on agent already exists: ${agentId}`);
			}

			appendAlwaysOnAgentFact(baseDir, {
				type: "agent_created",
				agentId,
				workspacePath: resolve(input.workspacePath),
				provider: input.provider,
				modelId: input.modelId,
				thinkingLevel: input.thinkingLevel,
				timestamp: input.timestamp,
			});

			const becameGlobalDefault = state.globalDefaultAgentId === null;
			if (becameGlobalDefault) {
				appendAlwaysOnAgentFact(baseDir, {
					type: "workspace_default_set",
					agentId,
					timestamp: input.timestamp,
				});
			}

			return { agentId, becameGlobalDefault };
		},

		readState(): AlwaysOnAgentRegistryState {
			return deriveAlwaysOnAgentRegistryState(readAlwaysOnAgentFacts(baseDir));
		},

		setGlobalDefaultAgent(input: SetAlwaysOnGlobalDefaultInput): void {
			const state = deriveAlwaysOnAgentRegistryState(readAlwaysOnAgentFacts(baseDir));
			requireAgentById(state, input.agentId);
			appendAlwaysOnAgentFact(baseDir, {
				type: "workspace_default_set",
				agentId: input.agentId,
				timestamp: input.timestamp,
			});
		},

		resolveTargetAgent(input: ResolveAlwaysOnTargetInput): AlwaysOnAgentConfig {
			const state = deriveAlwaysOnAgentRegistryState(readAlwaysOnAgentFacts(baseDir));
			if (input.agentId) {
				return requireAgentById(state, input.agentId);
			}
			if (!state.globalDefaultAgentId) {
				throw new Error("No global default always-on agent exists.");
			}
			return requireAgentById(state, state.globalDefaultAgentId);
		},

		renderAgentsTable(): string {
			const state = deriveAlwaysOnAgentRegistryState(readAlwaysOnAgentFacts(baseDir));
			if (state.agents.length === 0) {
				return "No always-on agents configured.";
			}

			return [
				"Always-on agents:",
				...state.agents.map(
					(agent) =>
						`- ${agent.agentId}${formatDefaultLabel(state, agent.agentId)}\n  Workspace: ${agent.workspacePath}\n  Model: ${formatAgentTuple(agent)}\n  Enabled: ${agent.enabled ? "yes" : "no"}`,
				),
			].join("\n");
		},

		renderStatus(input?: { agentId?: string }): string {
			const state = deriveAlwaysOnAgentRegistryState(readAlwaysOnAgentFacts(baseDir));
			if (state.agents.length === 0) {
				return "No always-on agents configured.";
			}

			const agent = input?.agentId
				? requireAgentById(state, input.agentId)
				: state.globalDefaultAgentId
					? requireAgentById(state, state.globalDefaultAgentId)
					: state.agents[0];

			return [
				`Always-on agent ${agent.agentId}`,
				`Workspace: ${agent.workspacePath}`,
				`Model: ${formatAgentTuple(agent)}`,
				`Enabled: ${agent.enabled ? "yes" : "no"}`,
				state.globalDefaultAgentId === agent.agentId ? "Global default: yes" : "Default agent: no",
			].join("\n");
		},
	};
}
