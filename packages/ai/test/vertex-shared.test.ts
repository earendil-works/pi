import { describe, expect, it } from "vitest";

describe("vertex shared config", () => {
	it("resolves google vertex project and location from standard env vars", async () => {
		const { resolveGoogleVertexProject, resolveGoogleVertexLocation } = await import("../src/vertex-shared.ts");
		const env = {
			GOOGLE_CLOUD_PROJECT: "gcp-project",
			GOOGLE_CLOUD_LOCATION: "us-central1",
		};

		expect(resolveGoogleVertexProject(undefined, env)).toBe("gcp-project");
		expect(resolveGoogleVertexLocation(undefined, env)).toBe("us-central1");
	});

	it("resolves anthropic vertex project and location with anthropic env vars taking precedence", async () => {
		const { resolveAnthropicVertexProject, resolveAnthropicVertexLocation } = await import("../src/vertex-shared.ts");
		const env = {
			ANTHROPIC_VERTEX_PROJECT_ID: "anthropic-project",
			GOOGLE_CLOUD_PROJECT: "gcp-project",
			GCLOUD_PROJECT: "legacy-project",
			CLOUD_ML_REGION: "global",
			GOOGLE_CLOUD_LOCATION: "us-central1",
		};

		expect(resolveAnthropicVertexProject(undefined, env)).toBe("anthropic-project");
		expect(resolveAnthropicVertexLocation(undefined, env)).toBe("global");
	});

	it("falls back to standard google vars when anthropic-specific vars are absent", async () => {
		const { resolveAnthropicVertexProject, resolveAnthropicVertexLocation } = await import("../src/vertex-shared.ts");
		const env = {
			GOOGLE_CLOUD_PROJECT: "gcp-project",
			GOOGLE_CLOUD_LOCATION: "europe-west1",
		};

		expect(resolveAnthropicVertexProject(undefined, env)).toBe("gcp-project");
		expect(resolveAnthropicVertexLocation(undefined, env)).toBe("europe-west1");
	});

	it("lets explicit options override env vars", async () => {
		const {
			resolveAnthropicVertexProject,
			resolveAnthropicVertexLocation,
			resolveGoogleVertexProject,
			resolveGoogleVertexLocation,
		} = await import("../src/vertex-shared.ts");
		const env = {
			ANTHROPIC_VERTEX_PROJECT_ID: "anthropic-project",
			CLOUD_ML_REGION: "global",
			GOOGLE_CLOUD_PROJECT: "gcp-project",
			GOOGLE_CLOUD_LOCATION: "us-central1",
		};

		expect(resolveAnthropicVertexProject({ project: "explicit-anthropic" }, env)).toBe("explicit-anthropic");
		expect(resolveAnthropicVertexLocation({ location: "europe-west1" }, env)).toBe("europe-west1");
		expect(resolveGoogleVertexProject({ project: "explicit-google" }, env)).toBe("explicit-google");
		expect(resolveGoogleVertexLocation({ location: "asia-southeast1" }, env)).toBe("asia-southeast1");
	});
});
