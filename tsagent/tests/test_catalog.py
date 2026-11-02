import math

from tsagent.catalog import get_model, list_models
from tsagent.series import timesfm_freq_token
from tsagent.stats import norm_ppf


def test_catalog_contains_google_and_amazon_models():
    families = {model.family for model in list_models()}
    assert families == {"google", "amazon"}
    assert get_model("google/timesfm-2.5-200m-pytorch").max_context == 16384
    assert get_model("amazon/chronos-2").supports_covariates is True
    assert get_model("amazon/chronos-bolt-base").max_context == 2048
    assert get_model("amazon/chronos-t5-small").max_horizon == 64
    assert all(not model.supports_covariates for model in list_models("google"))


def test_timesfm_frequency_tokens():
    assert timesfm_freq_token("h") == 0
    assert timesfm_freq_token("D") == 1
    assert timesfm_freq_token("W") == 2
    assert timesfm_freq_token(None) == 0


def test_normal_quantile_function():
    assert norm_ppf(0.5) == 0
    assert math.isclose(norm_ppf(0.975), 1.95996398454, rel_tol=0, abs_tol=1e-6)
    assert math.isclose(norm_ppf(0.1), -1.28155156554, rel_tol=0, abs_tol=1e-6)
