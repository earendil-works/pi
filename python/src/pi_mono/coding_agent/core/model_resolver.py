"""Model resolution, scoping, and initial selection."""

from __future__ import annotations

import fnmatch
import sys
from dataclasses import dataclass
from typing import Any

from pi_mono.agent.types import ThinkingLevel
from pi_mono.ai.models import models_are_equal
from pi_mono.ai.types import Model
from pi_mono.coding_agent.cli.args import is_valid_thinking_level
from pi_mono.core.defaults import DEFAULT_THINKING_LEVEL
from pi_mono.core.model_registry import ModelRegistry

KnownProvider = str

default_model_per_provider: dict[KnownProvider, str] = {
    "amazon-bedrock": "us.anthropic.claude-opus-4-6-v1",
    "ant-ling": "Ring-2.6-1T",
    "anthropic": "claude-opus-4-8",
    "openai": "gpt-5.4",
    "azure-openai-responses": "gpt-5.4",
    "openai-codex": "gpt-5.5",
    "nvidia": "nvidia/nemotron-3-super-120b-a12b",
    "deepseek": "deepseek-v4-pro",
    "google": "gemini-3.1-pro-preview",
    "google-vertex": "gemini-3.1-pro-preview",
    "github-copilot": "gpt-5.4",
    "openrouter": "moonshotai/kimi-k2.6",
    "vercel-ai-gateway": "zai/glm-5.1",
    "xai": "grok-4.20-0309-reasoning",
    "groq": "openai/gpt-oss-120b",
    "cerebras": "zai-glm-4.7",
    "zai": "glm-5.1",
    "zai-coding-cn": "glm-5.1",
    "mistral": "devstral-medium-latest",
    "minimax": "MiniMax-M2.7",
    "minimax-cn": "MiniMax-M2.7",
    "moonshotai": "kimi-k2.6",
    "moonshotai-cn": "kimi-k2.6",
    "huggingface": "moonshotai/Kimi-K2.6",
    "fireworks": "accounts/fireworks/models/kimi-k2p6",
    "together": "moonshotai/Kimi-K2.6",
    "opencode": "kimi-k2.6",
    "opencode-go": "kimi-k2.6",
    "kimi-coding": "kimi-for-coding",
    "cloudflare-workers-ai": "@cf/moonshotai/kimi-k2.6",
    "cloudflare-ai-gateway": "workers-ai/@cf/moonshotai/kimi-k2.6",
    "cursor": "auto",
    "xiaomi": "mimo-v2.5-pro",
    "xiaomi-token-plan-cn": "mimo-v2.5-pro",
    "xiaomi-token-plan-ams": "mimo-v2.5-pro",
    "xiaomi-token-plan-sgp": "mimo-v2.5-pro",
}


@dataclass
class ScopedModel:
    model: Model[Any]
    thinking_level: ThinkingLevel | None = None


@dataclass
class ParsedModelResult:
    model: Model[Any] | None
    thinking_level: ThinkingLevel | None = None
    warning: str | None = None


@dataclass
class ResolveCliModelResult:
    model: Model[Any] | None = None
    thinking_level: ThinkingLevel | None = None
    warning: str | None = None
    error: str | None = None


@dataclass
class InitialModelResult:
    model: Model[Any] | None
    thinking_level: ThinkingLevel
    fallback_message: str | None = None


def _is_alias(model_id: str) -> bool:
    if model_id.endswith("-latest"):
        return True
    import re

    return not bool(re.search(r"-\d{8}$", model_id))


def find_exact_model_reference_match(
    model_reference: str,
    available_models: list[Model[Any]],
) -> Model[Any] | None:
    trimmed_reference = model_reference.strip()
    if not trimmed_reference:
        return None

    normalized_reference = trimmed_reference.lower()

    canonical_matches = [
        model
        for model in available_models
        if f"{model['provider']}/{model['id']}".lower() == normalized_reference
    ]
    if len(canonical_matches) == 1:
        return canonical_matches[0]
    if len(canonical_matches) > 1:
        return None

    slash_index = trimmed_reference.find("/")
    if slash_index != -1:
        provider = trimmed_reference[:slash_index].strip()
        model_id = trimmed_reference[slash_index + 1 :].strip()
        if provider and model_id:
            provider_matches = [
                model
                for model in available_models
                if model["provider"].lower() == provider.lower()
                and model["id"].lower() == model_id.lower()
            ]
            if len(provider_matches) == 1:
                return provider_matches[0]
            if len(provider_matches) > 1:
                return None

    id_matches = [
        model for model in available_models if model["id"].lower() == normalized_reference
    ]
    return id_matches[0] if len(id_matches) == 1 else None


def _try_match_model(model_pattern: str, available_models: list[Model[Any]]) -> Model[Any] | None:
    exact_match = find_exact_model_reference_match(model_pattern, available_models)
    if exact_match:
        return exact_match

    pattern_lower = model_pattern.lower()
    matches = [
        model
        for model in available_models
        if pattern_lower in model["id"].lower()
        or pattern_lower in (model.get("name") or "").lower()
    ]
    if not matches:
        return None

    aliases = [model for model in matches if _is_alias(model["id"])]
    dated_versions = [model for model in matches if not _is_alias(model["id"])]

    if aliases:
        aliases.sort(key=lambda model: model["id"], reverse=True)
        return aliases[0]

    dated_versions.sort(key=lambda model: model["id"], reverse=True)
    return dated_versions[0]


def _build_fallback_model(
    provider: str, model_id: str, available_models: list[Model[Any]]
) -> Model[Any] | None:
    provider_models = [model for model in available_models if model["provider"] == provider]
    if not provider_models:
        return None

    default_id = default_model_per_provider.get(provider)
    base_model = next(
        (model for model in provider_models if model["id"] == default_id),
        provider_models[0],
    )
    return {**base_model, "id": model_id, "name": model_id}


def parse_model_pattern(
    pattern: str,
    available_models: list[Model[Any]],
    *,
    allow_invalid_thinking_level_fallback: bool = True,
) -> ParsedModelResult:
    exact_match = _try_match_model(pattern, available_models)
    if exact_match:
        return ParsedModelResult(model=exact_match)

    last_colon_index = pattern.rfind(":")
    if last_colon_index == -1:
        return ParsedModelResult(model=None)

    prefix = pattern[:last_colon_index]
    suffix = pattern[last_colon_index + 1 :]

    if is_valid_thinking_level(suffix):
        result = parse_model_pattern(
            prefix,
            available_models,
            allow_invalid_thinking_level_fallback=allow_invalid_thinking_level_fallback,
        )
        if result.model:
            return ParsedModelResult(
                model=result.model,
                thinking_level=None if result.warning else suffix,  # type: ignore[arg-type]
                warning=result.warning,
            )
        return result

    if not allow_invalid_thinking_level_fallback:
        return ParsedModelResult(model=None)

    result = parse_model_pattern(
        prefix,
        available_models,
        allow_invalid_thinking_level_fallback=allow_invalid_thinking_level_fallback,
    )
    if result.model:
        return ParsedModelResult(
            model=result.model,
            warning=(
                f'Invalid thinking level "{suffix}" in pattern "{pattern}". Using default instead.'
            ),
        )
    return result


def resolve_model_scope(patterns: list[str], model_registry: ModelRegistry) -> list[ScopedModel]:
    available_models = model_registry.get_available()
    scoped_models: list[ScopedModel] = []

    for pattern in patterns:
        if any(char in pattern for char in ("*", "?", "[")):
            colon_idx = pattern.rfind(":")
            glob_pattern = pattern
            thinking_level: ThinkingLevel | None = None
            if colon_idx != -1:
                suffix = pattern[colon_idx + 1 :]
                if is_valid_thinking_level(suffix):
                    thinking_level = suffix  # type: ignore[assignment]
                    glob_pattern = pattern[:colon_idx]

            matching_models = [
                model
                for model in available_models
                if fnmatch.fnmatch(
                    f"{model['provider']}/{model['id']}", glob_pattern, flags=fnmatch.IGNORECASE
                )
                or fnmatch.fnmatch(model["id"], glob_pattern, flags=fnmatch.IGNORECASE)
            ]
            if not matching_models:
                print(f'Warning: No models match pattern "{pattern}"', file=sys.stderr)
                continue

            for model in matching_models:
                if not any(models_are_equal(scoped.model, model) for scoped in scoped_models):
                    scoped_models.append(ScopedModel(model=model, thinking_level=thinking_level))
            continue

        parsed = parse_model_pattern(pattern, available_models)
        if parsed.warning:
            print(f"Warning: {parsed.warning}", file=sys.stderr)
        if not parsed.model:
            print(f'Warning: No models match pattern "{pattern}"', file=sys.stderr)
            continue
        if not any(models_are_equal(scoped.model, parsed.model) for scoped in scoped_models):
            scoped_models.append(
                ScopedModel(model=parsed.model, thinking_level=parsed.thinking_level)
            )

    return scoped_models


def resolve_cli_model(
    *,
    cli_provider: str | None = None,
    cli_model: str | None = None,
    model_registry: ModelRegistry,
) -> ResolveCliModelResult:
    if not cli_model and not cli_provider:
        return ResolveCliModelResult()

    available_models = model_registry.get_all()
    if not available_models:
        return ResolveCliModelResult(
            error="No models available. Check your installation or add models to models.json."
        )

    provider_map = {model["provider"].lower(): model["provider"] for model in available_models}

    if not cli_model and cli_provider:
        canonical_provider = provider_map.get(cli_provider.lower())
        if not canonical_provider:
            return ResolveCliModelResult(
                error=(
                    f'Unknown provider "{cli_provider}". '
                    "Use --list-models to see available providers/models."
                )
            )
        default_id = default_model_per_provider.get(canonical_provider.lower())
        if default_id:
            cli_model = default_id
        else:
            provider_models = [
                model for model in available_models if model["provider"] == canonical_provider
            ]
            if len(provider_models) == 1:
                return ResolveCliModelResult(model=provider_models[0])
            if provider_models:
                cli_model = provider_models[0]["id"]
            else:
                return ResolveCliModelResult(
                    error=(
                        f'No models found for provider "{cli_provider}". '
                        "Use --list-models to see available providers/models."
                    )
                )

    if not cli_model:
        return ResolveCliModelResult()

    provider = provider_map.get(cli_provider.lower()) if cli_provider else None
    if cli_provider and not provider:
        return ResolveCliModelResult(
            error=(
                f'Unknown provider "{cli_provider}". '
                "Use --list-models to see available providers/models."
            )
        )

    pattern = cli_model
    inferred_provider = False

    if not provider:
        slash_index = cli_model.find("/")
        if slash_index != -1:
            maybe_provider = cli_model[:slash_index]
            canonical = provider_map.get(maybe_provider.lower())
            if canonical:
                provider = canonical
                pattern = cli_model[slash_index + 1 :]
                inferred_provider = True

    if not provider:
        lower = cli_model.lower()
        exact = next(
            (
                model
                for model in available_models
                if model["id"].lower() == lower
                or f"{model['provider']}/{model['id']}".lower() == lower
            ),
            None,
        )
        if exact:
            return ResolveCliModelResult(model=exact)

    if cli_provider and provider:
        prefix = f"{provider}/"
        if cli_model.lower().startswith(prefix.lower()):
            pattern = cli_model[len(prefix) :]

    candidates = (
        [model for model in available_models if model["provider"] == provider]
        if provider
        else available_models
    )
    parsed = parse_model_pattern(
        pattern,
        candidates,
        allow_invalid_thinking_level_fallback=False,
    )
    if parsed.model:
        return ResolveCliModelResult(
            model=parsed.model,
            thinking_level=parsed.thinking_level,
            warning=parsed.warning,
        )

    if inferred_provider:
        lower = cli_model.lower()
        exact = next(
            (
                model
                for model in available_models
                if model["id"].lower() == lower
                or f"{model['provider']}/{model['id']}".lower() == lower
            ),
            None,
        )
        if exact:
            return ResolveCliModelResult(model=exact)
        fallback = parse_model_pattern(
            cli_model,
            available_models,
            allow_invalid_thinking_level_fallback=False,
        )
        if fallback.model:
            return ResolveCliModelResult(
                model=fallback.model,
                thinking_level=fallback.thinking_level,
                warning=fallback.warning,
            )

    if provider:
        fallback_model = _build_fallback_model(provider, pattern, available_models)
        if fallback_model:
            fallback_warning = (
                f'{parsed.warning} Model "{pattern}" not found for provider "{provider}". Using custom model id.'
                if parsed.warning
                else f'Model "{pattern}" not found for provider "{provider}". Using custom model id.'
            )
            return ResolveCliModelResult(model=fallback_model, warning=fallback_warning)

    display = f"{provider}/{pattern}" if provider else cli_model
    return ResolveCliModelResult(
        warning=parsed.warning,
        error=f'Model "{display}" not found. Use --list-models to see available models.',
    )


def find_initial_model(
    *,
    cli_provider: str | None = None,
    cli_model: str | None = None,
    scoped_models: list[ScopedModel],
    is_continuing: bool,
    default_provider: str | None = None,
    default_model_id: str | None = None,
    default_thinking_level: ThinkingLevel | None = None,
    model_registry: ModelRegistry,
) -> InitialModelResult:
    if cli_provider and cli_model:
        resolved = resolve_cli_model(
            cli_provider=cli_provider,
            cli_model=cli_model,
            model_registry=model_registry,
        )
        if resolved.error:
            print(resolved.error, file=sys.stderr)
            raise SystemExit(1)
        if resolved.model:
            return InitialModelResult(
                model=resolved.model,
                thinking_level=DEFAULT_THINKING_LEVEL,  # type: ignore[arg-type]
            )

    if scoped_models and not is_continuing:
        return InitialModelResult(
            model=scoped_models[0].model,
            thinking_level=scoped_models[0].thinking_level
            or default_thinking_level
            or DEFAULT_THINKING_LEVEL,  # type: ignore[arg-type]
        )

    if default_provider and default_model_id:
        found = model_registry.find(default_provider, default_model_id)
        # Skip unauthenticated saved defaults so startup falls through to an
        # available authenticated model (#6231).
        if found and model_registry.has_configured_auth(found):
            thinking_level: ThinkingLevel = (
                default_thinking_level or DEFAULT_THINKING_LEVEL  # type: ignore[assignment]
            )
            return InitialModelResult(model=found, thinking_level=thinking_level)

    available_models = model_registry.get_available()
    if available_models:
        for provider, default_id in default_model_per_provider.items():
            match = next(
                (
                    model
                    for model in available_models
                    if model["provider"] == provider and model["id"] == default_id
                ),
                None,
            )
            if match:
                return InitialModelResult(
                    model=match,
                    thinking_level=DEFAULT_THINKING_LEVEL,  # type: ignore[arg-type]
                )
        return InitialModelResult(
            model=available_models[0],
            thinking_level=DEFAULT_THINKING_LEVEL,  # type: ignore[arg-type]
        )

    return InitialModelResult(
        model=None,
        thinking_level=DEFAULT_THINKING_LEVEL,  # type: ignore[arg-type]
    )


async def restore_model_from_session(
    saved_provider: str,
    saved_model_id: str,
    current_model: Model[Any] | None,
    should_print_messages: bool,
    model_registry: ModelRegistry,
) -> tuple[Model[Any] | None, str | None]:
    restored_model = model_registry.find(saved_provider, saved_model_id)
    has_configured_auth = (
        model_registry.has_configured_auth(restored_model) if restored_model else False
    )

    if restored_model and has_configured_auth:
        if should_print_messages:
            print(f"Restored model: {saved_provider}/{saved_model_id}")
        return restored_model, None

    reason = "model no longer exists" if not restored_model else "no auth configured"
    if should_print_messages:
        print(
            f"Warning: Could not restore model {saved_provider}/{saved_model_id} ({reason}).",
            file=sys.stderr,
        )

    if current_model:
        if should_print_messages:
            print(f"Falling back to: {current_model['provider']}/{current_model['id']}")
        return (
            current_model,
            (
                f"Could not restore model {saved_provider}/{saved_model_id} ({reason}). "
                f"Using {current_model['provider']}/{current_model['id']}."
            ),
        )

    available_models = model_registry.get_available()
    if available_models:
        fallback_model: Model[Any] | None = None
        for provider, default_id in default_model_per_provider.items():
            match = next(
                (
                    model
                    for model in available_models
                    if model["provider"] == provider and model["id"] == default_id
                ),
                None,
            )
            if match:
                fallback_model = match
                break
        if not fallback_model:
            fallback_model = available_models[0]
        if should_print_messages:
            print(f"Falling back to: {fallback_model['provider']}/{fallback_model['id']}")
        return (
            fallback_model,
            (
                f"Could not restore model {saved_provider}/{saved_model_id} ({reason}). "
                f"Using {fallback_model['provider']}/{fallback_model['id']}."
            ),
        )

    return None, None
