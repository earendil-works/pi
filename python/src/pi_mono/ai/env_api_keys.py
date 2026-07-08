import os

from pi_mono.ai.types import ProviderEnv
from pi_mono.ai.utils.provider_env import get_provider_env_value

_cached_vertex_adc_credentials_exists: bool | None = None


def has_vertex_adc_credentials(env: ProviderEnv | None = None) -> bool:
    global _cached_vertex_adc_credentials_exists
    if _cached_vertex_adc_credentials_exists is None or env is not None:
        gac_path = get_provider_env_value("GOOGLE_APPLICATION_CREDENTIALS", env)
        if gac_path:
            exists = os.path.exists(gac_path)
            if env is None:
                _cached_vertex_adc_credentials_exists = exists
            return exists
        home = os.path.expanduser("~")
        adc_path = os.path.join(home, ".config", "gcloud", "application_default_credentials.json")
        exists = os.path.exists(adc_path)
        if env is None:
            _cached_vertex_adc_credentials_exists = exists
        return exists
    return _cached_vertex_adc_credentials_exists


def get_api_key_env_vars(provider: str) -> list[str] | None:
    if provider == "github-copilot":
        return ["COPILOT_GITHUB_TOKEN"]

    if provider == "anthropic":
        return ["ANTHROPIC_OAUTH_TOKEN", "ANTHROPIC_API_KEY"]

    env_map = {
        "ant-ling": "ANT_LING_API_KEY",
        "openai": "OPENAI_API_KEY",
        "azure-openai-responses": "AZURE_OPENAI_API_KEY",
        "nvidia": "NVIDIA_API_KEY",
        "deepseek": "DEEPSEEK_API_KEY",
        "google": "GEMINI_API_KEY",
        "google-vertex": "GOOGLE_CLOUD_API_KEY",
        "groq": "GROQ_API_KEY",
        "cerebras": "CEREBRAS_API_KEY",
        "xai": "XAI_API_KEY",
        "openrouter": "OPENROUTER_API_KEY",
        "vercel-ai-gateway": "AI_GATEWAY_API_KEY",
        "zai": "ZAI_API_KEY",
        "zai-coding-cn": "ZAI_CODING_CN_API_KEY",
        "mistral": "MISTRAL_API_KEY",
        "minimax": "MINIMAX_API_KEY",
        "minimax-cn": "MINIMAX_CN_API_KEY",
        "moonshotai": "MOONSHOT_API_KEY",
        "moonshotai-cn": "MOONSHOT_API_KEY",
        "huggingface": "HF_TOKEN",
        "fireworks": "FIREWORKS_API_KEY",
        "together": "TOGETHER_API_KEY",
        "opencode": "OPENCODE_API_KEY",
        "opencode-go": "OPENCODE_API_KEY",
        "kimi-coding": "KIMI_API_KEY",
        "cloudflare-workers-ai": "CLOUDFLARE_API_KEY",
        "cloudflare-ai-gateway": "CLOUDFLARE_API_KEY",
        "xiaomi": "XIAOMI_API_KEY",
        "xiaomi-token-plan-cn": "XIAOMI_TOKEN_PLAN_CN_API_KEY",
        "xiaomi-token-plan-ams": "XIAOMI_TOKEN_PLAN_AMS_API_KEY",
        "xiaomi-token-plan-sgp": "XIAOMI_TOKEN_PLAN_SGP_API_KEY",
        "cursor": "CURSOR_API_KEY",
    }

    env_var = env_map.get(provider)
    return [env_var] if env_var else None


def find_env_keys(provider: str, env: ProviderEnv | None = None) -> list[str] | None:
    env_vars = get_api_key_env_vars(provider)
    if not env_vars:
        return None

    found = [var for var in env_vars if get_provider_env_value(var, env) is not None]
    return found if found else None


def get_env_api_key(provider: str, env: ProviderEnv | None = None) -> str | None:
    env_keys = find_env_keys(provider, env)
    if env_keys:
        return get_provider_env_value(env_keys[0], env)

    if provider == "google-vertex":
        has_credentials = has_vertex_adc_credentials(env)
        has_project = any(
            get_provider_env_value(var, env) is not None
            for var in ["GOOGLE_CLOUD_PROJECT", "GCLOUD_PROJECT"]
        )
        has_location = get_provider_env_value("GOOGLE_CLOUD_LOCATION", env) is not None

        if has_credentials and has_project and has_location:
            return "<authenticated>"

    if provider == "amazon-bedrock":
        aws_vars = [
            "AWS_PROFILE",
            "AWS_ACCESS_KEY_ID",
            "AWS_SECRET_ACCESS_KEY",
            "AWS_BEARER_TOKEN_BEDROCK",
            "AWS_CONTAINER_CREDENTIALS_RELATIVE_URI",
            "AWS_CONTAINER_CREDENTIALS_FULL_URI",
            "AWS_WEB_IDENTITY_TOKEN_FILE",
        ]
        has_access_keys = (
            get_provider_env_value("AWS_ACCESS_KEY_ID", env) is not None
            and get_provider_env_value("AWS_SECRET_ACCESS_KEY", env) is not None
        )
        has_other_aws_vars = any(
            get_provider_env_value(var, env) is not None
            for var in aws_vars
            if var not in ["AWS_ACCESS_KEY_ID", "AWS_SECRET_ACCESS_KEY"]
        )
        if has_access_keys or has_other_aws_vars:
            return "<authenticated>"

    return None
