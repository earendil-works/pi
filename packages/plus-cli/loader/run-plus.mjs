// Entry point for running pi from sources with the pi-plus override layer active
// (packages/plus-cli wrapping the shared core in packages/plus).
// Loaded as: node packages/plus-cli/loader/run-plus.mjs [pi args...]
//
// Uses Node's native TypeScript type stripping (the repo is erasableSyntaxOnly by design);
// tsx is intentionally NOT used — its load hook silently produces empty modules when a
// customization hook is registered alongside it. Resolution of workspace packages to
// sources is handled by the plus resolve hook (tsconfig paths + module redirects).
import "./register.mjs";

const repoRoot = new URL("../../../", import.meta.url).pathname;

// Mirror pi-test.sh's --no-env: drop provider credentials from the environment
// (list from packages/ai/src/env-api-keys.ts and pi-test.sh).
const NO_ENV_KEYS = [
	"ANTHROPIC_API_KEY",
	"ANTHROPIC_OAUTH_TOKEN",
	"OPENAI_API_KEY",
	"GEMINI_API_KEY",
	"GROQ_API_KEY",
	"CEREBRAS_API_KEY",
	"XAI_API_KEY",
	"OPENROUTER_API_KEY",
	"ZAI_API_KEY",
	"MISTRAL_API_KEY",
	"MINIMAX_API_KEY",
	"MINIMAX_CN_API_KEY",
	"AI_GATEWAY_API_KEY",
	"OPENCODE_API_KEY",
	"COPILOT_GITHUB_TOKEN",
	"GH_TOKEN",
	"GITHUB_TOKEN",
	"HF_TOKEN",
	"GOOGLE_APPLICATION_CREDENTIALS",
	"GOOGLE_CLOUD_PROJECT",
	"GCLOUD_PROJECT",
	"GOOGLE_CLOUD_LOCATION",
	"AWS_PROFILE",
	"AWS_ACCESS_KEY_ID",
	"AWS_SECRET_ACCESS_KEY",
	"AWS_SESSION_TOKEN",
	"AWS_REGION",
	"AWS_DEFAULT_REGION",
	"AWS_BEARER_TOKEN_BEDROCK",
	"AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
	"AWS_CONTAINER_CREDENTIALS_FULL_URI",
	"AWS_WEB_IDENTITY_TOKEN_FILE",
	"AZURE_OPENAI_API_KEY",
	"AZURE_OPENAI_BASE_URL",
	"AZURE_OPENAI_RESOURCE_NAME",
];

const argIndex = process.argv.indexOf("--no-env");
if (argIndex !== -1) {
	process.argv.splice(argIndex, 1);
	for (const key of NO_ENV_KEYS) {
		delete process.env[key];
	}
}

await import(`${repoRoot}packages/coding-agent/src/experimental/cli.ts`);
