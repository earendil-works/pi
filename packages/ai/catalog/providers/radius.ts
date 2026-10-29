import { defineProvider } from "../define.ts";

// The unauthenticated public catalog; authenticated clients overlay it at runtime.
export default defineProvider({
	id: "radius",
	models: (ctx) => structuredClone(ctx.sources.radius),
});
