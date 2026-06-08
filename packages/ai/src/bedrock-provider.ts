import {
	stream as streamBedrockMantleOpenAIResponses,
	streamSimple as streamSimpleBedrockMantleOpenAIResponses,
} from "./api/amazon-bedrock-mantle-openai-responses.ts";
import { stream as streamBedrock, streamSimple as streamSimpleBedrock } from "./api/bedrock-converse-stream.ts";

export const bedrockProviderModule = {
	stream: streamBedrock,
	streamSimple: streamSimpleBedrock,
};

export const bedrockMantleOpenAIResponsesProviderModule = {
	stream: streamBedrockMantleOpenAIResponses,
	streamSimple: streamSimpleBedrockMantleOpenAIResponses,
};
