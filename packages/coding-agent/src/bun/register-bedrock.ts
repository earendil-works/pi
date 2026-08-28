import {
	bedrockMantleOpenAIResponsesProviderModule,
	bedrockProviderModule,
} from "@earendil-works/pi-ai/bedrock-provider";
import { setBedrockMantleOpenAIResponsesProviderModule, setBedrockProviderModule } from "@earendil-works/pi-ai/compat";

setBedrockProviderModule(bedrockProviderModule);
setBedrockMantleOpenAIResponsesProviderModule(bedrockMantleOpenAIResponsesProviderModule);
