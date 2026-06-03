import { register, streamBedrock, streamSimpleBedrock } from "./providers/amazon-bedrock.ts";

export { register };

export const bedrockProviderModule = {
	streamBedrock,
	streamSimpleBedrock,
};
