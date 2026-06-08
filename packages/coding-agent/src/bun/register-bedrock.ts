import {
	bedrockMantleOpenAIResponsesProviderModule,
	bedrockProviderModule,
} from "@earendil-works/pi-ai/bedrock-provider";
import {
	setAmazonBedrockMantleOpenAIResponsesProviderModule,
	setBedrockProviderModule,
} from "@earendil-works/pi-ai/compat";

setBedrockProviderModule(bedrockProviderModule);
setAmazonBedrockMantleOpenAIResponsesProviderModule(bedrockMantleOpenAIResponsesProviderModule);
