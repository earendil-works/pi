import copy
import json
import os
import re
from typing import Any, List, Optional, cast

from pi_mono.ai.models import get_models, get_providers
from pi_mono.ai.api_registry import register_api_provider
from pi_mono.ai.providers.register_builtins import reset_api_providers
from pi_mono.ai.cursor_agent import (
    refresh_cursor_auth_cache,
    refresh_cursor_models_cache,
)
from pi_mono.ai.oauth import (
    register_oauth_provider,
    reset_oauth_providers,
    OAuthCredentials,
)
from pi_mono.ai.types import Model, Api, ModelCost
from pi_mono.config import get_agent_dir
from pi_mono.core.auth_storage import AuthStorage
from pi_mono.core.provider_display_names import BUILT_IN_PROVIDER_DISPLAY_NAMES
from pi_mono.core.resolve_config_value import (
    clear_config_value_cache,
    get_config_value_env_var_names,
    is_command_config_value,
    is_config_value_configured,
    resolve_config_value_or_throw,
    resolve_config_value_uncached,
    resolve_headers_or_throw,
)
from pi_mono.utils.paths import normalize_path
from pi_mono.utils.validation import validate_value

# ==============================================================================
# JSON Schemas for models.json validation
# ==============================================================================

PercentileCutoffsSchema = {
    "type": "object",
    "properties": {
        "p50": {"type": "number"},
        "p75": {"type": "number"},
        "p90": {"type": "number"},
        "p99": {"type": "number"},
    },
    "additionalProperties": False,
}

OpenRouterRoutingSchema = {
    "type": "object",
    "properties": {
        "allow_fallbacks": {"type": "boolean"},
        "require_parameters": {"type": "boolean"},
        "data_collection": {"type": "string", "enum": ["deny", "allow"]},
        "zdr": {"type": "boolean"},
        "enforce_distillable_text": {"type": "boolean"},
        "order": {"type": "array", "items": {"type": "string"}},
        "only": {"type": "array", "items": {"type": "string"}},
        "ignore": {"type": "array", "items": {"type": "string"}},
        "quantizations": {"type": "array", "items": {"type": "string"}},
        "sort": {
            "anyOf": [
                {"type": "string"},
                {
                    "type": "object",
                    "properties": {
                        "by": {"type": "string"},
                        "partition": {"anyOf": [{"type": "string"}, {"type": "null"}]},
                    },
                },
            ]
        },
        "max_price": {
            "type": "object",
            "properties": {
                "prompt": {"anyOf": [{"type": "number"}, {"type": "string"}]},
                "completion": {"anyOf": [{"type": "number"}, {"type": "string"}]},
                "image": {"anyOf": [{"type": "number"}, {"type": "string"}]},
                "audio": {"anyOf": [{"type": "number"}, {"type": "string"}]},
                "request": {"anyOf": [{"type": "number"}, {"type": "string"}]},
            },
        },
        "preferred_min_throughput": {"anyOf": [{"type": "number"}, PercentileCutoffsSchema]},
        "preferred_max_latency": {"anyOf": [{"type": "number"}, PercentileCutoffsSchema]},
    },
}

VercelGatewayRoutingSchema = {
    "type": "object",
    "properties": {
        "only": {"type": "array", "items": {"type": "string"}},
        "order": {"type": "array", "items": {"type": "string"}},
    },
}

ThinkingLevelMapValueSchema = {"anyOf": [{"type": "string"}, {"type": "null"}]}

ThinkingLevelMapSchema = {
    "type": "object",
    "properties": {
        "off": ThinkingLevelMapValueSchema,
        "minimal": ThinkingLevelMapValueSchema,
        "low": ThinkingLevelMapValueSchema,
        "medium": ThinkingLevelMapValueSchema,
        "high": ThinkingLevelMapValueSchema,
        "xhigh": ThinkingLevelMapValueSchema,
        "max": ThinkingLevelMapValueSchema,
    },
}

_ModelCostRatesProperties = {
    "input": {"type": "number"},
    "output": {"type": "number"},
    "cacheRead": {"type": "number"},
    "cacheWrite": {"type": "number"},
}

ModelCostTierSchema = {
    "type": "object",
    "required": ["inputTokensAbove", "input", "output", "cacheRead", "cacheWrite"],
    "properties": {
        "inputTokensAbove": {"type": "number"},
        **_ModelCostRatesProperties,
    },
}

ModelCostSchema = {
    "type": "object",
    "required": ["input", "output", "cacheRead", "cacheWrite"],
    "properties": {
        **_ModelCostRatesProperties,
        "tiers": {"type": "array", "items": ModelCostTierSchema},
    },
}

ModelCostOverrideSchema = {
    "type": "object",
    "properties": {
        **_ModelCostRatesProperties,
        "tiers": {"type": "array", "items": ModelCostTierSchema},
    },
}

OpenAICompletionsCompatSchema = {
    "type": "object",
    "properties": {
        "supportsStore": {"type": "boolean"},
        "supportsDeveloperRole": {"type": "boolean"},
        "supportsReasoningEffort": {"type": "boolean"},
        "supportsUsageInStreaming": {"type": "boolean"},
        "maxTokensField": {"type": "string", "enum": ["max_completion_tokens", "max_tokens"]},
        "requiresToolResultName": {"type": "boolean"},
        "requiresAssistantAfterToolResult": {"type": "boolean"},
        "requiresThinkingAsText": {"type": "boolean"},
        "requiresReasoningContentOnAssistantMessages": {"type": "boolean"},
        "thinkingFormat": {
            "type": "string",
            "enum": [
                "openai",
                "openrouter",
                "together",
                "deepseek",
                "zai",
                "qwen",
                "qwen-chat-template",
            ],
        },
        "cacheControlFormat": {"type": "string", "enum": ["anthropic"]},
        "openRouterRouting": OpenRouterRoutingSchema,
        "vercelGatewayRouting": VercelGatewayRoutingSchema,
        "supportsStrictMode": {"type": "boolean"},
        "supportsLongCacheRetention": {"type": "boolean"},
    },
}

OpenAIResponsesCompatSchema = {
    "type": "object",
    "properties": {
        "sendSessionIdHeader": {"type": "boolean"},
        "supportsLongCacheRetention": {"type": "boolean"},
    },
}

AnthropicMessagesCompatSchema = {
    "type": "object",
    "properties": {
        "supportsEagerToolInputStreaming": {"type": "boolean"},
        "supportsLongCacheRetention": {"type": "boolean"},
        "sendSessionAffinityHeaders": {"type": "boolean"},
        "supportsCacheControlOnTools": {"type": "boolean"},
        "forceAdaptiveThinking": {"type": "boolean"},
    },
}

ProviderCompatSchema = {
    "anyOf": [
        OpenAICompletionsCompatSchema,
        OpenAIResponsesCompatSchema,
        AnthropicMessagesCompatSchema,
    ]
}

ModelDefinitionSchema = {
    "type": "object",
    "required": ["id"],
    "properties": {
        "id": {"type": "string", "minLength": 1},
        "name": {"type": "string", "minLength": 1},
        "api": {"type": "string", "minLength": 1},
        "baseUrl": {"type": "string", "minLength": 1},
        "reasoning": {"type": "boolean"},
        "thinkingLevelMap": ThinkingLevelMapSchema,
        "input": {"type": "array", "items": {"type": "string", "enum": ["text", "image"]}},
        "cost": ModelCostSchema,
        "contextWindow": {"type": "number"},
        "maxTokens": {"type": "number"},
        "headers": {"type": "object", "additionalProperties": {"type": "string"}},
        "compat": ProviderCompatSchema,
    },
}

ModelOverrideSchema = {
    "type": "object",
    "properties": {
        "name": {"type": "string", "minLength": 1},
        "reasoning": {"type": "boolean"},
        "thinkingLevelMap": ThinkingLevelMapSchema,
        "input": {"type": "array", "items": {"type": "string", "enum": ["text", "image"]}},
        "cost": ModelCostOverrideSchema,
        "contextWindow": {"type": "number"},
        "maxTokens": {"type": "number"},
        "headers": {"type": "object", "additionalProperties": {"type": "string"}},
        "compat": ProviderCompatSchema,
    },
}

ProviderConfigSchema = {
    "type": "object",
    "properties": {
        "name": {"type": "string", "minLength": 1},
        "baseUrl": {"type": "string", "minLength": 1},
        "apiKey": {"type": "string", "minLength": 1},
        "api": {"type": "string", "minLength": 1},
        "headers": {"type": "object", "additionalProperties": {"type": "string"}},
        "compat": ProviderCompatSchema,
        "authHeader": {"type": "boolean"},
        "models": {"type": "array", "items": ModelDefinitionSchema},
        "modelOverrides": {"type": "object", "additionalProperties": ModelOverrideSchema},
    },
}

ModelsConfigSchema = {
    "type": "object",
    "required": ["providers"],
    "properties": {
        "providers": {"type": "object", "additionalProperties": ProviderConfigSchema},
    },
}


def strip_json_comments(input_str: str) -> str:
    """Strip // line comments and trailing commas from JSON, leaving string literals untouched."""
    # Pattern 1: match double-quoted strings OR // comments
    input_str = re.sub(
        r'"(?:\\.|[^"\\])*"|//[^\n]*',
        lambda m: m.group(0) if m.group(0).startswith('"') else "",
        input_str,
    )
    # Pattern 2: match double-quoted strings OR , followed by optional whitespace and } or ]
    input_str = re.sub(
        r'"(?:\\.|[^"\\])*"|,(\s*[}\]])',
        lambda m: (
            m.group(1)
            if m.group(1) is not None
            else (m.group(0) if m.group(0).startswith('"') else "")
        ),
        input_str,
    )
    return input_str


def migrate_legacy_register_provider_config_value(
    provider_name: str, field: str, value: str
) -> str:
    del provider_name, field
    return value


def migrate_legacy_register_provider_headers(
    provider_name: str,
    field: str,
    headers: Optional[dict[str, str]],
) -> Optional[dict[str, str]]:
    if not headers:
        return None
    migrated_headers = None
    for key, value in headers.items():
        migrated_value = migrate_legacy_register_provider_config_value(
            provider_name, f'{field} header "{key}"', value
        )
        if migrated_value == value:
            continue
        if migrated_headers is None:
            migrated_headers = {**headers}
        migrated_headers[key] = migrated_value
    return migrated_headers if migrated_headers is not None else headers


def migrate_legacy_register_provider_config_values(
    provider_name: str,
    config: dict[str, Any],
) -> dict[str, Any]:
    migrated_config = None

    def set_migrated_value(key: str, value: Any) -> None:
        nonlocal migrated_config
        if migrated_config is None:
            migrated_config = {**config}
        migrated_config[key] = value

    if config.get("apiKey"):
        api_key = migrate_legacy_register_provider_config_value(
            provider_name, "apiKey", config["apiKey"]
        )
        if api_key != config["apiKey"]:
            set_migrated_value("apiKey", api_key)

    headers = migrate_legacy_register_provider_headers(
        provider_name, "headers", config.get("headers")
    )
    if headers is not config.get("headers"):
        set_migrated_value("headers", headers)

    if config.get("models"):
        models = None
        for index, model in enumerate(config["models"]):
            model_headers = migrate_legacy_register_provider_headers(
                provider_name,
                f'model "{model.get("id")}" headers',
                model.get("headers"),
            )
            if model_headers is model.get("headers"):
                continue
            if models is None:
                models = list(config["models"])
            models[index] = {**model, "headers": model_headers}
        if models is not None:
            set_migrated_value("models", models)

    return migrated_config if migrated_config is not None else config


def merge_compat(
    base_compat: Optional[dict[str, Any]],
    override_compat: Optional[dict[str, Any]],
) -> Optional[dict[str, Any]]:
    if not override_compat:
        return base_compat
    if not base_compat:
        return override_compat

    merged = {**base_compat, **override_compat}

    if "openRouterRouting" in base_compat or "openRouterRouting" in override_compat:
        merged["openRouterRouting"] = {
            **base_compat.get("openRouterRouting", {}),
            **override_compat.get("openRouterRouting", {}),
        }

    if "vercelGatewayRouting" in base_compat or "vercelGatewayRouting" in override_compat:
        merged["vercelGatewayRouting"] = {
            **base_compat.get("vercelGatewayRouting", {}),
            **override_compat.get("vercelGatewayRouting", {}),
        }

    return merged


def apply_model_override(model: Model, override: dict[str, Any]) -> Model:
    result = copy.deepcopy(model)

    if override.get("name") is not None:
        result["name"] = override["name"]
    if override.get("reasoning") is not None:
        result["reasoning"] = override["reasoning"]
    if override.get("thinkingLevelMap") is not None:
        result["thinkingLevelMap"] = {
            **result.get("thinkingLevelMap", {}),
            **override["thinkingLevelMap"],
        }
    if override.get("input") is not None:
        result["input"] = override["input"]
    if override.get("contextWindow") is not None:
        result["contextWindow"] = override["contextWindow"]
    if override.get("maxTokens") is not None:
        result["maxTokens"] = override["maxTokens"]

    if override.get("cost") is not None:
        cost_override = override["cost"]
        model_cost = result.get(
            "cost", {"input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0}
        )
        merged_cost: dict[str, Any] = {
            "input": cost_override.get("input", model_cost.get("input", 0.0)),
            "output": cost_override.get("output", model_cost.get("output", 0.0)),
            "cacheRead": cost_override.get("cacheRead", model_cost.get("cacheRead", 0.0)),
            "cacheWrite": cost_override.get("cacheWrite", model_cost.get("cacheWrite", 0.0)),
        }
        tiers = cost_override.get("tiers", model_cost.get("tiers"))
        if tiers is not None:
            merged_cost["tiers"] = tiers
        result["cost"] = cast(ModelCost, merged_cost)

    if override.get("compat") is not None:
        result["compat"] = cast(
            dict[str, Any], merge_compat(result.get("compat"), override["compat"])
        )

    return result


clear_api_key_cache = clear_config_value_cache


class ModelRegistry:
    def __init__(self, auth_storage: AuthStorage, models_json_path: Optional[str]):
        self.models: list[Model] = []
        self.provider_request_configs: dict[str, dict[str, Any]] = {}
        self.model_request_headers: dict[str, dict[str, str]] = {}
        self.registered_providers: dict[str, dict[str, Any]] = {}
        self.load_error: Optional[str] = None
        self.auth_storage = auth_storage
        self.models_json_path = normalize_path(models_json_path) if models_json_path else None
        self.load_models()

    @classmethod
    def create(
        cls,
        auth_storage: AuthStorage,
        models_json_path: str = os.path.join(get_agent_dir(), "models.json"),
    ) -> "ModelRegistry":
        return cls(auth_storage, models_json_path)

    @classmethod
    def in_memory(cls, auth_storage: AuthStorage) -> "ModelRegistry":
        return cls(auth_storage, None)

    def refresh(self) -> None:
        self.provider_request_configs.clear()
        self.model_request_headers.clear()
        self.load_error = None

        reset_api_providers()
        reset_oauth_providers()
        refresh_cursor_models_cache()
        refresh_cursor_auth_cache()

        self.load_models()

        for provider_name, config in self.registered_providers.items():
            self.apply_provider_config(provider_name, config)

    def get_error(self) -> Optional[str]:
        return self.load_error

    def load_models(self) -> None:
        custom_models = []
        overrides = {}
        model_overrides = {}

        if self.models_json_path:
            res = self.load_custom_models(self.models_json_path)
            custom_models = res.get("models", [])
            overrides = res.get("overrides", {})
            model_overrides = res.get("model_overrides", {})
            error = res.get("error")
            if error:
                self.load_error = error

        built_in_models = self.load_built_in_models(overrides, model_overrides)
        combined = self.merge_custom_models(built_in_models, custom_models)

        for oauth_provider in self.auth_storage.get_oauth_providers():
            cred = self.auth_storage.get(oauth_provider.id)
            if cred and cred.get("type") == "oauth" and hasattr(oauth_provider, "modify_models"):
                combined = oauth_provider.modify_models(combined, cast(OAuthCredentials, cred))

        self.models = combined

    def load_built_in_models(
        self,
        overrides: dict[str, dict[str, Any]],
        model_overrides: dict[str, dict[str, Any]],
    ) -> list[Model]:
        built_in_models = []
        for provider in get_providers():
            models = get_models(provider)
            provider_override = overrides.get(provider)
            per_model_overrides = model_overrides.get(provider)

            for m in models:
                model = copy.deepcopy(m)

                if provider_override:
                    if provider_override.get("baseUrl") is not None:
                        model["baseUrl"] = provider_override["baseUrl"]
                    if provider_override.get("compat") is not None:
                        model["compat"] = cast(
                            dict[str, Any],
                            merge_compat(model.get("compat"), provider_override["compat"]),
                        )

                if per_model_overrides:
                    model_override = per_model_overrides.get(model["id"])
                    if model_override:
                        model = apply_model_override(model, model_override)

                built_in_models.append(model)
        return built_in_models

    def merge_custom_models(
        self, built_in_models: list[Model], custom_models: list[Model]
    ) -> list[Model]:
        merged = list(built_in_models)
        for custom_model in custom_models:
            existing_index = next(
                (
                    idx
                    for idx, m in enumerate(merged)
                    if m.get("provider") == custom_model.get("provider")
                    and m.get("id") == custom_model.get("id")
                ),
                -1,
            )
            if existing_index >= 0:
                merged[existing_index] = custom_model
            else:
                merged.append(custom_model)
        return merged

    def load_custom_models(self, models_json_path: str) -> dict[str, Any]:
        if not os.path.exists(models_json_path):
            return {"models": [], "overrides": {}, "model_overrides": {}, "error": None}

        try:
            with open(models_json_path, "r", encoding="utf-8") as f:
                content = f.read()
            parsed = json.loads(strip_json_comments(content))

            errors: list[tuple[str, str]] = []
            validate_value(parsed, ModelsConfigSchema, [], errors)

            if errors:
                error_lines = [f"  - {path}: {msg}" for path, msg in errors]
                error_lines_str = "\n".join(error_lines)
                return {
                    "models": [],
                    "overrides": {},
                    "model_overrides": {},
                    "error": f"Invalid models.json schema:\n{error_lines_str}\n\nFile: {models_json_path}",
                }

            config = cast(dict[str, Any], parsed)
            self.validate_config(config)

            overrides = {}
            model_overrides = {}

            for provider_name, provider_config in config.get("providers", {}).items():
                if provider_config.get("baseUrl") or provider_config.get("compat"):
                    overrides[provider_name] = {
                        "baseUrl": provider_config.get("baseUrl"),
                        "compat": provider_config.get("compat"),
                    }

                self.store_provider_request_config(provider_name, provider_config)

                m_overrides = provider_config.get("modelOverrides")
                if m_overrides:
                    model_overrides[provider_name] = m_overrides
                    for model_id, model_override in m_overrides.items():
                        self.store_model_headers(
                            provider_name, model_id, model_override.get("headers")
                        )

            return {
                "models": self.parse_models(config),
                "overrides": overrides,
                "model_overrides": model_overrides,
                "error": None,
            }
        except json.JSONDecodeError as error:
            return {
                "models": [],
                "overrides": {},
                "model_overrides": {},
                "error": f"Failed to parse models.json: {error.msg}\n\nFile: {models_json_path}",
            }
        except Exception as error:
            return {
                "models": [],
                "overrides": {},
                "model_overrides": {},
                "error": f"Failed to load models.json: {str(error)}\n\nFile: {models_json_path}",
            }

    def validate_config(self, config: dict[str, Any]) -> None:
        built_in_providers = set(get_providers())

        for provider_name, provider_config in config.get("providers", {}).items():
            is_built_in = provider_name in built_in_providers
            has_provider_api = bool(provider_config.get("api"))
            models = provider_config.get("models", [])
            has_model_overrides = bool(provider_config.get("modelOverrides"))

            if len(models) == 0:
                if (
                    not provider_config.get("baseUrl")
                    and not provider_config.get("headers")
                    and not provider_config.get("compat")
                    and not has_model_overrides
                ):
                    raise ValueError(
                        f'Provider {provider_name}: must specify "baseUrl", "headers", "compat", "modelOverrides", or "models".'
                    )
            elif not is_built_in:
                if not provider_config.get("baseUrl"):
                    raise ValueError(
                        f'Provider {provider_name}: "baseUrl" is required when defining custom models.'
                    )
                if not provider_config.get("apiKey"):
                    raise ValueError(
                        f'Provider {provider_name}: "apiKey" is required when defining custom models.'
                    )

            for model_def in models:
                has_model_api = bool(model_def.get("api"))

                if not has_provider_api and not has_model_api and not is_built_in:
                    raise ValueError(
                        f'Provider {provider_name}, model {model_def.get("id")}: no "api" specified. Set at provider or model level.'
                    )

                if not model_def.get("id"):
                    raise ValueError(f'Provider {provider_name}: model missing "id"')
                if model_def.get("contextWindow") is not None and model_def["contextWindow"] <= 0:
                    raise ValueError(
                        f'Provider {provider_name}, model {model_def["id"]}: invalid contextWindow'
                    )
                if model_def.get("maxTokens") is not None and model_def["maxTokens"] <= 0:
                    raise ValueError(
                        f'Provider {provider_name}, model {model_def["id"]}: invalid maxTokens'
                    )

    def parse_models(self, config: dict[str, Any]) -> list[Model]:
        models: list[Model] = []
        built_in_providers = set(get_providers())
        built_in_defaults_cache: dict[str, dict[str, str]] = {}

        def get_built_in_defaults(provider_name: str) -> Optional[dict[str, str]]:
            if provider_name not in built_in_providers:
                return None
            if provider_name in built_in_defaults_cache:
                return built_in_defaults_cache[provider_name]
            built_in = get_models(provider_name)
            if not built_in:
                return None
            defaults = {
                "api": built_in[0].get("api", ""),
                "baseUrl": built_in[0].get("baseUrl", ""),
            }
            built_in_defaults_cache[provider_name] = defaults
            return defaults

        for provider_name, provider_config in config.get("providers", {}).items():
            model_defs = provider_config.get("models", [])
            if not model_defs:
                continue

            built_in_defaults = get_built_in_defaults(provider_name)

            for model_def in model_defs:
                api = model_def.get("api") or provider_config.get("api")
                if not api and built_in_defaults:
                    api = built_in_defaults.get("api")
                if not api:
                    continue

                base_url = model_def.get("baseUrl") or provider_config.get("baseUrl")
                if not base_url and built_in_defaults:
                    base_url = built_in_defaults.get("baseUrl")
                if not base_url:
                    continue

                compat = merge_compat(provider_config.get("compat"), model_def.get("compat"))
                self.store_model_headers(provider_name, model_def["id"], model_def.get("headers"))

                default_cost = {"input": 0.0, "output": 0.0, "cacheRead": 0.0, "cacheWrite": 0.0}
                models.append(
                    {
                        "id": model_def["id"],
                        "name": model_def.get("name") or model_def["id"],
                        "api": cast(Api, api),
                        "provider": provider_name,
                        "baseUrl": base_url,
                        "reasoning": model_def.get("reasoning", False),
                        "thinkingLevelMap": model_def.get("thinkingLevelMap"),
                        "input": model_def.get("input") or ["text"],
                        "cost": cast(ModelCost, model_def.get("cost") or default_cost),
                        "contextWindow": model_def.get("contextWindow", 128000),
                        "maxTokens": model_def.get("maxTokens", 16384),
                        "compat": cast(dict[str, Any], compat),
                    }
                )

        return models

    def get_all(self) -> list[Model]:
        return self.models

    def get_available(self) -> list[Model]:
        return [m for m in self.models if self.has_configured_auth(m)]

    def find(self, provider: str, model_id: str) -> Optional[Model]:
        return next(
            (m for m in self.models if m.get("provider") == provider and m.get("id") == model_id),
            None,
        )

    def has_configured_auth(self, model: Model) -> bool:
        provider_config = self.provider_request_configs.get(model.get("provider", ""))
        provider_api_key = provider_config.get("apiKey") if provider_config else None
        return self.auth_storage.has_auth(model.get("provider", "")) or (
            provider_api_key is not None and is_config_value_configured(provider_api_key)
        )

    def get_model_request_key(self, provider: str, model_id: str) -> str:
        return f"{provider}:{model_id}"

    def store_provider_request_config(
        self,
        provider_name: str,
        config: dict[str, Any],
    ) -> None:
        if not config.get("apiKey") and not config.get("headers") and not config.get("authHeader"):
            return
        self.provider_request_configs[provider_name] = {
            "apiKey": config.get("apiKey"),
            "headers": config.get("headers"),
            "authHeader": config.get("authHeader"),
        }

    def store_model_headers(
        self, provider_name: str, model_id: str, headers: Optional[dict[str, str]]
    ) -> None:
        key = self.get_model_request_key(provider_name, model_id)
        if not headers or len(headers) == 0:
            self.model_request_headers.pop(key, None)
            return
        self.model_request_headers[key] = headers

    async def get_api_key_and_headers(self, model: Model) -> dict[str, Any]:
        try:
            provider = model.get("provider", "")
            provider_config = self.provider_request_configs.get(provider, {})
            provider_env = self.auth_storage.get_provider_env(provider)
            api_key_from_auth_storage = await self.auth_storage.get_api_key(
                provider, {"includeFallback": False}
            )
            provider_has_auth = self.auth_storage.has_auth(provider)

            provider_api_key = provider_config.get("apiKey")
            if api_key_from_auth_storage is not None:
                api_key = api_key_from_auth_storage
            elif provider == "cursor" and provider_has_auth:
                api_key = "<authenticated>"
            elif provider_api_key is not None:
                api_key = resolve_config_value_or_throw(
                    provider_api_key, f'API key for provider "{provider}"', provider_env
                )
            else:
                api_key = None

            provider_headers = resolve_headers_or_throw(
                provider_config.get("headers"), f'provider "{provider}"', provider_env
            )
            model_headers = resolve_headers_or_throw(
                self.model_request_headers.get(
                    self.get_model_request_key(provider, model.get("id", ""))
                ),
                f'model "{provider}/{model.get("id", "")}"',
                provider_env,
            )

            base_headers = model.get("headers")
            headers = {}
            if base_headers:
                headers.update(base_headers)
            if provider_headers:
                headers.update(provider_headers)
            if model_headers:
                headers.update(model_headers)

            if provider_config.get("authHeader"):
                if not api_key:
                    return {"ok": False, "error": f'No API key found for "{provider}"'}
                headers["Authorization"] = f"Bearer {api_key}"

            return {
                "ok": True,
                "apiKey": api_key,
                "headers": headers if len(headers) > 0 else None,
                "env": provider_env if provider_env else None,
            }
        except Exception as error:
            return {"ok": False, "error": str(error)}

    def get_provider_auth_status(self, provider: str) -> dict[str, Any]:
        auth_status = self.auth_storage.get_auth_status(provider)
        if auth_status.get("source"):
            return auth_status

        provider_config = self.provider_request_configs.get(provider)
        provider_api_key = provider_config.get("apiKey") if provider_config else None
        if not provider_api_key:
            return auth_status

        if is_command_config_value(provider_api_key):
            return {"configured": True, "source": "models_json_command"}

        env_var_names = get_config_value_env_var_names(provider_api_key)
        if len(env_var_names) > 0:
            if is_config_value_configured(provider_api_key):
                return {
                    "configured": True,
                    "source": "environment",
                    "label": ", ".join(env_var_names),
                }
            else:
                return {"configured": False}

        return {"configured": True, "source": "models_json_key"}

    def get_provider_display_name(self, provider: str) -> str:
        registered_provider = self.registered_providers.get(provider)
        oauth_provider = next(
            (p for p in self.auth_storage.get_oauth_providers() if p.id == provider), None
        )

        reg_name = registered_provider.get("name") if registered_provider else None
        reg_oauth_name = (
            registered_provider.get("oauth", {}).get("name") if registered_provider else None
        )
        oauth_name = oauth_provider.name if oauth_provider else None

        return (
            reg_name
            or reg_oauth_name
            or oauth_name
            or BUILT_IN_PROVIDER_DISPLAY_NAMES.get(provider)
            or provider
        )

    async def get_api_key_for_provider(self, provider: str) -> Optional[str]:
        api_key = await self.auth_storage.get_api_key(provider, {"includeFallback": False})
        if api_key is not None:
            return api_key

        provider_config = self.provider_request_configs.get(provider)
        provider_api_key = provider_config.get("apiKey") if provider_config else None
        return resolve_config_value_uncached(provider_api_key) if provider_api_key else None

    def is_using_oauth(self, model: Model) -> bool:
        cred = self.auth_storage.get(model.get("provider", ""))
        return cred is not None and cred.get("type") == "oauth"

    def register_provider(self, provider_name: str, config: dict[str, Any]) -> None:
        migrated_config = migrate_legacy_register_provider_config_values(provider_name, config)
        self.validate_provider_config(provider_name, migrated_config)
        self.apply_provider_config(provider_name, migrated_config)
        self.upsert_registered_provider(provider_name, migrated_config)

    def unregister_provider(self, provider_name: str) -> None:
        if provider_name not in self.registered_providers:
            return
        self.registered_providers.pop(provider_name)
        self.refresh()

    def upsert_registered_provider(self, provider_name: str, config: dict[str, Any]) -> None:
        existing = self.registered_providers.get(provider_name)
        if not existing:
            self.registered_providers[provider_name] = config
            return
        for k, v in config.items():
            if v is not None:
                existing[k] = v

    def validate_provider_config(self, provider_name: str, config: dict[str, Any]) -> None:
        if config.get("streamSimple") and not config.get("api"):
            raise ValueError(
                f'Provider {provider_name}: "api" is required when registering streamSimple.'
            )

        models = config.get("models")
        if not models or len(models) == 0:
            return

        if not config.get("baseUrl"):
            raise ValueError(
                f'Provider {provider_name}: "baseUrl" is required when defining models.'
            )
        if not config.get("apiKey") and not config.get("oauth"):
            raise ValueError(
                f'Provider {provider_name}: "apiKey" or "oauth" is required when defining models.'
            )

        for model_def in models:
            api = model_def.get("api") or config.get("api")
            if not api:
                raise ValueError(
                    f'Provider {provider_name}, model {model_def.get("id")}: no "api" specified.'
                )

    def apply_provider_config(self, provider_name: str, config: dict[str, Any]) -> None:
        if config.get("oauth"):
            oauth_provider = copy.deepcopy(config["oauth"])
            # In Python, we make sure the OAuth provider satisfies Protocol OAuthProviderInterface
            oauth_provider["id"] = provider_name

            # Wait, oauth_provider needs to be an object, not a dict. Let's wrap it in an interface adapter if needed.
            # But the register_oauth_provider expects OAuthProviderInterface. Let's define a class wrapper if needed.
            class OAuthProviderAdapter:
                def __init__(self, data: dict[str, Any]):
                    self.id = data["id"]
                    self.name = data.get("name", provider_name)
                    self._data = data

                async def login(self, callbacks: Any) -> Any:
                    if "login" in self._data:
                        return await self._data["login"](callbacks)
                    raise NotImplementedError("login not implemented")

                def refresh_token(self, credentials: Any) -> Any:
                    if "refresh_token" in self._data:
                        return self._data["refresh_token"](credentials)
                    return credentials

                def get_api_key(self, credentials: Any) -> str:
                    if "get_api_key" in self._data:
                        return self._data["get_api_key"](credentials)
                    return credentials.get("access", "")

                def modify_models(self, models: List[Model], credentials: Any) -> List[Model]:
                    if "modify_models" in self._data:
                        return self._data["modify_models"](models, credentials)
                    return models

            register_oauth_provider(OAuthProviderAdapter(oauth_provider))

        if config.get("streamSimple"):
            stream_simple = config["streamSimple"]

            # Wrap streamSimple and register it
            class SimpleApiProvider:
                def __init__(self, api: str, stream_simple: Any):
                    self.api = api
                    self._stream_simple = stream_simple

                def stream(self, model: Model, context: Any, options: Optional[Any] = None) -> Any:
                    return self._stream_simple(model, context, options)

                def stream_simple(
                    self, model: Model, context: Any, options: Optional[Any] = None
                ) -> Any:
                    return self._stream_simple(model, context, options)

            register_api_provider(
                SimpleApiProvider(config["api"], stream_simple),
                f"provider:{provider_name}",
            )

        self.store_provider_request_config(provider_name, config)

        models = config.get("models")
        if models and len(models) > 0:
            # Full replacement: remove existing models for this provider
            self.models = [m for m in self.models if m.get("provider") != provider_name]

            # Parse and add new models
            for model_def in models:
                api = model_def.get("api") or config.get("api")
                self.store_model_headers(provider_name, model_def["id"], model_def.get("headers"))

                self.models.append(
                    {
                        "id": model_def["id"],
                        "name": model_def["name"],
                        "api": cast(Api, api),
                        "provider": provider_name,
                        "baseUrl": model_def.get("baseUrl") or config.get("baseUrl", ""),
                        "reasoning": model_def.get("reasoning", False),
                        "thinkingLevelMap": model_def.get("thinkingLevelMap"),
                        "input": model_def.get("input", ["text"]),
                        "cost": model_def.get("cost"),
                        "contextWindow": model_def.get("contextWindow"),
                        "maxTokens": model_def.get("maxTokens"),
                        "compat": model_def.get("compat"),
                    }
                )

            # Apply OAuth modifyModels if credentials exist (e.g., to update baseUrl)
            oauth_provider = next(
                (p for p in self.auth_storage.get_oauth_providers() if p.id == provider_name), None
            )
            if oauth_provider and hasattr(oauth_provider, "modify_models"):
                cred = self.auth_storage.get(provider_name)
                if cred and cred.get("type") == "oauth":
                    self.models = oauth_provider.modify_models(self.models, cred)
        elif config.get("baseUrl") or config.get("headers"):
            # Override-only: update baseUrl for existing models
            new_models = []
            for m in self.models:
                if m.get("provider") == provider_name:
                    model = copy.deepcopy(m)
                    model["baseUrl"] = config.get("baseUrl") or model.get("baseUrl", "")
                    new_models.append(model)
                else:
                    new_models.append(m)
            self.models = new_models
