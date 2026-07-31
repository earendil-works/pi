/**
 * Backward-compatible exports for the built-in final_answer assistant block parser.
 */

export {
	type AssistantBlockDefinition,
	DEFAULT_ASSISTANT_BLOCKS,
	FINAL_ANSWER_BLOCK_NAME,
	parseAssistantBlockMarkers,
	parseFinalAnswerMarkers,
} from "./assistant-block-stream.ts";
