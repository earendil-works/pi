import { GoogleGenAI } from "@google/genai";
import { calculateCost } from "../models.js";
import { AssistantMessageEventStream } from "../utils/event-stream.js";
import { sanitizeSurrogates } from "../utils/sanitize-unicode.js";
import { convertMessages, convertTools, mapStopReason, mapToolChoice } from "./google-shared.js";
const RETRY_CONFIG = {
    maxRetries: 3,
    baseDelayMs: 500,
    maxDelayMs: 8000,
    jitterRatio: 0.2,
};
function asRecord(v) {
    return typeof v === "object" && v !== null ? v : null;
}
function getProp(obj, key) {
    const rec = asRecord(obj);
    return rec ? rec[key] : undefined;
}
function getNested(obj, path) {
    let cur = obj;
    for (const key of path)
        cur = getProp(cur, key);
    return cur;
}
function toNumber(v) {
    if (typeof v === "number")
        return v;
    if (typeof v === "string" && v.trim()) {
        const parsed = Number(v);
        if (!Number.isNaN(parsed))
            return parsed;
    }
    return undefined;
}
function toStringSafe(v) {
    return typeof v === "string" ? v : undefined;
}
function collectErrorChain(err, maxDepth = 4) {
    const chain = [];
    let cur = err;
    for (let i = 0; i < maxDepth && cur; i++) {
        chain.push(cur);
        cur = getProp(cur, "cause");
    }
    return chain;
}
function extractRetryAfterMs(errs) {
    for (const e of errs) {
        const response = getProp(e, "response");
        const headers = getProp(response, "headers");
        if (!headers)
            continue;
        // handle fetch Headers-like or plain object
        const getFn = getProp(headers, "get");
        let raw = null;
        if (typeof getFn === "function") {
            raw = getFn.call(headers, "retry-after");
        }
        else {
            raw = toStringSafe(getProp(headers, "retry-after")) ?? toStringSafe(getProp(headers, "Retry-After")) ?? null;
        }
        if (raw) {
            const seconds = Number(raw);
            if (Number.isFinite(seconds))
                return seconds * 1000;
            const date = Date.parse(raw);
            if (!Number.isNaN(date))
                return Math.max(0, date - Date.now());
        }
    }
    return undefined;
}
function getRetryDecision(error) {
    const errs = collectErrorChain(error);
    const messages = errs
        .map((e) => (e instanceof Error ? e.message : (toStringSafe(getProp(e, "message")) ?? String(e))))
        .join(" | ");
    const names = errs.map((e) => (e instanceof Error ? e.name : (toStringSafe(getProp(e, "name")) ?? ""))).join(" | ");
    if (/abort|cancel/i.test(messages) || /AbortError/i.test(names))
        return { shouldRetry: false };
    // collect numeric codes
    const numericCandidates = [
        ...errs.map((e) => toNumber(getProp(e, "status"))),
        ...errs.map((e) => toNumber(getProp(e, "code"))),
        ...errs.map((e) => toNumber(getNested(e, ["error", "code"]))),
        ...errs.map((e) => toNumber(getNested(e, ["error", "error", "code"]))),
    ].filter((n) => typeof n === "number" && Number.isFinite(n));
    // collect status strings
    const statusStrings = [
        ...errs.map((e) => toStringSafe(getProp(e, "status"))),
        ...errs.map((e) => toStringSafe(getProp(e, "statusText"))),
        ...errs.map((e) => toStringSafe(getNested(e, ["error", "status"]))),
        ...errs.map((e) => toStringSafe(getNested(e, ["error", "error", "status"]))),
    ]
        .filter((s) => typeof s === "string" && s.length > 0)
        .map((s) => s.toUpperCase());
    const code = numericCandidates[0];
    const retryAfterMs = extractRetryAfterMs(errs);
    const isRateLimit = code === 429 ||
        statusStrings.includes("RESOURCE_EXHAUSTED") ||
        /\b(429)\b/.test(messages) ||
        /RESOURCE_EXHAUSTED/i.test(messages);
    const isTransientHttp = code === 500 || code === 502 || code === 503 || code === 504;
    const isTransientStatus = statusStrings.includes("INTERNAL") ||
        statusStrings.includes("UNAVAILABLE") ||
        statusStrings.includes("DEADLINE_EXCEEDED") ||
        /INTERNAL|UNAVAILABLE|DEADLINE_EXCEEDED/i.test(messages);
    const isNetworkish = /ECONNRESET|ETIMEDOUT|EAI_AGAIN|fetch failed|network error/i.test(messages);
    return {
        shouldRetry: isRateLimit || isTransientHttp || isTransientStatus || isNetworkish,
        retryAfterMs,
    };
}
async function sleepWithAbort(ms, signal) {
    if (signal?.aborted)
        throw new Error("Aborted");
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
            signal?.removeEventListener("abort", onAbort);
            resolve(undefined);
        }, ms);
        const onAbort = () => {
            clearTimeout(timer);
            reject(new Error("Aborted"));
        };
        signal?.addEventListener("abort", onAbort, { once: true });
    });
}
// Counter for generating unique tool call IDs
let toolCallCounter = 0;
export const streamGoogle = (model, context, options) => {
    const stream = new AssistantMessageEventStream();
    (async () => {
        const output = {
            role: "assistant",
            content: [],
            api: "google-generative-ai",
            provider: model.provider,
            model: model.id,
            usage: {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            },
            stopReason: "stop",
            timestamp: Date.now(),
        };
        let hasEmittedStart = false;
        let attempt = 0;
        const ensureStarted = () => {
            if (!hasEmittedStart) {
                stream.push({ type: "start", partial: output });
                hasEmittedStart = true;
            }
        };
        while (attempt <= RETRY_CONFIG.maxRetries) {
            // Reset output for each attempt to avoid duplicate content/usage
            output.content = [];
            output.usage = {
                input: 0,
                output: 0,
                cacheRead: 0,
                cacheWrite: 0,
                totalTokens: 0,
                cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
            };
            try {
                const client = createClient(model, options?.apiKey);
                const params = buildParams(model, context, options);
                const googleStream = await client.models.generateContentStream(params);
                let currentBlock = null;
                const blocks = output.content;
                const blockIndex = () => blocks.length - 1;
                for await (const chunk of googleStream) {
                    const candidate = chunk.candidates?.[0];
                    if (candidate?.content?.parts) {
                        for (const part of candidate.content.parts) {
                            if (part.text !== undefined) {
                                ensureStarted();
                                const isThinking = part.thought === true;
                                if (!currentBlock ||
                                    (isThinking && currentBlock.type !== "thinking") ||
                                    (!isThinking && currentBlock.type !== "text")) {
                                    if (currentBlock) {
                                        if (currentBlock.type === "text") {
                                            stream.push({
                                                type: "text_end",
                                                contentIndex: blocks.length - 1,
                                                content: currentBlock.text,
                                                partial: output,
                                            });
                                        }
                                        else {
                                            stream.push({
                                                type: "thinking_end",
                                                contentIndex: blockIndex(),
                                                content: currentBlock.thinking,
                                                partial: output,
                                            });
                                        }
                                    }
                                    if (isThinking) {
                                        currentBlock = { type: "thinking", thinking: "", thinkingSignature: undefined };
                                        output.content.push(currentBlock);
                                        stream.push({ type: "thinking_start", contentIndex: blockIndex(), partial: output });
                                    }
                                    else {
                                        currentBlock = { type: "text", text: "" };
                                        output.content.push(currentBlock);
                                        stream.push({ type: "text_start", contentIndex: blockIndex(), partial: output });
                                    }
                                }
                                if (currentBlock.type === "thinking") {
                                    currentBlock.thinking += part.text;
                                    currentBlock.thinkingSignature = part.thoughtSignature;
                                    stream.push({
                                        type: "thinking_delta",
                                        contentIndex: blockIndex(),
                                        delta: part.text,
                                        partial: output,
                                    });
                                }
                                else {
                                    currentBlock.text += part.text;
                                    stream.push({
                                        type: "text_delta",
                                        contentIndex: blockIndex(),
                                        delta: part.text,
                                        partial: output,
                                    });
                                }
                            }
                            if (part.functionCall) {
                                ensureStarted();
                                if (currentBlock) {
                                    if (currentBlock.type === "text") {
                                        stream.push({
                                            type: "text_end",
                                            contentIndex: blockIndex(),
                                            content: currentBlock.text,
                                            partial: output,
                                        });
                                    }
                                    else {
                                        stream.push({
                                            type: "thinking_end",
                                            contentIndex: blockIndex(),
                                            content: currentBlock.thinking,
                                            partial: output,
                                        });
                                    }
                                    currentBlock = null;
                                }
                                // Generate unique ID if not provided or if it's a duplicate
                                const providedId = part.functionCall.id;
                                const needsNewId = !providedId || output.content.some((b) => b.type === "toolCall" && b.id === providedId);
                                const toolCallId = needsNewId
                                    ? `${part.functionCall.name}_${Date.now()}_${++toolCallCounter}`
                                    : providedId;
                                const toolCall = {
                                    type: "toolCall",
                                    id: toolCallId,
                                    name: part.functionCall.name || "",
                                    arguments: part.functionCall.args,
                                    ...(part.thoughtSignature && { thoughtSignature: part.thoughtSignature }),
                                };
                                output.content.push(toolCall);
                                stream.push({ type: "toolcall_start", contentIndex: blockIndex(), partial: output });
                                stream.push({
                                    type: "toolcall_delta",
                                    contentIndex: blockIndex(),
                                    delta: JSON.stringify(toolCall.arguments),
                                    partial: output,
                                });
                                stream.push({ type: "toolcall_end", contentIndex: blockIndex(), toolCall, partial: output });
                            }
                        }
                    }
                    if (candidate?.finishReason) {
                        output.stopReason = mapStopReason(candidate.finishReason);
                        if (output.content.some((b) => b.type === "toolCall")) {
                            output.stopReason = "toolUse";
                        }
                    }
                    if (chunk.usageMetadata) {
                        const input = chunk.usageMetadata.promptTokenCount || 0;
                        const outputTokens = (chunk.usageMetadata.candidatesTokenCount || 0) + (chunk.usageMetadata.thoughtsTokenCount || 0);
                        const cacheRead = chunk.usageMetadata.cachedContentTokenCount || 0;
                        output.usage = {
                            input,
                            output: outputTokens,
                            cacheRead,
                            cacheWrite: 0,
                            totalTokens: input + outputTokens + cacheRead,
                            cost: {
                                input: 0,
                                output: 0,
                                cacheRead: 0,
                                cacheWrite: 0,
                                total: 0,
                            },
                        };
                        calculateCost(model, output.usage);
                    }
                }
                if (currentBlock) {
                    if (currentBlock.type === "text") {
                        stream.push({
                            type: "text_end",
                            contentIndex: blockIndex(),
                            content: currentBlock.text,
                            partial: output,
                        });
                    }
                    else {
                        stream.push({
                            type: "thinking_end",
                            contentIndex: blockIndex(),
                            content: currentBlock.thinking,
                            partial: output,
                        });
                    }
                }
                if (options?.signal?.aborted) {
                    throw new Error("Request was aborted");
                }
                if (output.stopReason === "aborted" || output.stopReason === "error") {
                    throw new Error("An unknown error occurred");
                }
                ensureStarted();
                stream.push({ type: "done", reason: output.stopReason, message: output });
                stream.end();
                return;
            }
            catch (error) {
                const decision = getRetryDecision(error);
                const canRetry = decision.shouldRetry && !options?.signal?.aborted && attempt < RETRY_CONFIG.maxRetries;
                if (!canRetry) {
                    for (const block of output.content)
                        delete block.index;
                    output.stopReason = options?.signal?.aborted ? "aborted" : "error";
                    output.errorMessage = error instanceof Error ? error.message : JSON.stringify(error);
                    ensureStarted();
                    stream.push({ type: "error", reason: output.stopReason, error: output });
                    stream.end();
                    return;
                }
                attempt++;
                const backoff = decision.retryAfterMs ??
                    Math.min(RETRY_CONFIG.maxDelayMs, RETRY_CONFIG.baseDelayMs * 2 ** (attempt - 1));
                const jitter = backoff * RETRY_CONFIG.jitterRatio;
                const delay = backoff + (Math.random() * 2 - 1) * jitter;
                await sleepWithAbort(delay, options?.signal);
            }
        }
    })();
    return stream;
};
function createClient(model, apiKey) {
    if (!apiKey) {
        if (!process.env.GEMINI_API_KEY) {
            throw new Error("Gemini API key is required. Set GEMINI_API_KEY environment variable or pass it as an argument.");
        }
        apiKey = process.env.GEMINI_API_KEY;
    }
    return new GoogleGenAI({
        apiKey,
        httpOptions: model.headers ? { headers: model.headers } : undefined,
    });
}
function buildParams(model, context, options = {}) {
    const contents = convertMessages(model, context);
    const generationConfig = {};
    if (options.temperature !== undefined) {
        generationConfig.temperature = options.temperature;
    }
    if (options.maxTokens !== undefined) {
        generationConfig.maxOutputTokens = options.maxTokens;
    }
    const config = {
        ...(Object.keys(generationConfig).length > 0 && generationConfig),
        ...(context.systemPrompt && { systemInstruction: sanitizeSurrogates(context.systemPrompt) }),
        ...(context.tools && context.tools.length > 0 && { tools: convertTools(context.tools) }),
    };
    if (context.tools && context.tools.length > 0 && options.toolChoice) {
        config.toolConfig = {
            functionCallingConfig: {
                mode: mapToolChoice(options.toolChoice),
            },
        };
    }
    else {
        config.toolConfig = undefined;
    }
    if (options.thinking?.enabled && model.reasoning) {
        config.thinkingConfig = {
            includeThoughts: true,
            ...(options.thinking.budgetTokens !== undefined && { thinkingBudget: options.thinking.budgetTokens }),
        };
    }
    if (options.signal) {
        if (options.signal.aborted) {
            throw new Error("Request aborted");
        }
        config.abortSignal = options.signal;
    }
    const params = {
        model: model.id,
        contents,
        config,
    };
    return params;
}
//# sourceMappingURL=google.js.map