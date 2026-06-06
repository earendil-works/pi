#!/usr/bin/env bash
set -e

AUTH_FILE="$HOME/.pi/agent/auth.json"
AUTH_BACKUP="$HOME/.pi/agent/auth.json.bak"

# Restore auth.json on exit (success or failure)
cleanup() {
    if [[ -f "$AUTH_BACKUP" ]]; then
        mv "$AUTH_BACKUP" "$AUTH_FILE"
        echo "Restored auth.json"
    fi
}
trap cleanup EXIT

# Move auth.json out of the way
if [[ -f "$AUTH_FILE" ]]; then
    mv "$AUTH_FILE" "$AUTH_BACKUP"
    echo "Moved auth.json to backup"
fi

# Skip local LLM tests (ollama, lmstudio)
export PI_NO_LOCAL_LLM=1

# Unset API keys (see packages/ai/src/stream.ts getEnvApiKey)
unset ANTHROPIC_API_KEY
unset ANTHROPIC_OAUTH_TOKEN
unset OPENAI_API_KEY
unset AZURE_OPENAI_API_KEY
unset DEEPSEEK_API_KEY
unset GEMINI_API_KEY
unset GOOGLE_CLOUD_API_KEY
unset GROQ_API_KEY
unset CEREBRAS_API_KEY
unset XAI_API_KEY
unset OPENROUTER_API_KEY
unset ZAI_API_KEY
unset ZAI_CODING_CN_API_KEY
unset MISTRAL_API_KEY
unset MINIMAX_API_KEY
unset MINIMAX_CN_API_KEY
unset MOONSHOT_API_KEY
unset KIMI_API_KEY
unset HF_TOKEN
unset FIREWORKS_API_KEY
unset TOGETHER_API_KEY
unset AI_GATEWAY_API_KEY
unset OPENCODE_API_KEY
unset CLOUDFLARE_API_KEY
unset CLOUDFLARE_ACCOUNT_ID
unset CLOUDFLARE_GATEWAY_ID
unset XIAOMI_API_KEY
unset XIAOMI_TOKEN_PLAN_CN_API_KEY
unset XIAOMI_TOKEN_PLAN_AMS_API_KEY
unset XIAOMI_TOKEN_PLAN_SGP_API_KEY
unset COPILOT_GITHUB_TOKEN
unset GH_TOKEN
unset GITHUB_TOKEN
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
unset BEDROCK_EXTENSIVE_MODEL_TEST

echo "Running tests without API keys..."
npm test
