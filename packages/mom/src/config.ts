/**
 * Runtime configuration from environment variables.
 * Slack thread/conversation UX (replies in thread, tracked threads, status reactions/messages)
 * defaults to on so deployments match typical pi-mom-custom-style setups without extra exports.
 * Set each var to false/0 to disable, or set MOM_SLACK_LEGACY_THREAD_UX=1 to restore the old
 * upstream defaults for all four flags at once (unless you override a var explicitly).
 */

export interface MomRuntimeConfig {
	llmProvider: string;
	llmModelId: string;
	slackReplyInUserThread: boolean;
	trackThreads: boolean;
	slackStatusReactions: boolean;
	slackStatusThreadMessage: boolean;
	voiceTranscription: boolean;
	slackPostToolStartLabel: boolean;
	slackPostToolResultToThread: boolean;
	slackPostToolErrorToChannel: boolean;
	slackPostThinkingToSlack: boolean;
	slackMirrorAssistantToThread: boolean;
	slackPostUsageSummaryToThread: boolean;
	slackDedupeMessages: boolean;
	slackPostCompactionNotice: boolean;
	slackPostRetryNotice: boolean;
	/** If false: read tool omits file body in Slack; other tools truncate long results */
	slackFullToolThreadDump: boolean;
	/** 0 = unlimited parallel conversations per Slack channel */
	maxConversationsPerChannel: number;
	/**
	 * After each Slack-triggered run, enqueue up to this many synthetic “continue” user
	 * messages so the agent keeps going when the model stops early (text-only, no tools).
	 * 0 = disabled (default).
	 */
	maxAutoContinueRounds: number;
}

let cached: MomRuntimeConfig | null = null;

function parseBool(v: string | undefined, defaultVal: boolean): boolean {
	if (v === undefined || v === "") return defaultVal;
	const s = v.toLowerCase();
	return s === "1" || s === "true" || s === "yes";
}

function parseNonNegInt(v: string | undefined, defaultVal: number): number {
	if (v === undefined || v === "") return defaultVal;
	const n = parseInt(v, 10);
	return Number.isFinite(n) && n >= 0 ? n : defaultVal;
}

export function buildMomConfig(): MomRuntimeConfig {
	const quiet = parseBool(process.env.MOM_SLACK_QUIET, false);
	const legacyThreadUx = parseBool(process.env.MOM_SLACK_LEGACY_THREAD_UX, false);
	const threadUxDefault = !legacyThreadUx;
	return {
		llmProvider: process.env.MOM_LLM_PROVIDER?.trim() || "anthropic",
		llmModelId: process.env.MOM_LLM_MODEL?.trim() || "claude-sonnet-4-6",
		slackReplyInUserThread: parseBool(process.env.MOM_SLACK_REPLY_IN_USER_THREAD, threadUxDefault),
		trackThreads: parseBool(process.env.MOM_TRACK_THREADS, threadUxDefault),
		slackStatusReactions: parseBool(process.env.MOM_SLACK_STATUS_REACTIONS, threadUxDefault),
		slackStatusThreadMessage: parseBool(process.env.MOM_SLACK_STATUS_THREAD_MESSAGE, threadUxDefault),
		voiceTranscription: parseBool(process.env.MOM_VOICE_TRANSCRIPTION, false),
		slackPostToolStartLabel: quiet ? false : parseBool(process.env.MOM_SLACK_POST_TOOL_LABELS, true),
		slackPostToolResultToThread: quiet ? false : parseBool(process.env.MOM_SLACK_POST_TOOL_RESULTS, true),
		slackPostToolErrorToChannel: parseBool(process.env.MOM_SLACK_POST_TOOL_ERRORS_TO_CHANNEL, true),
		slackPostThinkingToSlack: quiet ? false : parseBool(process.env.MOM_SLACK_POST_THINKING, true),
		slackMirrorAssistantToThread: quiet ? false : parseBool(process.env.MOM_SLACK_MIRROR_ASSISTANT_TO_THREAD, true),
		slackPostUsageSummaryToThread: quiet ? false : parseBool(process.env.MOM_SLACK_POST_USAGE_SUMMARY, true),
		slackDedupeMessages: quiet ? true : parseBool(process.env.MOM_SLACK_DEDUPE_MESSAGES, false),
		slackPostCompactionNotice: quiet ? false : parseBool(process.env.MOM_SLACK_POST_COMPACTION_NOTICE, true),
		slackPostRetryNotice: quiet ? false : parseBool(process.env.MOM_SLACK_POST_RETRY_NOTICE, true),
		slackFullToolThreadDump: parseBool(process.env.MOM_SLACK_FULL_TOOL_RESULTS, false),
		maxConversationsPerChannel: parseNonNegInt(process.env.MOM_MAX_CONVERSATIONS, 0),
		maxAutoContinueRounds: parseNonNegInt(process.env.MOM_MAX_AUTO_CONTINUE, 0),
	};
}

/** Call once at process startup (bot mode). Idempotent. */
export function initMomConfig(): MomRuntimeConfig {
	cached = buildMomConfig();
	return cached;
}

export function getMomConfig(): MomRuntimeConfig {
	if (!cached) {
		cached = buildMomConfig();
	}
	return cached;
}
