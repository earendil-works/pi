export interface BedrockProviderModule {
	streamBedrock: (...args: unknown[]) => AsyncIterable<never>;
	streamSimpleBedrock: (...args: unknown[]) => AsyncIterable<never>;
}

export declare const bedrockProviderModule: BedrockProviderModule;
