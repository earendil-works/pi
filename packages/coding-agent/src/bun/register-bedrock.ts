import {
	bedrockMantleAnthropicMessagesProviderModule,
	bedrockMantleOpenAIResponsesProviderModule,
	bedrockProviderModule,
} from "@earendil-works/pi-ai/bedrock-provider";
import {
	setBedrockMantleAnthropicMessagesProviderModule,
	setBedrockMantleOpenAIResponsesProviderModule,
	setBedrockProviderModule,
} from "@earendil-works/pi-ai/compat";

setBedrockProviderModule(bedrockProviderModule);
setBedrockMantleOpenAIResponsesProviderModule(bedrockMantleOpenAIResponsesProviderModule);
setBedrockMantleAnthropicMessagesProviderModule(bedrockMantleAnthropicMessagesProviderModule);
