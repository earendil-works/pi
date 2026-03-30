import { afterAll, beforeEach } from "vitest";
import { type OAuthStorage, setOAuthStorage } from "../../ai/src/utils/oauth/index.js";
import { invalidateOAuthCache } from "../src/model-config.js";

process.env.MU_TEST_DISABLE_NOTIFICATIONS = "1";
process.env.MU_RUN_LIVE_TESTS ??= "0";

const originalAnthropicOAuthToken = process.env.ANTHROPIC_OAUTH_TOKEN;

let oauthStorage: OAuthStorage = {};

setOAuthStorage({
	load: () => oauthStorage,
	save: (storage) => {
		oauthStorage = storage;
	},
});

beforeEach(() => {
	oauthStorage = {};
	delete process.env.ANTHROPIC_OAUTH_TOKEN;
	invalidateOAuthCache();
});

afterAll(() => {
	if (originalAnthropicOAuthToken === undefined) {
		delete process.env.ANTHROPIC_OAUTH_TOKEN;
	} else {
		process.env.ANTHROPIC_OAUTH_TOKEN = originalAnthropicOAuthToken;
	}
	invalidateOAuthCache();
});
