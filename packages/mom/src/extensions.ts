import type { ImageContent, Model } from "@mariozechner/pi-ai";
import {
	type AgentSession,
	createExtensionRuntime,
	discoverAndLoadExtensions,
	type ExtensionContext,
	type ExtensionRunner,
	type ExtensionRuntime,
	type InputEventResult,
	type InputSource,
	type LoadExtensionsResult,
} from "@mariozechner/pi-coding-agent";

import { existsSync, lstatSync, readdirSync, readFileSync, realpathSync } from "fs";
import { isAbsolute, join, relative, resolve } from "path";

type StartupModelSelectSource = "set" | "cycle" | "restore";

const DIRECT_RESPONSE_CUSTOM_TYPE = "mom-direct-response";

interface WorkspaceExtensionSettings {
	extensions?: string[];
	packages?: unknown;
}

interface DiscoveredEntry {
	absolutePath: string;
	realPath: string;
	sortKey: string;
}

interface MomAugmentedExtensionContext extends ExtensionContext {
	channel?: string;
	channelId?: string;
	channelName?: string;
	user?: string;
	userId?: string;
	userName?: string;
	threadTs?: string;
	requestContext?: MomRequestContext;
	message?: {
		channel: string;
		user: string;
		ts: string;
		threadTs?: string;
		text: string;
		attachments: string[];
	};
}

interface RuntimeBackdoor {
	runtime: ExtensionRuntime;
	createContext(): ExtensionContext;
}

interface SlackDirectResponseContent {
	mainText: string;
	threadText?: string;
}

export interface MomTrustConfig {
	strict: boolean;
	trustedRoot?: string;
}

export interface ExtensionLoadPlan {
	mode: "strict" | "permissive";
	entries: string[];
	trustedRoot?: string;
	ignoredWorkspaceAuthorities: string[];
	warnings: string[];
}

export interface MomRequestContext {
	channel: string;
	channelId: string;
	channelName?: string;
	user: string;
	userId: string;
	userName?: string;
	threadTs?: string;
	slackTs: string;
	rawText: string;
	attachments: string[];
	isEvent: boolean;
}

export interface MomSlackMessageCallbacks {
	clearThinking(): void;
	markCustomResponseHandled(): void;
	publishFinal(text: string, shouldLog?: boolean): Promise<void>;
	respond(text: string, shouldLog?: boolean): Promise<void>;
	respondInThread(text: string): Promise<void>;
}

export interface MomExtensionBridge {
	runner?: ExtensionRunner;
	setRequestContext(requestContext: MomRequestContext): void;
	clearRequestContext(): void;
	setSlackCallbacks(callbacks: MomSlackMessageCallbacks): void;
	clearSlackCallbacks(): void;
	emitRawInput(text: string, images: ImageContent[] | undefined, source: InputSource): Promise<InputEventResult>;
	emitStartupModelSelect(model: Model<any>, source: StartupModelSelectSource): Promise<void>;
	flushPendingSlackEffects(): Promise<void>;
}

type RuntimeCustomMessage = Parameters<ExtensionRuntime["sendMessage"]>[0];

export function resolveMomTrustConfig(workspaceDir: string): MomTrustConfig {
	const configuredRoot = process.env.MOM_TRUSTED_EXTENSION_ROOT?.trim();
	if (!configuredRoot) {
		return { strict: false };
	}

	if (!isAbsolute(configuredRoot)) {
		throw new Error("MOM_TRUSTED_EXTENSION_ROOT must be an absolute path");
	}

	const workspaceRealPath = realpathSync(workspaceDir);
	const trustedRootRealPath = realpathSync(configuredRoot);
	if (isSameOrInside(trustedRootRealPath, workspaceRealPath)) {
		throw new Error(`MOM_TRUSTED_EXTENSION_ROOT must be outside the workspace: ${trustedRootRealPath}`);
	}

	return {
		strict: true,
		trustedRoot: trustedRootRealPath,
	};
}

export function validateStrictTrustBoundary(workspaceDir: string, trustConfig: MomTrustConfig): void {
	if (!trustConfig.strict) {
		return;
	}

	const offenders = findWorkspaceTrustBoundaryOffenders(workspaceDir);
	if (offenders.length === 0) {
		return;
	}

	throw new Error(
		`Strict trust mode blocked workspace extension authority: ${offenders[0]}. ` +
			`Allowed runtime extensions are only repo-managed files under ${trustConfig.trustedRoot}`,
	);
}

export function createExtensionLoadPlan(workspaceDir: string, trustConfig: MomTrustConfig): ExtensionLoadPlan {
	const settings = readWorkspaceExtensionSettings(workspaceDir);
	const warnings = [...settings.warnings];
	const ignoredWorkspaceAuthorities: string[] = [];

	if (trustConfig.strict) {
		if (settings.values.extensions && settings.values.extensions.length > 0) {
			ignoredWorkspaceAuthorities.push("workspace .pi/settings.json extensions");
			warnings.push("Ignoring workspace .pi/settings.json extensions in strict trust mode");
		}
		if (settings.values.packages !== undefined) {
			ignoredWorkspaceAuthorities.push("workspace .pi/settings.json packages");
			warnings.push("Ignoring workspace .pi/settings.json packages in strict trust mode");
		}

		const trustedRoot = trustConfig.trustedRoot;
		if (!trustedRoot) {
			throw new Error("Strict trust mode requires a trusted extension root");
		}

		return {
			mode: "strict",
			entries: dedupeEntries(discoverExtensionEntries(trustedRoot, workspaceDir).map((entry) => entry.realPath)),
			trustedRoot,
			ignoredWorkspaceAuthorities,
			warnings,
		};
	}

	if (settings.values.packages !== undefined) {
		ignoredWorkspaceAuthorities.push("workspace .pi/settings.json packages");
		warnings.push("Ignoring workspace .pi/settings.json packages in permissive mode");
	}

	const settingsEntries: string[] = [];
	for (const configuredPath of settings.values.extensions ?? []) {
		const resolvedPath = resolve(workspaceDir, configuredPath);
		for (const entry of discoverExtensionEntries(resolvedPath)) {
			settingsEntries.push(entry.realPath);
		}
	}

	const workspaceExtensionsDir = join(workspaceDir, ".pi", "extensions");
	const discoveredWorkspaceEntries = existsSync(workspaceExtensionsDir)
		? discoverExtensionEntries(workspaceExtensionsDir).map((entry) => entry.realPath)
		: [];

	return {
		mode: "permissive",
		entries: dedupeEntries([...settingsEntries, ...discoveredWorkspaceEntries]),
		ignoredWorkspaceAuthorities,
		warnings,
	};
}

export async function loadMomExtensions(plan: ExtensionLoadPlan, workspaceDir: string): Promise<LoadExtensionsResult> {
	if (plan.entries.length === 0) {
		return {
			extensions: [],
			errors: [],
			runtime: createExtensionRuntime(),
		};
	}

	const disabledAutoDiscoveryCwd = join(workspaceDir, ".__mom_disabled_extension_autodiscovery_cwd__");
	const disabledAutoDiscoveryAgentDir = join(workspaceDir, ".__mom_disabled_extension_autodiscovery_agent_dir__");
	return discoverAndLoadExtensions(plan.entries, disabledAutoDiscoveryCwd, disabledAutoDiscoveryAgentDir);
}

export function createMomExtensionBridge(
	session: AgentSession,
	currentModelRef: { current: Model<any> },
): MomExtensionBridge {
	const runner = session.extensionRunner;
	if (!runner) {
		return createNoOpBridge();
	}

	let requestContext: MomRequestContext | undefined;
	let slackCallbacks: MomSlackMessageCallbacks | undefined;
	let slackEffectChain = Promise.resolve();
	let pendingSlackEffectError: unknown;

	patchCreateContext(runner, () => requestContext);

	const runtime = getRunnerRuntime(runner);
	const originalSetModel = runtime.setModel.bind(runtime);
	runtime.setModel = async (model) => {
		const didSetModel = await originalSetModel(model);
		if (didSetModel) {
			currentModelRef.current = model;
		}
		return didSetModel;
	};

	const originalSendMessage = runtime.sendMessage.bind(runtime);
	const enqueueSlackEffect = (effect: () => Promise<void>): void => {
		const nextEffect = slackEffectChain.catch(() => {}).then(effect);
		slackEffectChain = nextEffect.catch((error) => {
			pendingSlackEffectError = error;
		});
	};
	runtime.sendMessage = (message, options) => {
		if (!slackCallbacks) {
			originalSendMessage(message, options);
			return;
		}

		enqueueSlackEffect(async () => {
			try {
				await renderCustomMessageToSlack(message, slackCallbacks!);
			} finally {
				originalSendMessage(message, options);
			}
		});
	};

	return {
		runner,
		setRequestContext(nextRequestContext: MomRequestContext): void {
			requestContext = nextRequestContext;
		},
		clearRequestContext(): void {
			requestContext = undefined;
		},
		setSlackCallbacks(callbacks: MomSlackMessageCallbacks): void {
			slackCallbacks = callbacks;
		},
		clearSlackCallbacks(): void {
			slackCallbacks = undefined;
		},
		async emitRawInput(
			text: string,
			images: ImageContent[] | undefined,
			source: InputSource,
		): Promise<InputEventResult> {
			if (!runner.hasHandlers("input")) {
				return { action: "continue" };
			}
			return runner.emitInput(text, images, source);
		},
		async emitStartupModelSelect(model: Model<any>, source: StartupModelSelectSource): Promise<void> {
			if (!runner.hasHandlers("model_select")) {
				return;
			}
			await runner.emit({
				type: "model_select",
				model,
				previousModel: undefined,
				source,
			});
		},
		async flushPendingSlackEffects(): Promise<void> {
			await slackEffectChain;
			if (pendingSlackEffectError) {
				const error = pendingSlackEffectError;
				pendingSlackEffectError = undefined;
				throw error;
			}
		},
	};
}

function createNoOpBridge(): MomExtensionBridge {
	return {
		setRequestContext(): void {},
		clearRequestContext(): void {},
		setSlackCallbacks(): void {},
		clearSlackCallbacks(): void {},
		async emitRawInput(): Promise<InputEventResult> {
			return { action: "continue" };
		},
		async emitStartupModelSelect(): Promise<void> {},
		async flushPendingSlackEffects(): Promise<void> {},
	};
}

function patchCreateContext(runner: ExtensionRunner, getRequestContext: () => MomRequestContext | undefined): void {
	const backdoor = runner as unknown as RuntimeBackdoor;
	const originalCreateContext = backdoor.createContext.bind(runner);

	backdoor.createContext = () => {
		const context = originalCreateContext() as MomAugmentedExtensionContext;
		const requestContext = getRequestContext();
		if (!requestContext) {
			return context;
		}

		context.channel = requestContext.channel;
		context.channelId = requestContext.channelId;
		context.channelName = requestContext.channelName;
		context.user = requestContext.user;
		context.userId = requestContext.userId;
		context.userName = requestContext.userName;
		context.threadTs = requestContext.threadTs;
		context.requestContext = requestContext;
		context.message = {
			channel: requestContext.channel,
			user: requestContext.user,
			ts: requestContext.slackTs,
			threadTs: requestContext.threadTs,
			text: requestContext.rawText,
			attachments: requestContext.attachments,
		};
		return context;
	};
}

function getRunnerRuntime(runner: ExtensionRunner): ExtensionRuntime {
	return (runner as unknown as RuntimeBackdoor).runtime;
}

async function renderCustomMessageToSlack(
	message: RuntimeCustomMessage,
	callbacks: MomSlackMessageCallbacks,
): Promise<void> {
	if (message.customType === DIRECT_RESPONSE_CUSTOM_TYPE && isSlackDirectResponseContent(message.content)) {
		callbacks.clearThinking();
		callbacks.markCustomResponseHandled();
		await callbacks.publishFinal(message.content.mainText, true);
		if (message.content.threadText) {
			await callbacks.respondInThread(message.content.threadText);
		}
		return;
	}

	if (message.display !== false && typeof message.content === "string") {
		callbacks.clearThinking();
		await callbacks.respond(message.content, false);
	}
}

function isSlackDirectResponseContent(content: unknown): content is SlackDirectResponseContent {
	return (
		typeof content === "object" &&
		content !== null &&
		"mainText" in content &&
		typeof (content as { mainText?: unknown }).mainText === "string" &&
		(!("threadText" in content) || typeof (content as { threadText?: unknown }).threadText === "string")
	);
}

function readWorkspaceExtensionSettings(workspaceDir: string): {
	values: WorkspaceExtensionSettings;
	warnings: string[];
} {
	const settingsPath = join(workspaceDir, ".pi", "settings.json");
	if (!existsSync(settingsPath)) {
		return { values: {}, warnings: [] };
	}

	try {
		const parsed = JSON.parse(readFileSync(settingsPath, "utf-8")) as WorkspaceExtensionSettings;
		return { values: parsed, warnings: [] };
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		return {
			values: {},
			warnings: [`Ignoring invalid workspace settings file ${settingsPath}: ${message}`],
		};
	}
}

function discoverExtensionEntries(rootPath: string, workspaceDir?: string): DiscoveredEntry[] {
	if (!existsSync(rootPath)) {
		return [];
	}

	const stat = lstatSync(rootPath);
	if (stat.isFile()) {
		if (!isExtensionEntryFile(rootPath)) {
			return [];
		}
		const realPath = realpathSync(rootPath);
		if (workspaceDir && isSameOrInside(realPath, realpathSync(workspaceDir))) {
			throw new Error(`Trusted extension entry resolves inside workspace: ${realPath}`);
		}
		return [
			{
				absolutePath: rootPath,
				realPath,
				sortKey: fileName(rootPath),
			},
		];
	}

	if (!stat.isDirectory()) {
		return [];
	}

	const discovered: DiscoveredEntry[] = [];
	for (const entry of readdirSync(rootPath, { withFileTypes: true })) {
		const absolutePath = join(rootPath, entry.name);
		if (entry.isFile()) {
			if (!isExtensionEntryFile(entry.name)) {
				continue;
			}
			discovered.push(createDiscoveredEntry(rootPath, absolutePath, workspaceDir));
			continue;
		}

		if (!entry.isDirectory()) {
			continue;
		}

		const indexTs = join(absolutePath, "index.ts");
		const indexJs = join(absolutePath, "index.js");
		if (existsSync(indexTs)) {
			discovered.push(createDiscoveredEntry(rootPath, indexTs, workspaceDir));
			continue;
		}
		if (existsSync(indexJs)) {
			discovered.push(createDiscoveredEntry(rootPath, indexJs, workspaceDir));
		}
	}

	return discovered.sort((left, right) => left.sortKey.localeCompare(right.sortKey));
}

function createDiscoveredEntry(rootPath: string, entryPath: string, workspaceDir?: string): DiscoveredEntry {
	const realPath = realpathSync(entryPath);
	if (workspaceDir && isSameOrInside(realPath, realpathSync(workspaceDir))) {
		throw new Error(`Trusted extension entry resolves inside workspace: ${realPath}`);
	}

	return {
		absolutePath: entryPath,
		realPath,
		sortKey: relative(rootPath, entryPath).replaceAll("\\", "/"),
	};
}

function dedupeEntries(entries: string[]): string[] {
	const dedupedEntries: string[] = [];
	const seen = new Set<string>();

	for (const entry of entries) {
		if (seen.has(entry)) {
			continue;
		}
		seen.add(entry);
		dedupedEntries.push(entry);
	}

	return dedupedEntries;
}

function findWorkspaceTrustBoundaryOffenders(workspaceDir: string): string[] {
	const offenders: string[] = [];
	const rootPath = realpathSync(workspaceDir);
	const stack = [rootPath];

	while (stack.length > 0) {
		const currentPath = stack.pop();
		if (!currentPath) {
			continue;
		}

		for (const entry of readdirSync(currentPath, { withFileTypes: true })) {
			const entryPath = join(currentPath, entry.name);
			const relativePath = relative(rootPath, entryPath).replaceAll("\\", "/");

			if (entry.isDirectory()) {
				if (relativePath.endsWith("/.pi/extensions") || relativePath === ".pi/extensions") {
					offenders.push(relativePath);
					continue;
				}
				stack.push(entryPath);
				continue;
			}

			if (!entry.isFile() || !isExtensionEntryFile(entry.name)) {
				continue;
			}

			const segments = relativePath.split("/");
			if (segments.includes("extensions")) {
				offenders.push(relativePath);
			}
		}
	}

	return offenders.sort((left, right) => left.localeCompare(right));
}

function isExtensionEntryFile(filePath: string): boolean {
	return filePath.endsWith(".ts") || filePath.endsWith(".js");
}

function isSameOrInside(candidatePath: string, parentPath: string): boolean {
	const relativePath = relative(parentPath, candidatePath);
	return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("../"));
}

function fileName(filePath: string): string {
	const segments = filePath.replaceAll("\\", "/").split("/");
	return segments[segments.length - 1] ?? filePath;
}
