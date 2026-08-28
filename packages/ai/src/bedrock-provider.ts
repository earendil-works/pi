import {
	stream as bedrockConverseStream,
	streamSimple as bedrockConverseStreamSimple,
} from "./api/bedrock-converse-stream.ts";
import {
	stream as bedrockMantleOpenAIResponsesStream,
	streamSimple as bedrockMantleOpenAIResponsesStreamSimple,
} from "./api/bedrock-mantle-openai-responses.ts";

export const bedrockProviderModule = {
	stream: bedrockConverseStream,
	streamSimple: bedrockConverseStreamSimple,
};

export const bedrockMantleOpenAIResponsesProviderModule = {
	stream: bedrockMantleOpenAIResponsesStream,
	streamSimple: bedrockMantleOpenAIResponsesStreamSimple,
};
