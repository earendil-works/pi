use std::sync::Arc;

use crate::{BedrockProvider, HttpProvider, InputKind, Model, ModelCost, Models, Provider};

struct ProviderSpec {
    id: &'static str,
    name: &'static str,
    api: &'static str,
    base_url: &'static str,
    env: &'static [&'static str],
    models: &'static [(&'static str, bool)],
}

const SPECS: &[ProviderSpec] = &[
    ProviderSpec {
        id: "anthropic",
        name: "Anthropic",
        api: "anthropic-messages",
        base_url: "https://api.anthropic.com/v1",
        env: &["ANTHROPIC_API_KEY", "ANTHROPIC_OAUTH_TOKEN"],
        models: &[
            ("claude-sonnet-4-6", true),
            ("claude-opus-4-6", true),
            ("claude-haiku-4-5", true),
        ],
    },
    ProviderSpec {
        id: "openai",
        name: "OpenAI",
        api: "openai-responses",
        base_url: "https://api.openai.com/v1",
        env: &["OPENAI_API_KEY"],
        models: &[
            ("gpt-5.4", true),
            ("gpt-5-mini", true),
            ("gpt-4o", false),
            ("gpt-4o-mini", false),
        ],
    },
    ProviderSpec {
        id: "openai-codex",
        name: "OpenAI Codex",
        api: "openai-codex-responses",
        base_url: "https://chatgpt.com/backend-api/codex",
        env: &[],
        models: &[("gpt-5.4-codex", true), ("gpt-5.3-codex", true)],
    },
    ProviderSpec {
        id: "azure-openai-responses",
        name: "Azure OpenAI",
        api: "azure-openai-responses",
        base_url: "https://example.openai.azure.com/openai/v1",
        env: &["AZURE_OPENAI_API_KEY"],
        models: &[("gpt-5.4", true), ("gpt-4o", false)],
    },
    ProviderSpec {
        id: "google",
        name: "Google Gemini",
        api: "google-generative-ai",
        base_url: "https://generativelanguage.googleapis.com/v1beta",
        env: &["GEMINI_API_KEY"],
        models: &[
            ("gemini-3.1-pro-preview", true),
            ("gemini-3-flash-preview", true),
            ("gemini-2.5-flash", true),
        ],
    },
    ProviderSpec {
        id: "google-vertex",
        name: "Google Vertex AI",
        api: "google-vertex",
        base_url: "https://aiplatform.googleapis.com/v1",
        env: &["GOOGLE_CLOUD_API_KEY"],
        models: &[("gemini-3.1-pro-preview", true), ("gemini-2.5-flash", true)],
    },
    ProviderSpec {
        id: "amazon-bedrock",
        name: "Amazon Bedrock",
        api: "bedrock-converse-stream",
        base_url: "https://bedrock-runtime.us-east-1.amazonaws.com",
        env: &["AWS_BEARER_TOKEN_BEDROCK"],
        models: &[("global.anthropic.claude-sonnet-4-6-v1", true)],
    },
    ProviderSpec {
        id: "mistral",
        name: "Mistral",
        api: "mistral-conversations",
        base_url: "https://api.mistral.ai/v1",
        env: &["MISTRAL_API_KEY"],
        models: &[("mistral-large-latest", true), ("codestral-latest", false)],
    },
    ProviderSpec {
        id: "deepseek",
        name: "DeepSeek",
        api: "openai-completions",
        base_url: "https://api.deepseek.com/v1",
        env: &["DEEPSEEK_API_KEY"],
        models: &[("deepseek-chat", false), ("deepseek-reasoner", true)],
    },
    ProviderSpec {
        id: "nvidia",
        name: "NVIDIA NIM",
        api: "openai-completions",
        base_url: "https://integrate.api.nvidia.com/v1",
        env: &["NVIDIA_API_KEY"],
        models: &[("moonshotai/kimi-k2.5", true)],
    },
    ProviderSpec {
        id: "xai",
        name: "xAI",
        api: "openai-completions",
        base_url: "https://api.x.ai/v1",
        env: &["XAI_API_KEY"],
        models: &[("grok-4.1-fast", true), ("grok-code-fast-1", true)],
    },
    ProviderSpec {
        id: "groq",
        name: "Groq",
        api: "openai-completions",
        base_url: "https://api.groq.com/openai/v1",
        env: &["GROQ_API_KEY"],
        models: &[("openai/gpt-oss-120b", true)],
    },
    ProviderSpec {
        id: "cerebras",
        name: "Cerebras",
        api: "openai-completions",
        base_url: "https://api.cerebras.ai/v1",
        env: &["CEREBRAS_API_KEY"],
        models: &[("gpt-oss-120b", true)],
    },
    ProviderSpec {
        id: "openrouter",
        name: "OpenRouter",
        api: "openai-completions",
        base_url: "https://openrouter.ai/api/v1",
        env: &["OPENROUTER_API_KEY"],
        models: &[("openrouter/auto", true), ("anthropic/claude-sonnet-4.6", true)],
    },
    ProviderSpec {
        id: "vercel-ai-gateway",
        name: "Vercel AI Gateway",
        api: "openai-completions",
        base_url: "https://ai-gateway.vercel.sh/v1",
        env: &["AI_GATEWAY_API_KEY"],
        models: &[("anthropic/claude-sonnet-4.6", true)],
    },
    ProviderSpec {
        id: "together",
        name: "Together AI",
        api: "openai-completions",
        base_url: "https://api.together.xyz/v1",
        env: &["TOGETHER_API_KEY"],
        models: &[("deepseek-ai/DeepSeek-V3.1", true)],
    },
    ProviderSpec {
        id: "fireworks",
        name: "Fireworks",
        api: "openai-completions",
        base_url: "https://api.fireworks.ai/inference/v1",
        env: &["FIREWORKS_API_KEY"],
        models: &[("accounts/fireworks/models/kimi-k2p5", true)],
    },
    ProviderSpec {
        id: "baseten",
        name: "Baseten",
        api: "openai-completions",
        base_url: "https://inference.baseten.co/v1",
        env: &["BASETEN_API_KEY"],
        models: &[("deepseek-ai/DeepSeek-V3.1", true)],
    },
    ProviderSpec {
        id: "huggingface",
        name: "Hugging Face",
        api: "openai-completions",
        base_url: "https://router.huggingface.co/v1",
        env: &["HF_TOKEN"],
        models: &[("deepseek-ai/DeepSeek-V3.1", true)],
    },
    ProviderSpec {
        id: "zai",
        name: "ZAI Coding Plan",
        api: "openai-completions",
        base_url: "https://api.z.ai/api/coding/paas/v4",
        env: &["ZAI_API_KEY"],
        models: &[("glm-5", true), ("glm-4.7", true)],
    },
    ProviderSpec {
        id: "zai-coding-cn",
        name: "ZAI Coding Plan China",
        api: "openai-completions",
        base_url: "https://open.bigmodel.cn/api/coding/paas/v4",
        env: &["ZAI_CODING_CN_API_KEY"],
        models: &[("glm-5", true)],
    },
    ProviderSpec {
        id: "minimax",
        name: "MiniMax",
        api: "openai-completions",
        base_url: "https://api.minimax.io/v1",
        env: &["MINIMAX_API_KEY"],
        models: &[("MiniMax-M2.5", true)],
    },
    ProviderSpec {
        id: "minimax-cn",
        name: "MiniMax China",
        api: "openai-completions",
        base_url: "https://api.minimaxi.com/v1",
        env: &["MINIMAX_CN_API_KEY"],
        models: &[("MiniMax-M2.5", true)],
    },
    ProviderSpec {
        id: "moonshotai",
        name: "Moonshot AI",
        api: "openai-completions",
        base_url: "https://api.moonshot.ai/v1",
        env: &["MOONSHOT_API_KEY"],
        models: &[("kimi-k2.5", true)],
    },
    ProviderSpec {
        id: "moonshotai-cn",
        name: "Moonshot AI China",
        api: "openai-completions",
        base_url: "https://api.moonshot.cn/v1",
        env: &["MOONSHOT_API_KEY"],
        models: &[("kimi-k2.5", true)],
    },
    ProviderSpec {
        id: "kimi-coding",
        name: "Kimi For Coding",
        api: "anthropic-messages",
        base_url: "https://api.kimi.com/coding/v1",
        env: &["KIMI_API_KEY"],
        models: &[("kimi-for-coding", true)],
    },
    ProviderSpec {
        id: "opencode",
        name: "OpenCode Zen",
        api: "openai-completions",
        base_url: "https://opencode.ai/zen/v1",
        env: &["OPENCODE_API_KEY"],
        models: &[("claude-sonnet-4-6", true)],
    },
    ProviderSpec {
        id: "opencode-go",
        name: "OpenCode Go",
        api: "openai-completions",
        base_url: "https://opencode.ai/go/v1",
        env: &["OPENCODE_API_KEY"],
        models: &[("minimax-m2.5", true)],
    },
    ProviderSpec {
        id: "github-copilot",
        name: "GitHub Copilot",
        api: "openai-completions",
        base_url: "https://api.githubcopilot.com",
        env: &["COPILOT_GITHUB_TOKEN"],
        models: &[("gpt-5.4", true), ("claude-sonnet-4.6", true)],
    },
    ProviderSpec {
        id: "cloudflare-workers-ai",
        name: "Cloudflare Workers AI",
        api: "openai-completions",
        base_url: "https://api.cloudflare.com/client/v4/accounts/{account}/ai/v1",
        env: &["CLOUDFLARE_API_KEY"],
        models: &[("@cf/moonshotai/kimi-k2.5", true)],
    },
    ProviderSpec {
        id: "cloudflare-ai-gateway",
        name: "Cloudflare AI Gateway",
        api: "openai-completions",
        base_url: "https://gateway.ai.cloudflare.com/v1/{account}/{gateway}/compat",
        env: &["CLOUDFLARE_API_KEY"],
        models: &[("openai/gpt-5.4", true)],
    },
    ProviderSpec {
        id: "ant-ling",
        name: "Ant Ling",
        api: "openai-completions",
        base_url: "https://api.ling.ai/v1",
        env: &["ANT_LING_API_KEY"],
        models: &[("ling-2.0", true)],
    },
    ProviderSpec {
        id: "qwen-token-plan",
        name: "Qwen Token Plan",
        api: "openai-completions",
        base_url: "https://coding-intl.dashscope.aliyuncs.com/v1",
        env: &["QWEN_TOKEN_PLAN_API_KEY"],
        models: &[("qwen3-coder-plus", true)],
    },
    ProviderSpec {
        id: "qwen-token-plan-individual",
        name: "Qwen Token Plan Individual",
        api: "openai-completions",
        base_url: "https://coding-intl.dashscope.aliyuncs.com/v1",
        env: &["QWEN_TOKEN_PLAN_API_KEY"],
        models: &[("qwen3-coder-plus", true)],
    },
    ProviderSpec {
        id: "qwen-token-plan-cn",
        name: "Qwen Token Plan China",
        api: "openai-completions",
        base_url: "https://coding.dashscope.aliyuncs.com/v1",
        env: &["QWEN_TOKEN_PLAN_CN_API_KEY"],
        models: &[("qwen3-coder-plus", true)],
    },
    ProviderSpec {
        id: "xiaomi",
        name: "Xiaomi MiMo",
        api: "openai-completions",
        base_url: "https://api.xiaomimimo.com/v1",
        env: &["XIAOMI_API_KEY"],
        models: &[("mimo-v2-pro", true)],
    },
    ProviderSpec {
        id: "xiaomi-token-plan-cn",
        name: "Xiaomi MiMo Token Plan China",
        api: "openai-completions",
        base_url: "https://api.xiaomimimo.com/v1",
        env: &["XIAOMI_TOKEN_PLAN_CN_API_KEY"],
        models: &[("mimo-v2-pro", true)],
    },
    ProviderSpec {
        id: "xiaomi-token-plan-ams",
        name: "Xiaomi MiMo Token Plan Amsterdam",
        api: "openai-completions",
        base_url: "https://api.xiaomimimo.com/v1",
        env: &["XIAOMI_TOKEN_PLAN_AMS_API_KEY"],
        models: &[("mimo-v2-pro", true)],
    },
    ProviderSpec {
        id: "xiaomi-token-plan-sgp",
        name: "Xiaomi MiMo Token Plan Singapore",
        api: "openai-completions",
        base_url: "https://api.xiaomimimo.com/v1",
        env: &["XIAOMI_TOKEN_PLAN_SGP_API_KEY"],
        models: &[("mimo-v2-pro", true)],
    },
];

fn model(spec: &ProviderSpec, id: &str, reasoning: bool) -> Model {
    Model {
        id: id.to_owned(),
        name: id.to_owned(),
        api: spec.api.to_owned(),
        provider: spec.id.to_owned(),
        base_url: spec.base_url.to_owned(),
        reasoning,
        input: vec![InputKind::Text, InputKind::Image],
        cost: ModelCost::default(),
        context_window: 128_000,
        max_tokens: 32_000,
        headers: Default::default(),
        sampling_params: Default::default(),
        compat: Default::default(),
        thinking_level_map: Default::default(),
    }
}

#[must_use]
pub fn builtin_providers() -> Vec<Arc<dyn Provider>> {
    SPECS
        .iter()
        .map(|spec| {
            let models = spec
                .models
                .iter()
                .map(|(id, reasoning)| model(spec, id, *reasoning))
                .collect();
            if spec.id == "amazon-bedrock" {
                Arc::new(BedrockProvider::new(models)) as Arc<dyn Provider>
            } else {
                Arc::new(HttpProvider::new(spec.id, spec.name, models, spec.env.iter().copied())) as Arc<dyn Provider>
            }
        })
        .collect()
}

pub fn register_builtin_providers(models: &Models) {
    for provider in builtin_providers() {
        models.set_provider(provider);
    }
}
