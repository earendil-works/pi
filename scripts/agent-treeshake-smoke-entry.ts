import { Agent } from "@tculpepp/spi-agent-core";
import { createModels } from "@tculpepp/spi-ai";
import { anthropicProvider } from "@tculpepp/spi-ai/providers/anthropic";

const models = createModels();
models.setProvider(anthropicProvider());
const model = models.getModel("anthropic", "claude-sonnet-4-5");
if (!model) throw new Error("Anthropic smoke-test model not found");

export const agent = new Agent({
	initialState: { model },
	streamFn: models.streamSimple.bind(models),
});
