#!/usr/bin/env bash
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

# Check for --no-env flag
NO_ENV=false
ARGS=()
for arg in "$@"; do
  if [[ "$arg" == "--no-env" ]]; then
    NO_ENV=true
  else
    ARGS+=("$arg")
  fi
done

if [[ "$NO_ENV" == "true" ]]; then
  # Unset API keys (see packages/ai/src/env-api-keys.ts)
  unset ANTHROPIC_API_KEY
  unset ANTHROPIC_OAUTH_TOKEN
  unset OPENAI_API_KEY
  unset GEMINI_API_KEY
  unset GROQ_API_KEY
  unset CEREBRAS_API_KEY
  unset XAI_API_KEY
  unset OPENROUTER_API_KEY
  unset ZAI_API_KEY
  unset MISTRAL_API_KEY
  unset MINIMAX_API_KEY
  unset MINIMAX_CN_API_KEY
  unset AI_GATEWAY_API_KEY
  unset OPENCODE_API_KEY
  unset COPILOT_GITHUB_TOKEN
  unset GH_TOKEN
  unset GITHUB_TOKEN
  unset HF_TOKEN
  unset GOOGLE_APPLICATION_CREDENTIALS
  unset GOOGLE_CLOUD_PROJECT
  unset GCLOUD_PROJECT
  unset GOOGLE_CLOUD_LOCATION
  unset AWS_PROFILE
  unset AWS_ACCESS_KEY_ID
  unset AWS_SECRET_ACCESS_KEY
  unset AWS_SESSION_TOKEN
  unset AWS_REGION
  unset AWS_DEFAULT_REGION
  unset AWS_BEARER_TOKEN_BEDROCK
  unset AWS_CONTAINER_CREDENTIALS_RELATIVE_URI
  unset AWS_CONTAINER_CREDENTIALS_FULL_URI
  unset AWS_WEB_IDENTITY_TOKEN_FILE
  unset AZURE_OPENAI_API_KEY
  unset AZURE_OPENAI_BASE_URL
  unset AZURE_OPENAI_RESOURCE_NAME
  unset ANTHROPIC_AUTH_TOKEN
  unset ANTHROPIC_FEDERATION_RULE_ID
  unset ANTHROPIC_IDENTITY_TOKEN_FILE
  unset ANTHROPIC_ORGANIZATION_ID
  unset ANTHROPIC_SERVICE_ACCOUNT_ID
  unset ANTHROPIC_WORKSPACE_ID
  unset ANT_LING_API_KEY
  unset BASETEN_API_KEY
  unset CLOUDFLARE_API_KEY
  unset DEEPSEEK_API_KEY
  unset FIREWORKS_API_KEY
  unset GOOGLE_CLOUD_API_KEY
  unset KIMI_API_KEY
  unset META_API_KEY
  unset MOONSHOT_API_KEY
  unset NVIDIA_API_KEY
  unset QWEN_TOKEN_PLAN_API_KEY
  unset QWEN_TOKEN_PLAN_CN_API_KEY
  unset RADIUS_API_KEY
  unset TOGETHER_API_KEY
  unset TYPESAFE_API_KEY
  unset XIAOMI_API_KEY
  unset XIAOMI_TOKEN_PLAN_CN_API_KEY
  unset XIAOMI_TOKEN_PLAN_AMS_API_KEY
  unset XIAOMI_TOKEN_PLAN_SGP_API_KEY
  unset ZAI_CODING_CN_API_KEY
  echo "Running without API keys..."
fi

# --import takes a module specifier, so pass the resolver as a file URL (raw paths break on #, ?, %).
RESOLVER_URL="$(node -p 'require("node:url").pathToFileURL(process.argv[1]).href' "$SCRIPT_DIR/packages/coding-agent/src/experimental/source-resolver.ts")"
node --import "$RESOLVER_URL" "$SCRIPT_DIR/packages/coding-agent/src/cli.ts" ${ARGS[@]+"${ARGS[@]}"}
