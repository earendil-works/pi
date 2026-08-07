import { Agent } from "@mupt-ai/pi-agent-core";
import { createModels } from "@mupt-ai/pi-ai";
import { anthropicProvider } from "@mupt-ai/pi-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Anthropic smoke-test model not found");

export const agent = new Agent({
	initialState: { model },
	streamFn: models.streamSimple.bind(models),
});
