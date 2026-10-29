import { defineProvider } from "../define.ts";
import { minimaxModels } from "./minimax.ts";

export default defineProvider({
	id: "minimax-cn",
	models: (ctx) => minimaxModels(ctx, "minimax-cn", "https://api.minimaxi.com/anthropic"),
});
