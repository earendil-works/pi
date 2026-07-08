import pytest
from pi_mono.utils.pi_user_agent import get_pi_user_agent
from pi_mono.utils import version_check


def test_get_pi_user_agent():
    ua = get_pi_user_agent("1.2.3")
    assert ua.startswith("pi/1.2.3 (")
    assert "python/" in ua


def test_parse_package_version():
    parsed = version_check.parse_package_version("1.2.3-alpha.1")
    assert parsed is not None
    assert parsed["major"] == 1
    assert parsed["minor"] == 2
    assert parsed["patch"] == 3
    assert parsed["prerelease"] == "alpha.1"

    assert version_check.parse_package_version("invalid") is None


def test_compare_package_versions():
    # major
    assert version_check.compare_package_versions("2.0.0", "1.0.0") == 1
    assert version_check.compare_package_versions("1.0.0", "2.0.0") == -1

    # minor
    assert version_check.compare_package_versions("1.2.0", "1.1.0") == 1
    assert version_check.compare_package_versions("1.1.0", "1.2.0") == -1

    # patch
    assert version_check.compare_package_versions("1.1.2", "1.1.1") == 1
    assert version_check.compare_package_versions("1.1.1", "1.1.2") == -1

    # prerelease
    assert version_check.compare_package_versions("1.0.0-alpha", "1.0.0") == -1
    assert version_check.compare_package_versions("1.0.0", "1.0.0-alpha") == 1
    assert version_check.compare_package_versions("1.0.0-alpha", "1.0.0-alpha") == 0
    assert version_check.compare_package_versions("1.0.0-alpha", "1.0.0-beta") == -1
    assert version_check.compare_package_versions("1.0.0-beta", "1.0.0-alpha") == 1


def test_is_newer_package_version():
    assert version_check.is_newer_package_version("1.2.3", "1.2.2") is True
    assert version_check.is_newer_package_version("1.2.2", "1.2.3") is False
    assert version_check.is_newer_package_version("1.2.3", "1.2.3") is False

    # invalid semver string comparison fallback
    assert version_check.is_newer_package_version("abc", "def") is True
    assert version_check.is_newer_package_version("abc", "abc") is False


@pytest.mark.anyio
async def test_get_latest_pi_release_offline(monkeypatch):
    monkeypatch.setenv("PI_OFFLINE", "1")
    res = await version_check.get_latest_pi_release("1.0.0")
    assert res is None


@pytest.mark.anyio
async def test_get_latest_pi_release_success(monkeypatch):
    # Mock network sync fetch
    def mock_fetch(url, headers, timeout):
        return {
            "version": "2.0.0",
            "packageName": "pi-coding-agent",
            "note": "A new release!",
        }

    monkeypatch.setattr(version_check, "_fetch_version_sync", mock_fetch)
    monkeypatch.delenv("PI_OFFLINE", raising=False)
    monkeypatch.delenv("PI_SKIP_VERSION_CHECK", raising=False)

    release = await version_check.get_latest_pi_release("1.0.0")
    assert release is not None
    assert release["version"] == "2.0.0"
    assert release["packageName"] == "pi-coding-agent"
    assert release["note"] == "A new release!"


@pytest.mark.anyio
async def test_get_latest_pi_version(monkeypatch):
    monkeypatch.setattr(
        version_check,
        "_fetch_version_sync",
        lambda url, headers, timeout: {"version": "2.0.0"},
    )
    monkeypatch.delenv("PI_OFFLINE", raising=False)

    version = await version_check.get_latest_pi_version("1.0.0")
    assert version == "2.0.0"


@pytest.mark.anyio
async def test_check_for_new_pi_version(monkeypatch):
    monkeypatch.setattr(
        version_check,
        "_fetch_version_sync",
        lambda url, headers, timeout: {"version": "2.0.0"},
    )
    monkeypatch.delenv("PI_OFFLINE", raising=False)

    # Newer version -> should return release
    release = await version_check.check_for_new_pi_version("1.0.0")
    assert release is not None
    assert release["version"] == "2.0.0"

    # Current/older version -> should return None
    release_none = await version_check.check_for_new_pi_version("2.0.0")
    assert release_none is None
