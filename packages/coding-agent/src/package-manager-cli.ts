import { join } from "node:path";
import { Markdown, type MarkdownTheme, t } from "@earendil-works/pi-tui";
import chalk from "chalk";
import { selectConfig } from "./cli/config-selector.ts";
import { createProjectTrustContext } from "./cli/project-trust.ts";
import {
	APP_NAME,
	CONFIG_DIR_NAME,
	detectInstallMethod,
	getAgentDir,
	getPackageDir,
	getSelfUpdateCommand,
	getSelfUpdateUnavailableInstruction,
	PACKAGE_NAME,
	type SelfUpdateCommand,
	type SelfUpdatePackageTarget,
	VERSION,
} from "./config.ts";
import type { InlineExtension } from "./core/extensions/types.ts";
import { ModelRuntime } from "./core/model-runtime.ts";
import { DefaultPackageManager } from "./core/package-manager.ts";
import { type AppMode, resolveProjectTrusted } from "./core/project-trust.ts";
import { DefaultResourceLoader } from "./core/resource-loader.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { hasTrustRequiringProjectResources, ProjectTrustStore } from "./core/trust-manager.ts";
import { spawnProcess } from "./utils/child-process.ts";
import { formatVersionCheckError, getLatestPiRelease, isNewerPackageVersion } from "./utils/version-check.ts";
import {
	cleanupWindowsSelfUpdateQuarantine,
	quarantineWindowsNativeDependencies,
} from "./utils/windows-self-update.ts";

export type PackageCommand = "install" | "remove" | "update" | "list";

type UpdateTarget = { type: "all" } | { type: "self" } | { type: "extensions"; source?: string } | { type: "models" };

const SELF_UPDATE_NOTE_MARKDOWN_THEME: MarkdownTheme = {
	heading: (text) => chalk.bold(chalk.yellow(text)),
	link: (text) => chalk.cyan(text),
	linkUrl: (text) => chalk.dim(text),
	code: (text) => chalk.yellow(text),
	codeBlock: (text) => chalk.dim(text),
	codeBlockBorder: (text) => chalk.dim(text),
	quote: (text) => chalk.dim(text),
	quoteBorder: (text) => chalk.dim(text),
	hr: (text) => chalk.dim(text),
	listBullet: (text) => chalk.yellow(text),
	bold: (text) => chalk.bold(text),
	italic: (text) => chalk.italic(text),
	strikethrough: (text) => chalk.strikethrough(text),
	underline: (text) => chalk.underline(text),
};

interface PackageCommandOptions {
	command: PackageCommand;
	source?: string;
	updateTarget?: UpdateTarget;
	showExtensionsSkippedNote: boolean;
	local: boolean;
	force: boolean;
	projectTrustOverride?: boolean;
	help: boolean;
	invalidOption?: string;
	invalidArgument?: string;
	missingOptionValue?: string;
	conflictingOptions?: string;
}

function reportSettingsErrors(settingsManager: SettingsManager, context: string): void {
	const errors = settingsManager.drainErrors();
	for (const { scope, error } of errors) {
		console.error(
			chalk.yellow(
				t("codingAgent.packageManager.warnings.settingsWarning", { context, scope, message: error.message }),
			),
		);
		if (error.stack) {
			console.error(chalk.dim(error.stack));
		}
	}
}

function getPackageCommandUsage(command: PackageCommand): string {
	switch (command) {
		case "install":
			return `${APP_NAME} install <source> [-l] [--approve|--no-approve]`;
		case "remove":
			return `${APP_NAME} remove <source> [-l] [--approve|--no-approve]`;
		case "update":
			return `${APP_NAME} update [source|self|pi] [--self|--extensions|--models|--all] [--extension <source>] [--approve|--no-approve] [--force]`;
		case "list":
			return `${APP_NAME} list [--approve|--no-approve]`;
	}
}

const CONFIG_COMMAND_USAGE = `${APP_NAME} config [-l] [--approve|--no-approve]`;

function printConfigCommandHelp(): void {
	console.log(`${chalk.bold(t("codingAgent.packageManager.configHelp.usage"))}
  ${CONFIG_COMMAND_USAGE}

${t("codingAgent.packageManager.configHelp.openConfigTui")}
${t("codingAgent.packageManager.configHelp.withoutLocalFlag", { configDir: CONFIG_DIR_NAME })}
${t("codingAgent.packageManager.configHelp.pressTabHint")}

${t("codingAgent.packageManager.configHelp.options")}
  -l, --local       ${t("codingAgent.packageManager.configHelp.localOption", { configDir: CONFIG_DIR_NAME })}
  -a, --approve     ${t("codingAgent.packageManager.configHelp.approveOption")}
  -na, --no-approve ${t("codingAgent.packageManager.configHelp.noApproveOption")}
`);
}

function printPackageCommandHelp(command: PackageCommand): void {
	switch (command) {
		case "install":
			console.log(`${chalk.bold(t("codingAgent.packageManager.packageHelp.usage"))}
  ${getPackageCommandUsage("install")}

${t("codingAgent.packageManager.packageHelp.installDescription")}

${t("codingAgent.packageManager.packageHelp.options")}
  -l, --local       ${t("codingAgent.packageManager.packageHelp.localOptionInstall", { configDir: CONFIG_DIR_NAME })}
  -a, --approve     ${t("codingAgent.packageManager.packageHelp.approveOption")}
  -na, --no-approve ${t("codingAgent.packageManager.packageHelp.noApproveOption")}

${t("codingAgent.packageManager.packageHelp.examples")}
  ${APP_NAME} install npm:@foo/bar
  ${APP_NAME} install git:github.com/user/repo
  ${APP_NAME} install git:git@github.com:user/repo
  ${APP_NAME} install https://github.com/user/repo
  ${APP_NAME} install ssh://git@github.com/user/repo
  ${APP_NAME} install ./local/path
`);
			return;

		case "remove":
			console.log(`${chalk.bold(t("codingAgent.packageManager.packageHelp.usage"))}
  ${getPackageCommandUsage("remove")}

${t("codingAgent.packageManager.packageHelp.removeDescription")}
${t("codingAgent.packageManager.packageHelp.removeAlias", { appName: APP_NAME })}

${t("codingAgent.packageManager.packageHelp.options")}
  -l, --local       ${t("codingAgent.packageManager.packageHelp.localOptionRemove", { configDir: CONFIG_DIR_NAME })}
  -a, --approve     ${t("codingAgent.packageManager.packageHelp.approveOption")}
  -na, --no-approve ${t("codingAgent.packageManager.packageHelp.noApproveOption")}

${t("codingAgent.packageManager.packageHelp.examples")}
  ${APP_NAME} remove npm:@foo/bar
  ${APP_NAME} uninstall npm:@foo/bar
`);
			return;

		case "update":
			console.log(`${chalk.bold(t("codingAgent.packageManager.packageHelp.usage"))}
  ${getPackageCommandUsage("update")}

${t("codingAgent.packageManager.packageHelp.updateDescription")}

${t("codingAgent.packageManager.packageHelp.options")}
  --self                  ${t("codingAgent.packageManager.packageHelp.selfUpdateOption")}
  --extensions            ${t("codingAgent.packageManager.packageHelp.extensionsOption")}
  --models                ${t("codingAgent.packageManager.packageHelp.modelsOption")}
  --all                   ${t("codingAgent.packageManager.packageHelp.allOption")}
  --extension <source>    ${t("codingAgent.packageManager.packageHelp.extensionOption")}
  -a, --approve           ${t("codingAgent.packageManager.packageHelp.approveOption")}
  -na, --no-approve       ${t("codingAgent.packageManager.packageHelp.noApproveOption")}
  --force                 ${t("codingAgent.packageManager.packageHelp.forceOption")}

${t("codingAgent.packageManager.packageHelp.shortForms")}
  ${APP_NAME} update                ${t("codingAgent.packageManager.packageHelp.shortFormSelf", { appName: APP_NAME })}
  ${APP_NAME} update --all          ${t("codingAgent.packageManager.packageHelp.shortFormAll", { appName: APP_NAME })}
  ${APP_NAME} update --models       ${t("codingAgent.packageManager.packageHelp.shortFormModels", { appName: APP_NAME })}
  ${APP_NAME} update <source>       ${t("codingAgent.packageManager.packageHelp.shortFormSource", { appName: APP_NAME })}
  ${APP_NAME} update pi             ${t("codingAgent.packageManager.packageHelp.shortFormPi", { appName: APP_NAME })}
`);
			return;

		case "list":
			console.log(`${chalk.bold(t("codingAgent.packageManager.packageHelp.usage"))}
  ${getPackageCommandUsage("list")}

${t("codingAgent.packageManager.packageHelp.listDescription")}

${t("codingAgent.packageManager.packageHelp.options")}
  -a, --approve      ${t("codingAgent.packageManager.packageHelp.approveOption")}
  -na, --no-approve  ${t("codingAgent.packageManager.packageHelp.noApproveOption")}
`);
			return;
	}
}

function parsePackageCommand(args: string[]): PackageCommandOptions | undefined {
	const [rawCommand, ...rest] = args;
	let command: PackageCommand | undefined;
	if (rawCommand === "uninstall") {
		command = "remove";
	} else if (rawCommand === "install" || rawCommand === "remove" || rawCommand === "update" || rawCommand === "list") {
		command = rawCommand;
	}
	if (!command) {
		return undefined;
	}

	let local = false;
	let force = false;
	let projectTrustOverride: boolean | undefined;
	let help = false;
	let invalidOption: string | undefined;
	let invalidArgument: string | undefined;
	let missingOptionValue: string | undefined;
	let conflictingOptions: string | undefined;
	let source: string | undefined;
	let selfFlag = false;
	let extensionsFlag = false;
	let modelsFlag = false;
	let allFlag = false;
	let extensionFlagSource: string | undefined;

	for (let index = 0; index < rest.length; index++) {
		const arg = rest[index];
		if (arg === "-h" || arg === "--help") {
			help = true;
			continue;
		}

		if (arg === "-l" || arg === "--local") {
			if (command === "install" || command === "remove") {
				local = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--self") {
			if (command === "update") {
				selfFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--extensions") {
			if (command === "update") {
				extensionsFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--models") {
			if (command === "update") {
				modelsFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--all") {
			if (command === "update") {
				allFlag = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--approve" || arg === "-a") {
			projectTrustOverride = true;
			continue;
		}

		if (arg === "--no-approve" || arg === "-na") {
			projectTrustOverride = false;
			continue;
		}

		if (arg === "--force") {
			if (command === "update") {
				force = true;
			} else {
				invalidOption = invalidOption ?? arg;
			}
			continue;
		}

		if (arg === "--extension") {
			if (command !== "update") {
				invalidOption = invalidOption ?? arg;
				continue;
			}

			const value = rest[index + 1];
			if (!value || value.startsWith("-")) {
				missingOptionValue = missingOptionValue ?? arg;
			} else if (extensionFlagSource) {
				conflictingOptions = conflictingOptions ?? "--extension can only be provided once";
				index++;
			} else {
				extensionFlagSource = value;
				index++;
			}
			continue;
		}

		if (arg.startsWith("-")) {
			invalidOption = invalidOption ?? arg;
			continue;
		}

		if (!source) {
			source = arg;
		} else {
			invalidArgument = invalidArgument ?? arg;
		}
	}

	let updateTarget: UpdateTarget | undefined;
	let showExtensionsSkippedNote = false;
	if (command === "update") {
		if (allFlag && (selfFlag || extensionsFlag || modelsFlag || extensionFlagSource)) {
			conflictingOptions =
				conflictingOptions ?? "--all cannot be combined with --self, --extensions, --models, or --extension";
		}
		if (allFlag && source) {
			conflictingOptions = conflictingOptions ?? "--all cannot be combined with a positional source";
		}

		if (modelsFlag) {
			if (selfFlag || extensionsFlag || allFlag || extensionFlagSource) {
				conflictingOptions =
					conflictingOptions ?? "--models cannot be combined with --self, --extensions, --all, or --extension";
			}
			if (source) {
				conflictingOptions = conflictingOptions ?? "--models cannot be combined with a positional source";
			}
			updateTarget = { type: "models" };
		} else if (extensionFlagSource) {
			if (selfFlag || extensionsFlag || allFlag) {
				conflictingOptions =
					conflictingOptions ?? "--extension cannot be combined with --self, --extensions, or --all";
			}
			if (source) {
				conflictingOptions = conflictingOptions ?? "--extension cannot be combined with a positional source";
			}
			updateTarget = { type: "extensions", source: extensionFlagSource };
		} else if (source) {
			const sourceIsSelf = source === "self" || source === "pi";
			if (sourceIsSelf) {
				updateTarget = extensionsFlag ? { type: "all" } : { type: "self" };
			} else {
				if (extensionsFlag || selfFlag || allFlag) {
					conflictingOptions =
						conflictingOptions ??
						"positional update targets cannot be combined with --self, --extensions, or --all";
				}
				updateTarget = { type: "extensions", source };
			}
		} else if (allFlag) {
			updateTarget = { type: "all" };
		} else if (selfFlag && extensionsFlag) {
			updateTarget = { type: "all" };
		} else if (selfFlag) {
			updateTarget = { type: "self" };
		} else if (extensionsFlag) {
			updateTarget = { type: "extensions" };
		} else {
			updateTarget = { type: "self" };
			showExtensionsSkippedNote = true;
		}
	}

	return {
		command,
		source,
		updateTarget,
		showExtensionsSkippedNote,
		local,
		force,
		projectTrustOverride,
		help,
		invalidOption,
		invalidArgument,
		missingOptionValue,
		conflictingOptions,
	};
}

function updateTargetIncludesSelf(target: UpdateTarget): boolean {
	return target.type === "all" || target.type === "self";
}

function updateTargetIncludesExtensions(target: UpdateTarget): boolean {
	return target.type === "all" || target.type === "extensions";
}

async function refreshModelCatalogs(agentDir: string): Promise<void> {
	const controller = new AbortController();
	const timeout = setTimeout(() => controller.abort(), 15_000);
	try {
		const modelRuntime = await ModelRuntime.create({
			authPath: join(agentDir, "auth.json"),
			modelsPath: join(agentDir, "models.json"),
			allowModelNetwork: false,
			signal: controller.signal,
		});
		const result = await modelRuntime.refresh({
			allowNetwork: true,
			force: true,
			signal: controller.signal,
		});
		if (result.aborted) {
			throw new Error(t("codingAgent.packageManager.errors.modelCatalogRefreshFailed"));
		}
		if (result.errors.size > 0) {
			const details = Array.from(result.errors, ([provider, error]) => `${provider}: ${error.message}`).join("; ");
			throw new Error(t("codingAgent.packageManager.errors.couldNotRefreshModels", { details }));
		}
	} finally {
		clearTimeout(timeout);
	}
	console.log(chalk.green(t("codingAgent.packageManager.success.modelCatalogsRefreshed")));
}

function printSelfUpdateUnavailable(
	npmCommand?: string[],
	updatePackageTarget: SelfUpdatePackageTarget = PACKAGE_NAME,
): void {
	console.error(t("codingAgent.packageManager.errors.selfUpdateUnavailable", { appName: APP_NAME }));
	console.error(getSelfUpdateUnavailableInstruction(PACKAGE_NAME, npmCommand, updatePackageTarget));

	const entrypoint = process.argv[1];
	if (entrypoint) {
		console.error("");
		console.error(t("codingAgent.packageManager.errors.executableLocation", { appName: APP_NAME, entrypoint }));
	}
}

function printSelfUpdateFallback(command: SelfUpdateCommand): void {
	console.error(chalk.dim(t("codingAgent.packageManager.errors.selfUpdateFailedHint", { command: command.display })));
}

function printPnpmSelfUpdateMetadataHint(): void {
	console.error(chalk.yellow(t("codingAgent.packageManager.errors.pnpmStaleMetadata")));
	console.error(chalk.yellow(t("codingAgent.packageManager.errors.pnpmRetryHint", { appName: APP_NAME })));
}

function printSelfUpdateNote(note: string): void {
	const trimmedNote = note.trim();
	if (!trimmedNote) {
		return;
	}

	console.log();
	console.log(chalk.bold(chalk.yellow(t("codingAgent.packageManager.updateNote"))));
	try {
		const width = Math.max(20, process.stdout.columns ?? 80);
		const renderedLines = new Markdown(trimmedNote, 0, 0, SELF_UPDATE_NOTE_MARKDOWN_THEME)
			.render(width)
			.map((line) => line.trimEnd());
		console.log(renderedLines.join("\n"));
	} catch {
		console.log(trimmedNote);
	}
	console.log();
}

interface SelfUpdatePlan {
	packageName: string;
	installSpec: string;
	version: string;
	shouldRun: boolean;
	note?: string;
}

async function getSelfUpdatePlan(force: boolean): Promise<SelfUpdatePlan> {
	let latestRelease: Awaited<ReturnType<typeof getLatestPiRelease>>;
	try {
		latestRelease = await getLatestPiRelease(VERSION, { retry: true });
	} catch (error: unknown) {
		throw new Error(
			t("codingAgent.packageManager.errors.couldNotDetermineVersion", {
				appName: APP_NAME,
				error: formatVersionCheckError(error),
			}),
			{
				cause: error,
			},
		);
	}
	if (!latestRelease) {
		throw new Error(t("codingAgent.packageManager.errors.couldNotDetermineVersionSimple", { appName: APP_NAME }));
	}

	const packageName = latestRelease.packageName ?? PACKAGE_NAME;
	const installSpec = `${packageName}@${latestRelease.version}`;
	if (force || packageName !== PACKAGE_NAME || isNewerPackageVersion(latestRelease.version, VERSION)) {
		return {
			packageName,
			installSpec,
			version: latestRelease.version,
			...(latestRelease.note ? { note: latestRelease.note } : {}),
			shouldRun: true,
		};
	}

	console.log(
		chalk.green(t("codingAgent.packageManager.success.alreadyUpToDate", { appName: APP_NAME, version: VERSION })),
	);
	return { packageName, installSpec, version: latestRelease.version, shouldRun: false };
}

async function runSelfUpdate(command: SelfUpdateCommand): Promise<void> {
	console.log(
		chalk.dim(t("codingAgent.packageManager.success.updating", { appName: APP_NAME, command: command.display })),
	);
	for (const step of command.steps ?? [command]) {
		await new Promise<void>((resolve, reject) => {
			const child = spawnProcess(step.command, step.args, {
				stdio: "inherit",
			});
			child.on("error", (error) => {
				reject(error);
			});
			child.on("close", (code, signal) => {
				if (code === 0) {
					resolve();
				} else if (signal) {
					reject(new Error(`${step.display} terminated by signal ${signal}`));
				} else {
					reject(new Error(`${step.display} exited with code ${code ?? "unknown"}`));
				}
			});
		});
	}
}

function prepareWindowsNpmSelfUpdate(): void {
	if (process.platform !== "win32") {
		return;
	}

	const packageDir = getPackageDir();
	cleanupWindowsSelfUpdateQuarantine(packageDir);
	quarantineWindowsNativeDependencies(packageDir);
}

export interface PackageCommandRuntimeOptions {
	extensionFactories?: InlineExtension[];
}

interface CommandSettingsResult {
	settingsManager: SettingsManager;
	projectTrustWarnings: string[];
}

function getCommandAppMode(): AppMode {
	return process.stdin.isTTY && process.stdout.isTTY ? "interactive" : "print";
}

function reportProjectTrustWarnings(warnings: readonly string[]): void {
	for (const warning of warnings) {
		console.error(chalk.yellow(t("codingAgent.packageManager.warnings.projectTrustWarning", { message: warning })));
	}
}

async function createCommandSettingsManager(options: {
	cwd: string;
	agentDir: string;
	projectTrustOverride?: boolean;
	useSavedProjectTrustOnly?: boolean;
	extensionFactories?: InlineExtension[];
}): Promise<CommandSettingsResult> {
	const settingsManager = SettingsManager.create(options.cwd, options.agentDir, { projectTrusted: false });
	const projectTrustWarnings: string[] = [];
	const trustStore = new ProjectTrustStore(options.agentDir);
	if (options.useSavedProjectTrustOnly) {
		const savedProjectTrusted = trustStore.get(options.cwd) === true;
		settingsManager.setProjectTrusted(options.projectTrustOverride ?? savedProjectTrusted);
		return { settingsManager, projectTrustWarnings };
	}

	const appMode = getCommandAppMode();
	const extensionsResult =
		options.projectTrustOverride === undefined && hasTrustRequiringProjectResources(options.cwd)
			? await new DefaultResourceLoader({
					cwd: options.cwd,
					agentDir: options.agentDir,
					settingsManager,
					extensionFactories: options.extensionFactories,
				}).loadProjectTrustExtensions()
			: undefined;
	for (const error of extensionsResult?.errors ?? []) {
		projectTrustWarnings.push(`Failed to load extension "${error.path}": ${error.error}`);
	}

	const projectTrusted = await resolveProjectTrusted({
		cwd: options.cwd,
		trustStore,
		trustOverride: options.projectTrustOverride,
		defaultProjectTrust: settingsManager.getDefaultProjectTrust(),
		extensionsResult,
		projectTrustContext: createProjectTrustContext({
			cwd: options.cwd,
			mode: appMode,
			settingsManager,
			hasUI: appMode === "interactive",
		}),
		onExtensionError: (message) => projectTrustWarnings.push(message),
	});
	settingsManager.setProjectTrusted(projectTrusted);
	return { settingsManager, projectTrustWarnings };
}

export async function handleConfigCommand(
	args: string[],
	runtimeOptions: PackageCommandRuntimeOptions = {},
): Promise<boolean> {
	const [command, ...rest] = args;
	if (command !== "config") {
		return false;
	}

	if (rest.includes("-h") || rest.includes("--help")) {
		printConfigCommandHelp();
		return true;
	}

	let local = false;
	let projectTrustOverride: boolean | undefined;
	for (const arg of rest) {
		if (arg === "-l" || arg === "--local") {
			local = true;
		} else if (arg === "-a" || arg === "--approve") {
			projectTrustOverride = true;
		} else if (arg === "-na" || arg === "--no-approve") {
			projectTrustOverride = false;
		} else if (arg.startsWith("-")) {
			console.error(
				chalk.red(t("codingAgent.packageManager.errors.unknownOption", { option: arg, command: "config" })),
			);
			console.error(
				chalk.dim(
					t("codingAgent.packageManager.errors.useHelpHint", { appName: APP_NAME, usage: CONFIG_COMMAND_USAGE }),
				),
			);
			process.exitCode = 1;
			return true;
		} else {
			console.error(chalk.red(t("codingAgent.packageManager.errors.unexpectedArgument", { argument: arg })));
			console.error(chalk.dim(`${t("codingAgent.packageManager.configHelp.usage")} ${CONFIG_COMMAND_USAGE}`));
			process.exitCode = 1;
			return true;
		}
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const { settingsManager, projectTrustWarnings } = await createCommandSettingsManager({
		cwd,
		agentDir,
		projectTrustOverride,
		extensionFactories: runtimeOptions.extensionFactories,
	});
	reportProjectTrustWarnings(projectTrustWarnings);
	if (local && !settingsManager.isProjectTrusted()) {
		console.error(chalk.red(t("codingAgent.packageManager.errors.projectNotTrustedConfig")));
		process.exitCode = 1;
		return true;
	}
	reportSettingsErrors(settingsManager, "config command");
	const globalSettingsManager = SettingsManager.create(cwd, agentDir, { projectTrusted: false });
	const globalResolvedPaths = await new DefaultPackageManager({
		cwd,
		agentDir,
		settingsManager: globalSettingsManager,
	}).resolve();
	const projectResolvedPaths = settingsManager.isProjectTrusted()
		? await new DefaultPackageManager({ cwd, agentDir, settingsManager }).resolve()
		: globalResolvedPaths;

	await selectConfig({
		resolvedPaths: { global: globalResolvedPaths, project: projectResolvedPaths },
		settingsManager,
		cwd,
		agentDir,
		writeScope: local ? "project" : "global",
		projectModeAvailable: settingsManager.isProjectTrusted(),
	});

	process.exit(0);
}

export async function handlePackageCommand(
	args: string[],
	runtimeOptions: PackageCommandRuntimeOptions = {},
): Promise<boolean> {
	const options = parsePackageCommand(args);
	if (!options) {
		return false;
	}

	if (options.help) {
		printPackageCommandHelp(options.command);
		return true;
	}

	if (options.invalidOption) {
		console.error(
			chalk.red(
				t("codingAgent.packageManager.errors.unknownOption", {
					option: options.invalidOption,
					command: options.command,
				}),
			),
		);
		console.error(
			chalk.dim(
				t("codingAgent.packageManager.errors.useHelpHint", {
					appName: APP_NAME,
					usage: getPackageCommandUsage(options.command),
				}),
			),
		);
		process.exitCode = 1;
		return true;
	}

	if (options.missingOptionValue) {
		console.error(
			chalk.red(t("codingAgent.packageManager.errors.missingValue", { option: options.missingOptionValue })),
		);
		console.error(
			chalk.dim(`${t("codingAgent.packageManager.packageHelp.usage")} ${getPackageCommandUsage(options.command)}`),
		);
		process.exitCode = 1;
		return true;
	}

	if (options.invalidArgument) {
		console.error(
			chalk.red(t("codingAgent.packageManager.errors.unexpectedArgument", { argument: options.invalidArgument })),
		);
		console.error(
			chalk.dim(`${t("codingAgent.packageManager.packageHelp.usage")} ${getPackageCommandUsage(options.command)}`),
		);
		process.exitCode = 1;
		return true;
	}

	if (options.conflictingOptions) {
		console.error(chalk.red(options.conflictingOptions));
		console.error(
			chalk.dim(`${t("codingAgent.packageManager.packageHelp.usage")} ${getPackageCommandUsage(options.command)}`),
		);
		process.exitCode = 1;
		return true;
	}

	const source = options.source;
	if ((options.command === "install" || options.command === "remove") && !source) {
		console.error(chalk.red(t("codingAgent.packageManager.errors.missingSource", { command: options.command })));
		console.error(
			chalk.dim(`${t("codingAgent.packageManager.packageHelp.usage")} ${getPackageCommandUsage(options.command)}`),
		);
		process.exitCode = 1;
		return true;
	}

	if (options.command === "update" && options.updateTarget?.type === "models") {
		try {
			await refreshModelCatalogs(getAgentDir());
		} catch (error: unknown) {
			const message =
				error instanceof Error ? error.message : t("codingAgent.packageManager.errors.unknownModelError");
			console.error(chalk.red(t("codingAgent.packageManager.errors.genericError", { message })));
			process.exitCode = 1;
		}
		return true;
	}

	const cwd = process.cwd();
	const agentDir = getAgentDir();
	const writesProjectPackageConfig = (options.command === "install" || options.command === "remove") && options.local;
	const { settingsManager, projectTrustWarnings } = await createCommandSettingsManager({
		cwd,
		agentDir,
		projectTrustOverride: options.projectTrustOverride,
		useSavedProjectTrustOnly: options.command === "update",
		extensionFactories: runtimeOptions.extensionFactories,
	});
	reportProjectTrustWarnings(projectTrustWarnings);
	if (!settingsManager.isProjectTrusted() && writesProjectPackageConfig) {
		console.error(chalk.red(t("codingAgent.packageManager.errors.projectNotTrustedPackage")));
		process.exitCode = 1;
		return true;
	}
	reportSettingsErrors(settingsManager, "package command");
	const selfUpdateNpmCommand = settingsManager.getGlobalSettings().npmCommand;

	const packageManager = new DefaultPackageManager({ cwd, agentDir, settingsManager });

	packageManager.setProgressCallback((event) => {
		if (event.type === "start") {
			process.stdout.write(chalk.dim(`${event.message}\n`));
		}
	});

	try {
		switch (options.command) {
			case "install":
				await packageManager.installAndPersist(source!, { local: options.local });
				console.log(chalk.green(t("codingAgent.packageManager.success.installed", { source: source! })));
				return true;

			case "remove": {
				const removed = await packageManager.removeAndPersist(source!, { local: options.local });
				if (!removed) {
					console.error(chalk.red(t("codingAgent.packageManager.errors.noMatchingPackage", { source: source! })));
					process.exitCode = 1;
					return true;
				}
				console.log(chalk.green(t("codingAgent.packageManager.success.removed", { source: source! })));
				return true;
			}

			case "list": {
				const configuredPackages = packageManager.listConfiguredPackages();
				const userPackages = configuredPackages.filter((pkg) => pkg.scope === "user");
				const projectPackages = configuredPackages.filter((pkg) => pkg.scope === "project");

				if (configuredPackages.length === 0) {
					console.log(chalk.dim(t("codingAgent.packageManager.success.noPackagesInstalled")));
					return true;
				}

				const formatPackage = (pkg: (typeof configuredPackages)[number]) => {
					const display = pkg.filtered ? `${pkg.source} (filtered)` : pkg.source;
					console.log(`  ${display}`);
					if (pkg.installedPath) {
						console.log(chalk.dim(`    ${pkg.installedPath}`));
					}
				};

				if (userPackages.length > 0) {
					console.log(chalk.bold(t("codingAgent.packageManager.success.userPackages")));
					for (const pkg of userPackages) {
						formatPackage(pkg);
					}
				}

				if (projectPackages.length > 0) {
					if (userPackages.length > 0) console.log();
					console.log(chalk.bold(t("codingAgent.packageManager.success.projectPackages")));
					for (const pkg of projectPackages) {
						formatPackage(pkg);
					}
				}

				return true;
			}

			case "update": {
				const target = options.updateTarget ?? { type: "self" };
				if (options.showExtensionsSkippedNote) {
					console.log(chalk.dim(t("codingAgent.packageManager.success.extensionsSkipped", { appName: APP_NAME })));
				}
				if (updateTargetIncludesExtensions(target)) {
					const updateSource = target.type === "extensions" ? target.source : undefined;
					await packageManager.update(updateSource);
					if (updateSource) {
						console.log(
							chalk.green(t("codingAgent.packageManager.success.updatedPackage", { source: updateSource })),
						);
					} else {
						console.log(chalk.green(t("codingAgent.packageManager.success.updatedPackages")));
					}
				}
				if (updateTargetIncludesSelf(target)) {
					const selfUpdatePlan = await getSelfUpdatePlan(options.force);
					if (!selfUpdatePlan.shouldRun) {
						return true;
					}
					const installMethod = detectInstallMethod();
					if (process.platform === "win32" && installMethod !== "npm" && installMethod !== "pnpm") {
						console.error(
							chalk.red(
								t("codingAgent.packageManager.errors.windowsSelfUpdateUnsupported", { appName: APP_NAME }),
							),
						);
						console.error(
							chalk.dim(
								t("codingAgent.packageManager.errors.detectedInstallMethod", {
									method: installMethod,
									appName: APP_NAME,
								}),
							),
						);
						process.exitCode = 1;
						return true;
					}
					const selfUpdateTarget = {
						packageName: selfUpdatePlan.packageName,
						installSpec: selfUpdatePlan.installSpec,
					};
					const selfUpdateCommand = getSelfUpdateCommand(PACKAGE_NAME, selfUpdateNpmCommand, selfUpdateTarget);
					if (!selfUpdateCommand) {
						printSelfUpdateUnavailable(selfUpdateNpmCommand, selfUpdateTarget);
						process.exitCode = 1;
						return true;
					}
					if (selfUpdatePlan.note) {
						printSelfUpdateNote(selfUpdatePlan.note);
					}
					try {
						if (installMethod === "npm") {
							prepareWindowsNpmSelfUpdate();
						}
						await runSelfUpdate(selfUpdateCommand);
					} catch (error: unknown) {
						const message = error instanceof Error ? error.message : "Unknown package command error";
						console.error(chalk.red(t("codingAgent.packageManager.errors.genericError", { message })));
						if (installMethod === "pnpm") {
							printPnpmSelfUpdateMetadataHint();
						}
						printSelfUpdateFallback(selfUpdateCommand);
						process.exitCode = 1;
						return true;
					}
					console.log(
						chalk.green(
							t("codingAgent.packageManager.success.updatedPi", {
								appName: APP_NAME,
								oldVersion: VERSION,
								newVersion: selfUpdatePlan.version,
							}),
						),
					);
				}
				return true;
			}
		}
	} catch (error: unknown) {
		const message = error instanceof Error ? error.message : "Unknown package command error";
		console.error(chalk.red(t("codingAgent.packageManager.errors.genericError", { message })));
		process.exitCode = 1;
		return true;
	}
}
