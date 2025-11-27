#!/usr/bin/env node

import { join, resolve } from "path";
import { type AgentRunner, createAgentRunner } from "./agent.js";
import * as log from "./log.js";
import { parseSandboxArg, type SandboxConfig, validateSandbox } from "./sandbox.js";
import { MomBot, type SlackContext } from "./slack.js";

const MOM_SLACK_APP_TOKEN = process.env.MOM_SLACK_APP_TOKEN;
const MOM_SLACK_BOT_TOKEN = process.env.MOM_SLACK_BOT_TOKEN;
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY;
const ANTHROPIC_OAUTH_TOKEN = process.env.ANTHROPIC_OAUTH_TOKEN;

// Parse command line arguments
function parseArgs(): { workingDir: string; sandbox: SandboxConfig } {
	const args = process.argv.slice(2);
	let sandbox: SandboxConfig = { type: "host" };
	let workingDir: string | undefined;

	for (let i = 0; i < args.length; i++) {
		const arg = args[i];
		if (arg.startsWith("--sandbox=")) {
			sandbox = parseSandboxArg(arg.slice("--sandbox=".length));
		} else if (arg === "--sandbox") {
			const next = args[++i];
			if (!next) {
				console.error("Error: --sandbox requires a value (host or docker:<container-name>)");
				process.exit(1);
			}
			sandbox = parseSandboxArg(next);
		} else if (!arg.startsWith("-")) {
			workingDir = arg;
		} else {
			console.error(`Unknown option: ${arg}`);
			process.exit(1);
		}
	}

	if (!workingDir) {
		console.error("Usage: mom [--sandbox=host|docker:<container-name>] <working-directory>");
		console.error("");
		console.error("Options:");
		console.error("  --sandbox=host                  Run tools directly on host (default)");
		console.error("  --sandbox=docker:<container>    Run tools in Docker container");
		console.error("");
		console.error("Examples:");
		console.error("  mom ./data");
		console.error("  mom --sandbox=docker:mom-sandbox ./data");
		process.exit(1);
	}

	return { workingDir: resolve(workingDir), sandbox };
}

const { workingDir, sandbox } = parseArgs();

log.logStartup(workingDir, sandbox.type === "host" ? "host" : `docker:${sandbox.container}`);

if (!MOM_SLACK_APP_TOKEN || !MOM_SLACK_BOT_TOKEN || (!ANTHROPIC_API_KEY && !ANTHROPIC_OAUTH_TOKEN)) {
	console.error("Missing required environment variables:");
	if (!MOM_SLACK_APP_TOKEN) console.error("  - MOM_SLACK_APP_TOKEN (xapp-...)");
	if (!MOM_SLACK_BOT_TOKEN) console.error("  - MOM_SLACK_BOT_TOKEN (xoxb-...)");
	if (!ANTHROPIC_API_KEY && !ANTHROPIC_OAUTH_TOKEN) console.error("  - ANTHROPIC_API_KEY or ANTHROPIC_OAUTH_TOKEN");
	process.exit(1);
}

// Validate sandbox configuration
await validateSandbox(sandbox);

// Track active agent runs per channel
const activeRuns = new Map<string, { runner: AgentRunner; context: SlackContext; stopContext?: SlackContext }>();

async function handleMessage(ctx: SlackContext, _source: "channel" | "dm"): Promise<void> {
	const channelId = ctx.message.channel;
	const messageText = ctx.message.text.toLowerCase().trim();

	const logCtx = {
		channelId: ctx.message.channel,
		userName: ctx.message.userName,
		channelName: ctx.channelName,
	};

	// Check for stop command
	if (messageText === "stop") {
		const active = activeRuns.get(channelId);
		if (active) {
			log.logStopRequest(logCtx);
			// Post a NEW message saying "Stopping..."
			await ctx.respond("_Stopping..._");
			// Store this context to update it to "Stopped" later
			active.stopContext = ctx;
			// Abort the runner
			active.runner.abort();
		} else {
			await ctx.respond("_Nothing running._");
		}
		return;
	}

	// Check if already running in this channel
	if (activeRuns.has(channelId)) {
		await ctx.respond("_Already working on something. Say `@mom stop` to cancel._");
		return;
	}

	log.logUserMessage(logCtx, ctx.message.text);
	const channelDir = join(workingDir, channelId);

	const runner = createAgentRunner(sandbox);
	activeRuns.set(channelId, { runner, context: ctx });

	await ctx.setTyping(true);
	await ctx.setWorking(true);

	const result = await runner.run(ctx, channelDir, ctx.store);

	// Remove working indicator
	await ctx.setWorking(false);

	// Handle different stop reasons
	const active = activeRuns.get(channelId);
	if (result.stopReason === "aborted") {
		// Replace the STOP message with "Stopped"
		if (active?.stopContext) {
			await active.stopContext.setWorking(false);
			await active.stopContext.replaceMessage("_Stopped_");
		}
	} else if (result.stopReason === "error") {
		// Agent encountered an error
		log.logAgentError(logCtx, "Agent stopped with error");
	}
	// "stop", "length", "toolUse" are normal completions - nothing extra to do

	activeRuns.delete(channelId);
}

const bot = new MomBot(
	{
		async onChannelMention(ctx) {
			await handleMessage(ctx, "channel");
		},

		async onDirectMessage(ctx) {
			await handleMessage(ctx, "dm");
		},
	},
	{
		appToken: MOM_SLACK_APP_TOKEN,
		botToken: MOM_SLACK_BOT_TOKEN,
		workingDir,
	},
);

bot.start();
