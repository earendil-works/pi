// Scratch script showing real-world use of the new Models API.
// Run from packages/ai: node test/scratch.ts
// Requires ANTHROPIC_API_KEY.

import { createModels } from "../src/models.ts";
import { anthropicProvider } from "../src/providers/anthropic.ts";
import type { Context } from "../src/types.ts";

// ---------------------------------------------------------------------------
// 1. Build a Models runtime and register a built-in provider factory.
//    (Apps wanting everything use `builtinModels()` from providers/all.)
// ---------------------------------------------------------------------------

const models = createModels();
models.setProvider(anthropicProvider());

// ---------------------------------------------------------------------------
// 2. Look up a model and check auth.
// ---------------------------------------------------------------------------

const model = models.getModel("anthropic", "claude-haiku-4-5");
if (!model) throw new Error("model not found");

const auth = await models.getAuth(model);
console.log(`model: ${model.provider}/${model.id}`);
console.log(`auth:  ${auth ? `configured via ${auth.source}` : "not configured"}\n`);
if (!auth) process.exit(1);

const context: Context = {
	systemPrompt: "You are terse.",
	messages: [{ role: "user", content: "Say exactly: ok", timestamp: Date.now() }],
};

// ---------------------------------------------------------------------------
// 3. Simple completion (request-level auth resolution happens inside).
// ---------------------------------------------------------------------------

const message = await models.completeSimple(model, context);
console.log(`completeSimple -> [${message.stopReason}]`, message.content);

// ---------------------------------------------------------------------------
// 4. Streaming with deltas.
// ---------------------------------------------------------------------------

context.messages.push(message, {
	role: "user",
	content: "Now count from 1 to 5, one number per line.",
	timestamp: Date.now(),
});

process.stdout.write("streamSimple   -> ");
const stream = models.streamSimple(model, context);
for await (const event of stream) {
	if (event.type === "text_delta") process.stdout.write(event.delta.replaceAll("\n", " "));
}
const final = await stream.result();
console.log(`[${final.stopReason}] cost: $${final.usage.cost.total.toFixed(6)}`);
