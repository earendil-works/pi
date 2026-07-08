import os
import sys
from pathlib import Path
import pytest
from pi_mono import config


def test_expand_tilde_path(monkeypatch):
    home = str(Path.home())
    assert config.expand_tilde_path("~") == home
    assert config.expand_tilde_path("~/foo") == os.path.join(home, "foo")
    assert config.expand_tilde_path("~\\bar") == os.path.join(home, "bar")
    assert config.expand_tilde_path("normal/path") == "normal/path"

    # file:// path testing
    if sys.platform == "win32":
        assert config.expand_tilde_path("file:///C:/foo/bar") == "C:\\foo\\bar"
    else:
        assert config.expand_tilde_path("file:///foo/bar") == "/foo/bar"


def test_make_self_update_command_step():
    step = config.make_self_update_command_step("npm", ["install", "some package", "-g"])
    assert step["command"] == "npm"
    assert step["args"] == ["install", "some package", "-g"]
    assert step["display"] == 'npm install "some package" -g'

    step_simple = config.make_self_update_command_step("npm", ["install", "-g"])
    assert step_simple["display"] == "npm install -g"


def test_make_self_update_command():
    step1 = config.make_self_update_command_step("npm", ["uninstall", "-g", "pkg"])
    step2 = config.make_self_update_command_step("npm", ["install", "-g", "pkg"])

    cmd = config.make_self_update_command(step2, step1)
    assert cmd["display"] == "npm uninstall -g pkg && npm install -g pkg"
    assert cmd["steps"] == [step1, step2]

    cmd_no_uninstall = config.make_self_update_command(step2, None)
    assert "steps" not in cmd_no_uninstall
    assert cmd_no_uninstall["display"] == "npm install -g pkg"


def test_detect_install_method(monkeypatch):
    # Test fallback
    monkeypatch.setattr(config, "IS_BUN_BINARY", False)
    monkeypatch.setattr(config, "IS_BUN_RUNTIME", False)
    monkeypatch.setattr(sys, "executable", "/usr/bin/python")
    assert config.detect_install_method() == "unknown"

    # Test pnpm
    monkeypatch.setattr(sys, "executable", "/path/to/.pnpm/node")
    assert config.detect_install_method() == "pnpm"

    # Test yarn
    monkeypatch.setattr(sys, "executable", "/path/to/yarn/node")
    assert config.detect_install_method() == "yarn"

    # Test bun
    monkeypatch.setattr(sys, "executable", "/install/global/node_modules/something")
    assert config.detect_install_method() == "bun"

    # Test npm
    monkeypatch.setattr(sys, "executable", "/path/to/node_modules/something")
    assert config.detect_install_method() == "npm"

    # Test bun binary
    monkeypatch.setattr(config, "IS_BUN_BINARY", True)
    assert config.detect_install_method() == "bun-binary"


def test_get_inferred_npm_install(tmp_path, monkeypatch):
    # Mock get_package_dir
    fake_pkg_dir = tmp_path / "lib" / "node_modules" / "@earendil-works" / "pi-coding-agent"
    fake_pkg_dir.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config, "get_package_dir", lambda: fake_pkg_dir)

    inferred = config.get_inferred_npm_install()
    assert inferred is not None
    assert inferred["prefix"] == str(tmp_path)
    assert inferred["root"] == str(tmp_path / "lib" / "node_modules")

    # Non-inferred format
    fake_pkg_dir_2 = tmp_path / "other" / "pi-coding-agent"
    fake_pkg_dir_2.mkdir(parents=True, exist_ok=True)
    monkeypatch.setattr(config, "get_package_dir", lambda: fake_pkg_dir_2)
    assert config.get_inferred_npm_install() is None


def test_get_self_update_command_for_method():
    cmd = config.get_self_update_command_for_method("pnpm", "my-pkg")
    assert cmd is not None
    assert cmd["command"] == "pnpm"
    assert "install" in cmd["args"]
    assert "remove" not in cmd["display"]

    # Different package name -> uninstall should be present
    cmd_diff = config.get_self_update_command_for_method("pnpm", "my-pkg", "new-pkg")
    assert cmd_diff is not None
    assert "pnpm remove -g my-pkg" in cmd_diff["display"]
    assert "pnpm install -g" in cmd_diff["display"]

    cmd_yarn = config.get_self_update_command_for_method("yarn", "my-pkg", "new-pkg")
    assert cmd_yarn is not None
    assert "yarn global remove my-pkg" in cmd_yarn["display"]
    assert "yarn global add" in cmd_yarn["display"]

    cmd_bun = config.get_self_update_command_for_method("bun", "my-pkg", "new-pkg")
    assert cmd_bun is not None
    assert "bun uninstall -g my-pkg" in cmd_bun["display"]

    cmd_npm = config.get_self_update_command_for_method(
        "npm", "my-pkg", "new-pkg", ["npm", "--registry", "url"]
    )
    assert cmd_npm is not None
    assert "npm --registry url uninstall -g my-pkg" in cmd_npm["display"]


def test_read_command_output():
    # Simple echo
    out = config.read_command_output("echo", ["hello-test"])
    assert out == "hello-test"

    # Failing command without require_success
    out_fail = config.read_command_output("false", [])
    assert out_fail is None

    # Failing command with require_success
    with pytest.raises(RuntimeError):
        config.read_command_output("false", [], require_success=True)


def test_get_global_package_roots(monkeypatch):
    monkeypatch.setattr(
        config, "read_command_output", lambda cmd, args, require_success=False: "/mocked/root"
    )

    roots = config.get_global_package_roots("pnpm", "pkg")
    assert "/mocked/root" in roots

    roots_yarn = config.get_global_package_roots("yarn", "pkg")
    assert "/mocked/root" in roots_yarn

    roots_bun = config.get_global_package_roots("bun", "pkg")
    assert len(roots_bun) > 0


def test_normalize_existing_path_for_comparison(tmp_path):
    existing = tmp_path / "exists.txt"
    existing.touch()

    p = config.normalize_existing_path_for_comparison(str(existing), False)
    assert p is not None
    assert Path(p).name == "exists.txt"

    assert (
        config.normalize_existing_path_for_comparison(str(tmp_path / "doesnotexist"), False) is None
    )


def test_get_path_comparison_candidates(tmp_path):
    existing = tmp_path / "exists.txt"
    existing.touch()
    candidates = config.get_path_comparison_candidates(str(existing))
    assert len(candidates) > 0


def test_get_entrypoint_package_dir(monkeypatch):
    # sys.argv mock
    monkeypatch.setattr(sys, "argv", ["/some/path/to/entry.py"])
    assert config.get_entrypoint_package_dir() is None


def test_is_self_update_path_writable(monkeypatch):
    monkeypatch.setattr(config, "get_package_dir", lambda: Path("/nonexistent/path"))
    assert config.is_self_update_path_writable() is False


def test_themes_and_assets_dirs(monkeypatch):
    monkeypatch.setattr(config, "get_package_dir", lambda: Path("/tmp"))

    monkeypatch.setattr(config, "IS_BUN_BINARY", True)
    assert config.get_themes_dir() == Path("/tmp/theme")
    assert config.get_export_template_dir() == Path("/tmp/export-html")
    assert config.get_interactive_assets_dir() == Path("/tmp/assets")
    assert config.get_bundled_interactive_asset_path("test.css") == Path("/tmp/assets/test.css")

    monkeypatch.setattr(config, "IS_BUN_BINARY", False)
    # Check fallback directory resolution
    assert "/modes/interactive/theme" in str(config.get_themes_dir())
