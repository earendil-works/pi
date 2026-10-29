import { defineProvider } from "../define.ts";
import { finalizeOpencodeModel, OPENCODE_COMPLETIONS_COMPAT, opencodeModels } from "./opencode.ts";

export default defineProvider({
	id: "opencode-go",
	models: opencodeModels,
	compat: { "openai-completions": OPENCODE_COMPLETIONS_COMPAT },
	finalize: finalizeOpencodeModel,
});
