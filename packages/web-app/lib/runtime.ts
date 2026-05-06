import type { ThinkingLevel } from "@mariozechner/pi-agent-core";
import type { ImageContent } from "@mariozechner/pi-ai";
import type { AgentSessionRuntimeDiagnostic } from "@mariozechner/pi-coding-agent";
import {
	AuthStorage,
	type CreateAgentSessionRuntimeFactory,
	createAgentSessionFromServices,
	createAgentSessionRuntime,
	createAgentSessionServices,
	getAgentDir,
	SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { ChatImageInput, WebCommand, WebSessionSummary, WebState, WebTool } from "@/lib/types";

interface PiWebRuntime {
	runtime: Awaited<ReturnType<typeof createAgentSessionRuntime>>;
	diagnostics: AgentSessionRuntimeDiagnostic[];
}

let runtimePromise: Promise<PiWebRuntime> | undefined;

function getTargetCwd(): string {
	return process.env.PI_WEB_CWD || process.cwd();
}

function shouldContinueRecent(): boolean {
	return process.env.PI_WEB_CONTINUE !== "0";
}

function toErrorMessage(error: unknown): string {
	return error instanceof Error ? error.message : String(error);
}

function isThinkingLevel(value: unknown): value is ThinkingLevel {
	return (
		value === "off" ||
		value === "minimal" ||
		value === "low" ||
		value === "medium" ||
		value === "high" ||
		value === "xhigh"
	);
}

function collectExtensionDiagnostics(
	runtimeDiagnostics: readonly AgentSessionRuntimeDiagnostic[],
): AgentSessionRuntimeDiagnostic[] {
	return runtimeDiagnostics.map((diagnostic) => ({ ...diagnostic }));
}

async function createWebRuntime(): Promise<PiWebRuntime> {
	const cwd = getTargetCwd();
	const agentDir = getAgentDir();
	const authStorage = AuthStorage.create();

	const createRuntime: CreateAgentSessionRuntimeFactory = async ({
		cwd,
		agentDir,
		sessionManager,
		sessionStartEvent,
	}) => {
		const services = await createAgentSessionServices({ cwd, agentDir, authStorage });
		const created = await createAgentSessionFromServices({ services, sessionManager, sessionStartEvent });
		const diagnostics: AgentSessionRuntimeDiagnostic[] = [
			...services.diagnostics,
			...services.settingsManager.drainErrors().map(({ scope, error }) => ({
				type: "warning" as const,
				message: `(${scope} settings) ${error.message}`,
			})),
			...services.resourceLoader.getExtensions().errors.map(({ path, error }) => ({
				type: "error" as const,
				message: `Failed to load extension "${path}": ${error}`,
			})),
		];

		return {
			...created,
			services,
			diagnostics,
		};
	};

	const sessionManager = shouldContinueRecent() ? SessionManager.continueRecent(cwd) : SessionManager.create(cwd);
	const runtime = await createAgentSessionRuntime(createRuntime, {
		cwd: sessionManager.getCwd(),
		agentDir,
		sessionManager,
	});

	return {
		runtime,
		diagnostics: collectExtensionDiagnostics(runtime.diagnostics),
	};
}

export async function getPiWebRuntime(): Promise<PiWebRuntime> {
	if (!runtimePromise) {
		runtimePromise = createWebRuntime();
	}
	return runtimePromise;
}

export async function resetPiWebRuntime(): Promise<PiWebRuntime> {
	const current = runtimePromise ? await runtimePromise : undefined;
	if (current) {
		await current.runtime.dispose();
	}
	runtimePromise = createWebRuntime();
	return runtimePromise;
}

function summarizeSessions(sessions: Awaited<ReturnType<typeof SessionManager.list>>): WebSessionSummary[] {
	return sessions.map((session) => ({
		path: session.path,
		id: session.id,
		cwd: session.cwd,
		name: session.name,
		created: session.created.toISOString(),
		modified: session.modified.toISOString(),
		messageCount: session.messageCount,
		firstMessage: session.firstMessage,
	}));
}

function commandList(webRuntime: PiWebRuntime): WebCommand[] {
	const session = webRuntime.runtime.session;
	const extensionCommands = session.extensionRunner.getRegisteredCommands().map<WebCommand>((command) => ({
		name: command.invocationName,
		description: command.description,
		source: "extension",
		path: command.sourceInfo.path,
		location: command.sourceInfo.scope,
	}));
	const promptCommands = session.promptTemplates.map<WebCommand>((prompt) => ({
		name: prompt.name,
		description: prompt.description,
		source: "prompt",
		path: prompt.filePath,
		location: prompt.sourceInfo.scope,
	}));
	const skillCommands = session.resourceLoader.getSkills().skills.map<WebCommand>((skill) => ({
		name: `skill:${skill.name}`,
		description: skill.description,
		source: "skill",
		path: skill.filePath,
		location: skill.sourceInfo.scope,
	}));
	return [...extensionCommands, ...promptCommands, ...skillCommands].sort((a, b) => a.name.localeCompare(b.name));
}

function toolList(webRuntime: PiWebRuntime): WebTool[] {
	const session = webRuntime.runtime.session;
	const active = new Set(session.getActiveToolNames());
	return session.getAllTools().map((tool) => ({
		name: tool.name,
		description: tool.description,
		active: active.has(tool.name),
		source: tool.sourceInfo.source,
	}));
}

export async function getWebState(): Promise<WebState> {
	const webRuntime = await getPiWebRuntime();
	const { runtime } = webRuntime;
	const { session, services } = runtime;
	let availableModels: WebState["availableModels"] = [];
	try {
		availableModels = session.modelRegistry.getAvailable();
	} catch {
		availableModels = [];
	}
	const sessions = await SessionManager.list(runtime.cwd, session.sessionManager.getSessionDir()).catch(() => []);

	return {
		cwd: runtime.cwd,
		agentDir: services.agentDir,
		diagnostics: [...runtime.diagnostics],
		model: session.model ?? null,
		availableModels,
		thinkingLevel: session.thinkingLevel,
		availableThinkingLevels: session.getAvailableThinkingLevels(),
		isStreaming: session.isStreaming,
		isCompacting: session.isCompacting,
		isRetrying: session.isRetrying,
		isBashRunning: session.isBashRunning,
		autoRetryEnabled: session.autoRetryEnabled,
		steeringMode: session.steeringMode,
		followUpMode: session.followUpMode,
		session: {
			id: session.sessionId,
			name: session.sessionName,
			file: session.sessionFile,
		},
		queue: {
			steering: [...session.getSteeringMessages()],
			followUp: [...session.getFollowUpMessages()],
		},
		stats: session.getSessionStats(),
		messages: session.messages,
		commands: commandList(webRuntime),
		tools: toolList(webRuntime),
		sessions: summarizeSessions(sessions),
		modelFallbackMessage: runtime.modelFallbackMessage,
	};
}

export function toImageContent(images: ChatImageInput[] | undefined): ImageContent[] | undefined {
	if (!images || images.length === 0) return undefined;
	return images.map((image) => ({
		type: "image" as const,
		data: image.data,
		mimeType: image.mimeType,
	}));
}

export async function runControlAction(body: unknown): Promise<WebState> {
	if (!body || typeof body !== "object" || !("action" in body)) {
		throw new Error("Invalid control request");
	}
	const request = body as { action: string; [key: string]: unknown };
	const webRuntime = await getPiWebRuntime();
	const { runtime } = webRuntime;
	const { session } = runtime;

	switch (request.action) {
		case "abort":
			await session.abort();
			break;
		case "newSession":
			await runtime.newSession();
			break;
		case "compact":
			await session.compact(typeof request.customInstructions === "string" ? request.customInstructions : undefined);
			break;
		case "setModel": {
			if (typeof request.provider !== "string" || typeof request.modelId !== "string") {
				throw new Error("setModel requires provider and modelId");
			}
			const model = session.modelRegistry.find(request.provider, request.modelId);
			if (!model) throw new Error(`Model not found: ${request.provider}/${request.modelId}`);
			await session.setModel(model);
			break;
		}
		case "cycleModel":
			await session.cycleModel(request.direction === "backward" ? "backward" : "forward");
			break;
		case "setThinkingLevel":
			if (!isThinkingLevel(request.level)) throw new Error("setThinkingLevel requires a valid level");
			session.setThinkingLevel(request.level);
			break;
		case "cycleThinkingLevel":
			session.cycleThinkingLevel();
			break;
		case "setSessionName":
			if (typeof request.name !== "string") throw new Error("setSessionName requires name");
			session.setSessionName(request.name);
			break;
		case "switchSession":
			if (typeof request.sessionPath !== "string") throw new Error("switchSession requires sessionPath");
			await runtime.switchSession(request.sessionPath);
			break;
		case "setSteeringMode":
			if (request.mode !== "all" && request.mode !== "one-at-a-time") throw new Error("Invalid steering mode");
			session.setSteeringMode(request.mode);
			break;
		case "setFollowUpMode":
			if (request.mode !== "all" && request.mode !== "one-at-a-time") throw new Error("Invalid follow-up mode");
			session.setFollowUpMode(request.mode);
			break;
		case "setAutoRetry":
			if (typeof request.enabled !== "boolean") throw new Error("setAutoRetry requires enabled");
			session.setAutoRetryEnabled(request.enabled);
			break;
		default:
			throw new Error(`Unknown control action: ${request.action}`);
	}

	return getWebState();
}

export { toErrorMessage };
