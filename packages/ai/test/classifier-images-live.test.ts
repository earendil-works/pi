/**
 * Live image classification through System One services. Each provider's block runs only when its
 * credentials are set. Each case sends a solid red and a solid blue PNG in separate requests, so a
 * service that drops the image cannot pass by chance.
 */
import { describe, expect, it } from "vitest";
import { createModels, type ModelsClassifierOptions } from "../src/models.ts";
import { cloudflareWorkersAIProvider } from "../src/providers/cloudflare-workers-ai.ts";
import { openrouterProvider } from "../src/providers/openrouter.ts";
import { typesafeProvider } from "../src/providers/typesafe.ts";
import type { ClassifierContext } from "../src/types.ts";
import { hasCloudflareWorkersAICredentials } from "./cloudflare-utils.ts";

// 512x512 solid PNGs from the TypeSafe SDK's live image tests.
const RED =
	"iVBORw0KGgoAAAANSUhEUgAAAgAAAAIAAQMAAADOtka5AAAABlBMVEX/AAAAAABBoxIDAAAANklEQVR42u3BAQEAAACCIP+vbkhAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8G4IAAAFjdVCkAAAAAElFTkSuQmCC";
const BLUE =
	"iVBORw0KGgoAAAANSUhEUgAAAgAAAAIAAQMAAADOtka5AAAABlBMVEUAAP8AAAB7Yr8+AAAANklEQVR42u3BAQEAAACCIP+vbkhAAQAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAB8G4IAAAFjdVCkAAAAAElFTkSuQmCC";

function colorContext(data: string): ClassifierContext {
	return {
		state: { task: "Name the color of the attached image" },
		images: [{ type: "image", data, mimeType: "image/png" }],
		questions: {
			color: {
				type: "choice",
				instructions: "What color is the attached image?",
				criteria: { red: "Red", blue: "Blue", green: "Green" },
			},
		},
	};
}

const models = createModels();
models.setProvider(typesafeProvider());
models.setProvider(cloudflareWorkersAIProvider());
models.setProvider(openrouterProvider());

async function expectColors(provider: string, id: string, options: ModelsClassifierOptions): Promise<void> {
	const model = models.getModelOfType("classifier", provider, id);
	if (!model) throw new Error(`missing ${provider}/${id}`);
	expect(model.input).toContain("image");
	for (const [data, color] of [
		[RED, "red"],
		[BLUE, "blue"],
	] as const) {
		const result = await models.classify(model, colorContext(data), options);
		expect(result.errorMessage).toBeUndefined();
		expect(result.answers.color).toMatchObject({ type: "choice", choice: color });
	}
}

describe.skipIf(!process.env.TYPESAFE_API_KEY)("TypeSafe image classification", () => {
	it("classifies images with jev-latest", async () => {
		await expectColors("typesafe", "jev-latest", { apiKey: process.env.TYPESAFE_API_KEY });
	}, 60_000);
});

describe.skipIf(!hasCloudflareWorkersAICredentials())("Cloudflare Workers AI image classification", () => {
	it.each([
		"@cf/cloudflare/clef",
		"@cf/cloudflare/clef-flash",
		"@cf/cloudflare/clef-omni",
		"typesafe/jev",
		"typesafe/jev-1.14.0",
	])(
		"classifies images with %s",
		async (id) => {
			await expectColors("cloudflare-workers-ai", id, {
				apiKey: process.env.CLOUDFLARE_API_KEY,
				env: { CLOUDFLARE_ACCOUNT_ID: process.env.CLOUDFLARE_ACCOUNT_ID! },
			});
		},
		60_000,
	);
});

describe.skipIf(!process.env.OPENROUTER_API_KEY)("OpenRouter image classification", () => {
	it.each(["typesafe/jev-1.14", "cloudflare/clef-flash"])(
		"classifies images with %s",
		async (id) => {
			await expectColors("openrouter", id, { apiKey: process.env.OPENROUTER_API_KEY });
		},
		60_000,
	);
});
