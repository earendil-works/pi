import { randomUUID } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

// ============================================================================
// Types
// ============================================================================

type MemoryAtomType =
  | "constraint"
  | "preference"
  | "workflow"
  | "knowledge"
  | "event"
  | "solution"
  | "insight";

/**
 * Subset of MemoryAtom fields that are extracted by the LLM.
 * The caller is responsible for setting created_at, updated_at, version,
 * archived, file_path, content_hash, access_count, and last_access.
 */
export interface ExtractedAtom {
  id?: string; // Optional - if not provided, caller should generate one
  type: MemoryAtomType;
  title: string;
  summary: string;
  content: string;
  tags: string[];
  importance: number;
  strength: number;
}

interface ExtractionPlanItem {
  action: "create" | "update" | "skip";
  type?: MemoryAtomType;
  title?: string;
  summary?: string;
  tags?: string[];
  importance?: number;
  id?: string;
  changes?: Partial<Pick<ExtractedAtom, "title" | "summary" | "tags" | "importance" | "content">>;
}

interface ExtractionPlan {
  plan: ExtractionPlanItem[];
}

// ============================================================================
// Models.json Types
// ============================================================================

interface ModelDefinition {
  id: string;
  name?: string;
  api?: string;
  baseUrl?: string;
  reasoning?: boolean;
  input?: ("text" | "image")[];
  cost?: { input: number; output: number; cacheRead: number; cacheWrite: number };
  contextWindow?: number;
  maxTokens?: number;
  headers?: Record<string, string>;
  compat?: Record<string, unknown>;
}

interface ProviderConfig {
  name?: string;
  baseUrl?: string;
  apiKey?: string;
  api?: string;
  headers?: Record<string, string>;
  authHeader?: boolean;
  models?: ModelDefinition[];
  modelOverrides?: Record<string, Record<string, unknown>>;
}

interface ModelsJsonConfig {
  providers: Record<string, ProviderConfig>;
}

// ============================================================================
// LLMClient
// ============================================================================

/**
 * LLM client for extracting memory atoms from session content.
 * Reads configuration from ~/.pi/agent/models.json to find the default model.
 */
export class LLMClient {
  private modelsJsonPath: string;
  private provider: string | null = null;
  private modelId: string | null = null;
  private baseUrl: string | null = null;
  private apiKey: string | null = null;
  private headers: Record<string, string> = {};
  private apiType: string = "openai-completions";

  constructor(
    modelsJsonPath: string = join(homedir(), ".pi", "agent", "models.json"),
  ) {
    this.modelsJsonPath = modelsJsonPath;
  }

  /**
   * Initialize the client by reading models.json and finding the default model.
   */
  init(): void {
    if (!existsSync(this.modelsJsonPath)) {
      throw new Error(`models.json not found at: ${this.modelsJsonPath}`);
    }

    const content = readFileSync(this.modelsJsonPath, "utf-8");
    const config = JSON.parse(content) as ModelsJsonConfig;

    // Find the first provider with at least one model
    for (const [providerName, providerConfig] of Object.entries(config.providers)) {
      if (providerConfig.models && providerConfig.models.length > 0) {
        this.provider = providerName;
        const model = providerConfig.models[0];
        this.modelId = model.id;
        this.baseUrl = model.baseUrl ?? providerConfig.baseUrl ?? "";
        this.apiKey = providerConfig.apiKey ?? null;
        this.apiType = model.api ?? providerConfig.api ?? "openai-completions";

        // Merge headers
        this.headers = { ...providerConfig.headers, ...model.headers };

        // Add auth header if needed
        if (providerConfig.apiKey && providerConfig.authHeader !== false) {
          this.headers["Authorization"] = `Bearer ${providerConfig.apiKey}`;
        }

        return;
      }
    }

    throw new Error("No models found in models.json");
  }

  /**
   * Extract memory atoms from session messages.
   * @param sessionMessages The formatted session messages to analyze
   * @returns Promise<ExtractedAtom[]> Array of extracted atoms
   * @throws Error if the API call fails twice (after timeout/500 retry)
   */
  async extractAtoms(sessionMessages: string): Promise<ExtractedAtom[]> {
    if (!this.provider || !this.modelId || !this.baseUrl) {
      throw new Error("LLMClient not initialized. Call init() first.");
    }

    const extractPrompt = this.buildExtractionPrompt(sessionMessages);
    const result = await this.callLlmWithRetry(extractPrompt);
    return this.parseExtractionResponse(result);
  }

  /**
   * Build the extraction prompt (same as memory.ts line 1131).
   */
  private buildExtractionPrompt(sessionMessages: string): string {
    return `You are a memory extraction assistant. Analyze the following conversation and identify important information that should be saved as memory atoms.

Memory atom types:
- constraint: Hard requirements or rules the user has set
- preference: User preferences and style choices
- workflow: Process and workflow patterns
- knowledge: Facts, knowledge, and information learned
- event: Important events or interactions
- solution: Solutions to problems that were found
- insight: Insights and observations

For each memory to create or update, provide:
- action: "create" (new atom), "update" (modify existing), or "skip" (not worth saving)
- type: the atom type (required for create)
- title: short descriptive title (required for create)
- summary: one-sentence summary
- tags: array of relevant tags
- importance: 0.0 to 1.0 (how critical is this to remember)
- id: existing atom ID (required for update)
- changes: object with fields to update (required for update)

Conversation:
${sessionMessages.slice(0, 8000)}

Respond with ONLY valid JSON:
{"plan": [{"action": "create"|"update"|"skip", ...}]}

Only create atoms for genuinely important information. Skip routine conversation.`;
  }

  /**
   * Call the LLM API with timeout and retry logic.
   * 5s timeout, 1 retry after 2s on failure.
   */
  private async callLlmWithRetry(prompt: string): Promise<string> {
    const maxTokens = 2048;
    const timeoutMs = 5000;
    const retryDelayMs = 2000;

    // First attempt
    try {
      return await this.callLlm(prompt, maxTokens, timeoutMs);
    } catch (error) {
      // Retry once after 2s
      await this.sleep(retryDelayMs);
      try {
        return await this.callLlm(prompt, maxTokens, timeoutMs);
      } catch (retryError) {
        throw new Error(`LLM extraction failed after retry: ${retryError instanceof Error ? retryError.message : String(retryError)}`);
      }
    }
  }

  /**
   * Make a single LLM API call.
   */
  private async callLlm(prompt: string, maxTokens: number, timeoutMs: number): Promise<string> {
    const url = this.buildChatCompletionsUrl();

    const body = this.buildChatCompletionsBody(prompt, maxTokens);

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: this.buildRequestHeaders(),
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      clearTimeout(timeoutId);

      if (!response.ok) {
        throw new Error(`API returned ${response.status}: ${response.statusText}`);
      }

      const data = await response.json() as Record<string, unknown>;
      return this.extractTextFromResponse(data);
    } catch (error) {
      clearTimeout(timeoutId);
      if (error instanceof Error && error.name === "AbortError") {
        throw new Error("LLM API call timed out");
      }
      throw error;
    }
  }

  /**
   * Build the chat completions URL based on API type.
   */
  private buildChatCompletionsUrl(): string {
    const base = this.baseUrl!.replace(/\/$/, "");

    if (this.apiType === "anthropic-messages") {
      return `${base}/messages`;
    }

    // Default to OpenAI-compatible chat completions
    return `${base}/chat/completions`;
  }

  /**
   * Build the request body based on API type.
   */
  private buildChatCompletionsBody(prompt: string, maxTokens: number): Record<string, unknown> {
    const messages = [{ role: "user", content: prompt }];

    if (this.apiType === "anthropic-messages") {
      return {
        model: this.modelId,
        messages,
        max_tokens: maxTokens,
      };
    }

    // Default to OpenAI-compatible format
    return {
      model: this.modelId,
      messages,
      max_tokens: maxTokens,
    };
  }

  /**
   * Build request headers.
   */
  private buildRequestHeaders(): Record<string, string> {
    const headers: Record<string, string> = {
      "Content-Type": "application/json",
      ...this.headers,
    };

    // Add API key header for Anthropic
    if (this.apiType === "anthropic-messages" && this.apiKey) {
      headers["x-api-key"] = this.apiKey;
    }

    // Remove Authorization header if we have an API key for Anthropic
    // (Anthropic uses x-api-key instead)
    if (this.apiType === "anthropic-messages" && this.apiKey) {
      delete headers["Authorization"];
    }

    return headers;
  }

  /**
   * Extract text content from API response.
   */
  private extractTextFromResponse(data: Record<string, unknown>): string {
    // OpenAI-compatible format
    if ("choices" in data && Array.isArray(data.choices)) {
      const choices = data.choices as Array<{ message?: { content?: string | null } }>;
      if (choices.length > 0 && choices[0]?.message?.content) {
        return choices[0].message.content;
      }
    }

    // Anthropic format
    if ("content" in data && Array.isArray(data.content)) {
      const content = data.content as Array<{ type?: string; text?: string }>;
      const textParts = content
        .filter((c) => c.type === "text" && typeof c.text === "string")
        .map((c) => c.text as string);
      return textParts.join("");
    }

    throw new Error("Could not extract text from API response");
  }

  /**
   * Parse the LLM response into ExtractedAtom[].
   */
  private parseExtractionResponse(text: string): ExtractedAtom[] {
    // Extract JSON from the response
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      throw new Error("No JSON found in LLM response");
    }

    const plan: ExtractionPlan = JSON.parse(jsonMatch[0]);
    if (!Array.isArray(plan.plan)) {
      throw new Error("Invalid extraction plan format");
    }

    const atoms: ExtractedAtom[] = [];

    for (const item of plan.plan) {
      if (item.action === "skip") continue;

      if (item.action === "create" && item.type && item.title) {
        atoms.push({
          id: randomUUID(),
          type: item.type,
          title: item.title,
          summary: item.summary ?? item.title,
          content: item.changes?.content ?? "",
          tags: Array.isArray(item.tags) ? item.tags : [],
          importance: item.importance ?? 0.5,
          strength: 1.0,
        });
      }

      // Note: update actions would be handled by the caller using item.id and item.changes
    }

    return atoms;
  }

  private sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
}
