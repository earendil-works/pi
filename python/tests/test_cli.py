import pytest
from unittest import mock
from pi_mono.ai.oauth import (
    StubOAuthProvider,
    get_oauth_provider,
    register_oauth_provider,
    unregister_oauth_provider,
    reset_oauth_providers,
    get_oauth_providers,
    OAuthLoginCallbacks,
)
from pi_mono.ai.cli import (
    ConsoleOAuthCallbacks,
    load_auth,
    save_auth,
    login,
    main,
)


@pytest.fixture(autouse=True)
def setup_oauth_providers():
    reset_oauth_providers()
    yield
    reset_oauth_providers()


# -----------------
# Tests for oauth.py
# -----------------


@pytest.mark.anyio
async def test_stub_oauth_provider():
    provider = StubOAuthProvider("test-provider", "Test Provider")
    assert provider.id == "test-provider"
    assert provider.name == "Test Provider"

    with pytest.raises(NotImplementedError) as excinfo:
        await provider.login(None)
    assert "OAuth login for 'Test Provider' is not implemented in Python." in str(excinfo.value)

    creds = {"access": "token", "refresh": "ref", "expires": 123}
    assert provider.refresh_token(creds) == creds
    assert provider.get_api_key(creds) == "token"
    assert provider.get_api_key({}) == ""

    models = [{"id": "model-1"}]
    assert provider.modify_models(models, creds) == models  # type: ignore


@pytest.mark.anyio
async def test_oauth_login_callbacks():
    callbacks = OAuthLoginCallbacks()
    # verify no exception is thrown
    callbacks.on_auth({"url": "http://test", "instructions": "test"})
    callbacks.on_device_code({"userCode": "123", "verificationUri": "http://test"})
    callbacks.on_progress("progress message")
    assert await callbacks.on_prompt({"message": "prompt"}) == ""
    assert await callbacks.on_select({"message": "select", "options": []}) is None


def test_oauth_provider_registry():
    reset_oauth_providers()
    initial_providers = get_oauth_providers()
    assert len(initial_providers) > 0

    custom_provider = StubOAuthProvider("custom", "Custom Provider")
    register_oauth_provider(custom_provider)
    assert get_oauth_provider("custom") == custom_provider
    assert custom_provider in get_oauth_providers()

    unregister_oauth_provider("custom")
    assert get_oauth_provider("custom") is None

    # unregistering a built-in provider should restore it to its default built-in instance
    built_in = initial_providers[0]
    # first modify it in registry
    modified_provider = StubOAuthProvider(built_in.id, "Modified")
    register_oauth_provider(modified_provider)
    assert get_oauth_provider(built_in.id) == modified_provider

    # unregister should restore built-in
    unregister_oauth_provider(built_in.id)
    restored = get_oauth_provider(built_in.id)
    assert restored is not None
    assert restored.name == built_in.name

    # reset oauth providers
    reset_oauth_providers()
    assert get_oauth_providers() == initial_providers


# -----------------
# Tests for cli.py
# -----------------


@pytest.fixture
def mock_auth_file(tmp_path):
    auth_file = tmp_path / "auth.json"
    with mock.patch("pi_mono.ai.cli.get_auth_path", return_value=auth_file):
        yield auth_file


def test_load_auth_nonexistent(mock_auth_file):
    assert load_auth() == {}


def test_load_auth_invalid(mock_auth_file):
    mock_auth_file.write_text("invalid json")
    assert load_auth() == {}


def test_load_auth_and_save_auth(mock_auth_file):
    data = {"anthropic": {"type": "oauth", "access": "token"}}
    save_auth(data)
    assert load_auth() == data


def test_save_auth_exception(mock_auth_file):
    with mock.patch("builtins.open", side_effect=IOError("Permission denied")):
        with mock.patch("sys.stderr.write") as mock_stderr:
            save_auth({"test": "data"})
            # Verify it printed an error to stderr
            mock_stderr.assert_called()


def test_console_callbacks_prints(capsys):
    callbacks = ConsoleOAuthCallbacks()
    callbacks.on_auth({"url": "http://test-url", "instructions": "test instructions"})
    captured = capsys.readouterr()
    assert "Open this URL in your browser:\nhttp://test-url" in captured.out
    assert "test instructions" in captured.out

    callbacks.on_device_code({"verificationUri": "http://device-url", "userCode": "ABCD-1234"})
    captured = capsys.readouterr()
    assert "Open this URL in your browser:\nhttp://device-url" in captured.out
    assert "Enter code: ABCD-1234" in captured.out

    callbacks.on_progress("doing something")
    captured = capsys.readouterr()
    assert "doing something" in captured.out


@pytest.mark.anyio
async def test_console_callbacks_on_prompt():
    callbacks = ConsoleOAuthCallbacks()
    with mock.patch("builtins.input", return_value="user input value") as mock_input:
        res = await callbacks.on_prompt({"message": "Enter details", "placeholder": "xyz"})
        assert res == "user input value"
        mock_input.assert_called_with("Enter details (xyz): ")


@pytest.mark.anyio
async def test_console_callbacks_on_select(capsys):
    callbacks = ConsoleOAuthCallbacks()
    prompt = {
        "message": "Choose option",
        "options": [
            {"id": "opt1", "label": "Option One"},
            {"id": "opt2", "label": "Option Two"},
        ],
    }

    # Test valid choice
    with mock.patch("builtins.input", return_value="2"):
        res = await callbacks.on_select(prompt)  # type: ignore
        assert res == "opt2"

    # Test invalid choice (out of bounds)
    with mock.patch("builtins.input", return_value="5"):
        res = await callbacks.on_select(prompt)  # type: ignore
        assert res is None

    # Test non-integer choice
    with mock.patch("builtins.input", return_value="abc"):
        res = await callbacks.on_select(prompt)  # type: ignore
        assert res is None


@pytest.mark.anyio
async def test_login_unknown_provider(capsys):
    with pytest.raises(SystemExit) as excinfo:
        await login("nonexistent")
    assert excinfo.value.code == 1
    captured = capsys.readouterr()
    assert "Unknown provider: nonexistent" in captured.err


@pytest.mark.anyio
async def test_login_success(mock_auth_file):
    mock_provider = mock.MagicMock()
    mock_provider.id = "mock-p"
    mock_provider.name = "Mock Provider"
    mock_provider.login = mock.AsyncMock(return_value={"access": "1234"})

    with mock.patch("pi_mono.ai.cli.get_oauth_provider", return_value=mock_provider):
        await login("mock-p")

    auth = load_auth()
    assert auth["mock-p"] == {"type": "oauth", "access": "1234"}


@pytest.mark.anyio
async def test_login_not_implemented(capsys):
    mock_provider = mock.MagicMock()
    mock_provider.id = "mock-p"
    mock_provider.name = "Mock Provider"
    mock_provider.login = mock.AsyncMock(side_effect=NotImplementedError("not implemented"))

    with mock.patch("pi_mono.ai.cli.get_oauth_provider", return_value=mock_provider):
        with pytest.raises(SystemExit) as excinfo:
            await login("mock-p")
        assert excinfo.value.code == 1
    captured = capsys.readouterr()
    assert "Error: not implemented" in captured.err


@pytest.mark.anyio
async def test_login_exception(capsys):
    mock_provider = mock.MagicMock()
    mock_provider.id = "mock-p"
    mock_provider.name = "Mock Provider"
    mock_provider.login = mock.AsyncMock(side_effect=ValueError("fail"))

    with mock.patch("pi_mono.ai.cli.get_oauth_provider", return_value=mock_provider):
        with pytest.raises(SystemExit) as excinfo:
            await login("mock-p")
        assert excinfo.value.code == 1
    captured = capsys.readouterr()
    assert "Error logging in: fail" in captured.err


@pytest.mark.anyio
async def test_login_cursor_saves_api_key(mock_auth_file):
    await login("cursor", api_key="cursor-sdk-key")

    auth = load_auth()
    assert auth["cursor"] == {"type": "api_key", "key": "cursor-sdk-key"}


@pytest.mark.anyio
async def test_login_cursor_runs_agent_login(mock_auth_file):
    with mock.patch(
        "pi_mono.ai.cli.login_cursor_account", new_callable=mock.AsyncMock
    ) as mock_login:
        await login("cursor")

    mock_login.assert_called_once_with()
    assert load_auth() == {}


@pytest.mark.anyio
async def test_main_help(capsys):
    with mock.patch("sys.argv", ["cli.py", "--help"]):
        await main()
    captured = capsys.readouterr()
    assert "Usage: python -m pi_mono.ai.cli <command> [provider]" in captured.out


@pytest.mark.anyio
async def test_main_list(capsys):
    with mock.patch("sys.argv", ["cli.py", "list"]):
        await main()
    captured = capsys.readouterr()
    assert "Available providers:" in captured.out
    assert "cursor" in captured.out


@pytest.mark.anyio
async def test_main_login_with_provider():
    with mock.patch("sys.argv", ["cli.py", "login", "anthropic"]):
        with mock.patch("pi_mono.ai.cli.login", new_callable=mock.AsyncMock) as mock_login:
            await main()
            mock_login.assert_called_once_with("anthropic", auto_login_method=None)


@pytest.mark.anyio
async def test_main_login_cursor_uses_api_key():
    with mock.patch("sys.argv", ["cli.py", "login", "cursor", "--api-key", "cursor-sdk-key"]):
        with mock.patch("pi_mono.ai.cli.login", new_callable=mock.AsyncMock) as mock_login:
            await main()
            mock_login.assert_called_once_with(
                "cursor",
                auto_login_method=None,
                api_key="cursor-sdk-key",
            )


@pytest.mark.anyio
async def test_main_login_openai_codex_defaults_to_browser():
    with mock.patch("sys.argv", ["cli.py", "login", "openai-codex"]):
        with mock.patch("pi_mono.ai.cli.login", new_callable=mock.AsyncMock) as mock_login:
            await main()
            mock_login.assert_called_once_with(
                "openai-codex",
                auto_login_method="browser",
            )


@pytest.mark.anyio
async def test_main_login_interactive_success():
    p1 = mock.MagicMock()
    p1.id = "p1"
    p1.name = "Provider One"
    p2 = mock.MagicMock()
    p2.id = "p2"
    p2.name = "Provider Two"

    with mock.patch("pi_mono.ai.cli.PROVIDERS", [p1, p2]):
        with mock.patch("sys.argv", ["cli.py", "login"]):
            with mock.patch("builtins.input", return_value="2"):
                with mock.patch("pi_mono.ai.cli.login", new_callable=mock.AsyncMock) as mock_login:
                    await main()
                    mock_login.assert_called_once_with("p2", auto_login_method=None)


@pytest.mark.anyio
async def test_main_login_interactive_invalid_choice(capsys):
    p1 = mock.MagicMock()
    p1.id = "p1"
    p1.name = "Provider One"

    with mock.patch("pi_mono.ai.cli.PROVIDERS", [p1]):
        with mock.patch("sys.argv", ["cli.py", "login"]):
            with mock.patch("builtins.input", return_value="invalid"):
                with pytest.raises(SystemExit) as excinfo:
                    await main()
                assert excinfo.value.code == 1
    captured = capsys.readouterr()
    assert "Invalid selection" in captured.err


@pytest.mark.anyio
async def test_main_login_interactive_out_of_bounds(capsys):
    p1 = mock.MagicMock()
    p1.id = "p1"
    p1.name = "Provider One"

    with mock.patch("pi_mono.ai.cli.PROVIDERS", [p1]):
        with mock.patch("sys.argv", ["cli.py", "login"]):
            with mock.patch("builtins.input", return_value="5"):
                with pytest.raises(SystemExit) as excinfo:
                    await main()
                assert excinfo.value.code == 1
    captured = capsys.readouterr()
    assert "Invalid selection" in captured.err


@pytest.mark.anyio
async def test_main_login_unknown_provider_cmd(capsys):
    with mock.patch("sys.argv", ["cli.py", "login", "invalid"]):
        with pytest.raises(SystemExit) as excinfo:
            await main()
        assert excinfo.value.code == 1
    captured = capsys.readouterr()
    assert "Unknown provider: invalid" in captured.err


@pytest.mark.anyio
async def test_main_unknown_command(capsys):
    with mock.patch("sys.argv", ["cli.py", "foo"]):
        with pytest.raises(SystemExit) as excinfo:
            await main()
        assert excinfo.value.code == 1
    captured = capsys.readouterr()
    assert "Unknown command: foo" in captured.err
