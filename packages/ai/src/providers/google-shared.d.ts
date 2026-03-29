/**
 * Shared utilities for Google Generative AI and Google Gemini CLI providers.
 */
import { type Content, FinishReason, FunctionCallingConfigMode, type Schema } from "@google/genai";
import type { Context, Model, StopReason, Tool } from "../types.js";
type GoogleApiType = "google-generative-ai" | "google-gemini-cli";
/**
 * Convert internal messages to Gemini Content[] format.
 */
export declare function convertMessages<T extends GoogleApiType>(model: Model<T>, context: Context): Content[];
/**
 * Convert tools to Gemini function declarations format.
 */
export declare function convertTools(tools: Tool[]): {
    functionDeclarations: {
        name: string;
        description?: string;
        parameters: Schema;
    }[];
}[] | undefined;
/**
 * Map tool choice string to Gemini FunctionCallingConfigMode.
 */
export declare function mapToolChoice(choice: string): FunctionCallingConfigMode;
/**
 * Map Gemini FinishReason to our StopReason.
 */
export declare function mapStopReason(reason: FinishReason): StopReason;
/**
 * Map string finish reason to our StopReason (for raw API responses).
 */
export declare function mapStopReasonString(reason: string): StopReason;
export {};
//# sourceMappingURL=google-shared.d.ts.map