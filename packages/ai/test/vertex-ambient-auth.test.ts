import { afterEach, describe, expect, it, vi } from "vitest";

const originalAnthropicVertexProjectId = process.env.ANTHROPIC_VERTEX_PROJECT_ID;
const originalCloudMlRegion = process.env.CLOUD_ML_REGION;
const originalGcloudProject = process.env.GCLOUD_PROJECT;
const originalGoogleCloudProject = process.env.GOOGLE_CLOUD_PROJECT;
const originalGoogleCloudLocation = process.env.GOOGLE_CLOUD_LOCATION;
const originalGoogleCloudApiKey = process.env.GOOGLE_CLOUD_API_KEY;
const originalGoogleApplicationCredentials = process.env.GOOGLE_APPLICATION_CREDENTIALS;

async function loadEnvApiKeysModule(options?: { adcExists?: boolean }) {
	vi.resetModules();
	vi.doMock("node:fs", () => ({
		existsSync: vi.fn(() => options?.adcExists ?? false),
	}));
	vi.doMock("node:os", () => ({
		homedir: () => "/mock-home",
	}));
	vi.doMock("node:path", () => ({
		join: (...parts: string[]) => parts.join("/"),
	}));

	const module = await import("../src/env-api-keys.ts");
	await new Promise((resolve) => setTimeout(resolve, 0));
	return module;
}

afterEach(() => {
	if (originalAnthropicVertexProjectId === undefined) {
		delete process.env.ANTHROPIC_VERTEX_PROJECT_ID;
	} else {
		process.env.ANTHROPIC_VERTEX_PROJECT_ID = originalAnthropicVertexProjectId;
	}

	if (originalCloudMlRegion === undefined) {
		delete process.env.CLOUD_ML_REGION;
	} else {
		process.env.CLOUD_ML_REGION = originalCloudMlRegion;
	}

	if (originalGcloudProject === undefined) {
		delete process.env.GCLOUD_PROJECT;
	} else {
		process.env.GCLOUD_PROJECT = originalGcloudProject;
	}

	if (originalGoogleCloudProject === undefined) {
		delete process.env.GOOGLE_CLOUD_PROJECT;
	} else {
		process.env.GOOGLE_CLOUD_PROJECT = originalGoogleCloudProject;
	}

	if (originalGoogleCloudLocation === undefined) {
		delete process.env.GOOGLE_CLOUD_LOCATION;
	} else {
		process.env.GOOGLE_CLOUD_LOCATION = originalGoogleCloudLocation;
	}

	if (originalGoogleCloudApiKey === undefined) {
		delete process.env.GOOGLE_CLOUD_API_KEY;
	} else {
		process.env.GOOGLE_CLOUD_API_KEY = originalGoogleCloudApiKey;
	}

	if (originalGoogleApplicationCredentials === undefined) {
		delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
	} else {
		process.env.GOOGLE_APPLICATION_CREDENTIALS = originalGoogleApplicationCredentials;
	}

	vi.doUnmock("node:fs");
	vi.doUnmock("node:os");
	vi.doUnmock("node:path");
	vi.resetModules();
});

describe("vertex ambient auth", () => {
	it("treats native Anthropic Vertex vars plus ADC as anthropic-vertex ambient auth only", async () => {
		const { getEnvApiKey } = await loadEnvApiKeysModule({ adcExists: true });

		process.env.ANTHROPIC_VERTEX_PROJECT_ID = "vertex-project";
		process.env.CLOUD_ML_REGION = "global";
		delete process.env.GCLOUD_PROJECT;
		delete process.env.GOOGLE_CLOUD_PROJECT;
		delete process.env.GOOGLE_CLOUD_LOCATION;
		delete process.env.GOOGLE_CLOUD_API_KEY;

		expect(getEnvApiKey("anthropic-vertex")).toBe("<authenticated>");
		expect(getEnvApiKey("google-vertex")).toBeUndefined();
	});

	it("treats Google Vertex vars plus ADC as google-vertex ambient auth", async () => {
		const { getEnvApiKey } = await loadEnvApiKeysModule({ adcExists: true });

		process.env.GOOGLE_CLOUD_PROJECT = "vertex-project";
		process.env.GOOGLE_CLOUD_LOCATION = "us-central1";

		expect(getEnvApiKey("google-vertex")).toBe("<authenticated>");
	});
});
