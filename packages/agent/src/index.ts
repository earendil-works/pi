// Core Agent

export { uuidv7 } from "@earendil-works/pi-ai";
export type {
	AttributeValue,
	ExactTelemetryAttributes,
	InferEventAttributes,
	InferOptionalAttributes,
	InferRequiredAndOptionalAttributes,
	InferStartAttributes,
	RecordedTelemetryEvent,
	RecordedTelemetrySpan,
	SchemaTelemetrySpan,
	SpanAttributes,
	SpanAttributes as TelemetrySpanAttributes,
	SpanOptions,
	SpanStatus,
	TelemetryAttributeDefinition,
	TelemetryAttributeMetadata,
	TelemetryAttributeType,
	TelemetryContext,
	TelemetryEventAttributeDefinition,
	TelemetryEventDefinition,
	TelemetryParentDefinition,
	TelemetrySchemaDefinition,
	TelemetrySchemaSpanEndAttributes,
	TelemetrySchemaSpanEventAttributes,
	TelemetrySchemaSpanEventName,
	TelemetrySchemaSpanName,
	TelemetrySchemaSpanStartAttributes,
	TelemetrySchemaSpanUnion,
	TelemetrySpan,
	TelemetrySpanDefinition,
	TelemetryStartAttributeDefinition,
	TypedSpanStarter,
} from "@earendil-works/pi-telemetry";
export {
	createTypedSpanStarter,
	defineTelemetrySchema,
	InMemoryTelemetryContext,
	NOOP_TELEMETRY_CONTEXT,
} from "@earendil-works/pi-telemetry";
export * from "./agent.ts";
// Loop functions
export * from "./agent-loop.ts";
export * from "./harness/agent-harness.ts";
export {
	type BranchPreparation,
	type BranchSummaryDetails,
	type BranchSummaryResult,
	type CollectEntriesResult,
	collectEntriesForBranchSummary,
	type FileOperations,
	type GenerateBranchSummaryOptions,
	generateBranchSummary,
	prepareBranchEntries,
} from "./harness/compaction/branch-summarization.ts";
export {
	type CompactionPreparation,
	type CompactionSettings,
	type CompactResult,
	calculateContextTokens,
	compact,
	DEFAULT_COMPACTION_SETTINGS,
	estimateContextTokens,
	estimateTokens,
	findCutPoint,
	findTurnStartIndex,
	generateSummary,
	generateSummaryWithUsage,
	getLastAssistantUsage,
	prepareCompaction,
	serializeConversation,
	shouldCompact,
} from "./harness/compaction/compaction.ts";
export * from "./harness/messages.ts";
export * from "./harness/prompt-templates.ts";
// Harness
export * from "./harness/result.ts";
export * from "./harness/session/index.ts";
export * from "./harness/session/search.ts";
export * from "./harness/skills.ts";
export * from "./harness/system-prompt.ts";
export type {
	AiSpan,
	AiSpanAttributes,
	AiSpanEndAttributes,
	AiSpanEventAttributes,
	AiSpanEventName,
	AiSpanName,
	AiSpanStartAttributes,
	AiTelemetrySpan,
	HarnessSpan,
	HarnessSpanAttributes,
	HarnessSpanEndAttributes,
	HarnessSpanEventAttributes,
	HarnessSpanEventName,
	HarnessSpanName,
	HarnessSpanStartAttributes,
	HarnessTelemetrySpan,
} from "./harness/telemetry.ts";
export {
	AGENT_TELEMETRY_SCHEMAS,
	AI_TELEMETRY_SCHEMA,
	HARNESS_TELEMETRY_SCHEMA,
	startAiSpan,
	startHarnessSpan,
} from "./harness/telemetry.ts";
export * from "./harness/tools/index.ts";
export {
	type AgentHarnessResources,
	type AgentHarnessStreamOptions,
	type AgentHarnessStreamOptionsPatch,
	type AgentHarnessTool,
	type AgentHarnessToolContextSource,
	BranchSummaryError,
	type BranchSummaryErrorCode,
	CompactionError,
	type CompactionErrorCode,
	type ExecutionEnv,
	ExecutionError,
	type ExecutionErrorCode,
	err,
	FileError,
	type FileErrorCode,
	type FileInfo,
	type FileKind,
	type FileSystem,
	getOrThrow,
	getOrUndefined,
	ok,
	type PromptTemplate,
	type Shell,
	type ShellExecOptions,
	type Skill,
	toError,
} from "./harness/types.ts";
export * from "./harness/utils/shell-output.ts";
export * from "./harness/utils/truncate.ts";
// Proxy utilities
export * from "./proxy.ts";
// Stream defaults
export { setDefaultStreamFn } from "./stream-fn.ts";
// Types
export * from "./types.ts";
