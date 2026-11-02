"""Google TimesFM 与 Amazon Chronos 的模型目录。

上限来自两家公开的模型说明，用作编排时的单次调用预算。
接入 API 之后，adapter 仍应遵守这里的 max_context 与 max_horizon。
"""

from __future__ import annotations

from tsagent.types import ModelSpec

MODELS: tuple[ModelSpec, ...] = (
    ModelSpec(
        id="google/timesfm-1.0-200m-pytorch",
        family="google",
        display_name="TimesFM 1.0 200M",
        max_context=2048,
        max_horizon=128,
        quantile_mode="deciles",
        supports_covariates=False,
        supports_multivariate=False,
        requires_freq_token=True,
        supports_chunking=True,
        preference=0.3,
        notes="单变量。1.0 需要 freq token。编排器单次最多 128 步，更长则滚动拼接。",
    ),
    ModelSpec(
        id="google/timesfm-2.0-500m-pytorch",
        family="google",
        display_name="TimesFM 2.0 500M",
        max_context=2048,
        max_horizon=128,
        quantile_mode="deciles",
        supports_covariates=False,
        supports_multivariate=False,
        requires_freq_token=True,
        supports_chunking=True,
        preference=0.6,
        notes="单变量。2.0 需要 freq token。编排器单次最多 128 步，更长则滚动拼接。",
    ),
    ModelSpec(
        id="google/timesfm-2.5-200m-pytorch",
        family="google",
        display_name="TimesFM 2.5 200M",
        max_context=16384,
        max_horizon=1024,
        context_plus_horizon_limit=16384,
        quantile_mode="deciles",
        supports_covariates=False,
        supports_multivariate=False,
        requires_freq_token=False,
        supports_chunking=True,
        preference=1.0,
        notes="单变量，不需要 freq token。连续分位数头单次最多 1024 步，上下文加步长不超过 16384。",
    ),
    ModelSpec(
        id="amazon/chronos-t5-small",
        family="amazon",
        display_name="Chronos-T5 Small",
        max_context=512,
        max_horizon=64,
        quantile_mode="samples",
        supports_covariates=False,
        supports_multivariate=False,
        requires_freq_token=False,
        supports_chunking=True,
        preference=0.3,
        notes="单变量。原始 Chronos 输出样本，分位数要从样本计算。上下文 512，单次 64 步。",
    ),
    ModelSpec(
        id="amazon/chronos-t5-base",
        family="amazon",
        display_name="Chronos-T5 Base",
        max_context=512,
        max_horizon=64,
        quantile_mode="samples",
        supports_covariates=False,
        supports_multivariate=False,
        requires_freq_token=False,
        supports_chunking=True,
        preference=0.4,
        notes="单变量。原始 Chronos 输出样本。上下文 512，单次 64 步。",
    ),
    ModelSpec(
        id="amazon/chronos-t5-large",
        family="amazon",
        display_name="Chronos-T5 Large",
        max_context=512,
        max_horizon=64,
        quantile_mode="samples",
        supports_covariates=False,
        supports_multivariate=False,
        requires_freq_token=False,
        supports_chunking=True,
        preference=0.45,
        notes="单变量。原始 Chronos 输出样本。上下文 512，单次 64 步。",
    ),
    ModelSpec(
        id="amazon/chronos-bolt-small",
        family="amazon",
        display_name="Chronos-Bolt Small",
        max_context=2048,
        max_horizon=64,
        quantile_mode="arbitrary",
        supports_covariates=False,
        supports_multivariate=False,
        requires_freq_token=False,
        supports_chunking=True,
        preference=0.55,
        notes="单变量。Bolt 直接输出分位数。上下文 2048，单次 64 步。",
    ),
    ModelSpec(
        id="amazon/chronos-bolt-base",
        family="amazon",
        display_name="Chronos-Bolt Base",
        max_context=2048,
        max_horizon=64,
        quantile_mode="arbitrary",
        supports_covariates=False,
        supports_multivariate=False,
        requires_freq_token=False,
        supports_chunking=True,
        preference=0.7,
        notes="单变量。Bolt 直接输出分位数。上下文 2048，单次 64 步。",
    ),
    ModelSpec(
        id="amazon/chronos-2",
        family="amazon",
        display_name="Chronos-2",
        max_context=8192,
        max_horizon=1024,
        quantile_mode="arbitrary",
        supports_covariates=True,
        supports_multivariate=True,
        requires_freq_token=False,
        supports_chunking=True,
        preference=1.0,
        notes="支持过去协变量和已知未来协变量，也能做多变量。当前 runner 仍一次预测一个目标。上下文 8192，单次 1024 步。",
    ),
)

_BY_ID = {model.id: model for model in MODELS}


def list_models(family: str | None = None) -> tuple[ModelSpec, ...]:
    """按目录顺序返回模型。`family` 为 google 或 amazon 时只返回该家族。"""
    if family is None:
        return MODELS
    return tuple(model for model in MODELS if model.family == family)


def get_model(model_id: str) -> ModelSpec:
    """按 repo id 取模型。未知 id 抛出 KeyError。"""
    try:
        return _BY_ID[model_id]
    except KeyError:
        raise KeyError(model_id) from None
