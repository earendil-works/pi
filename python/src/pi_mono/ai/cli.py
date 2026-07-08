import sys
import json
import asyncio
from typing import Any, Dict, Optional

from pi_mono.ai.oauth import (
    get_oauth_provider,
    get_oauth_providers,
    OAuthLoginCallbacks,
    OAuthAuthInfo,
    OAuthDeviceCodeInfo,
    OAuthPrompt,
    OAuthSelectPrompt,
)
from pi_mono.ai.cursor_agent import login_cursor_account
from pi_mono.ai.utils.oauth.openai_codex import (
    OPENAI_CODEX_BROWSER_LOGIN_METHOD,
    OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD,
)
from pi_mono.config import get_auth_path
from pi_mono.utils.open_browser import open_browser

PROVIDERS = get_oauth_providers()


def load_auth() -> Dict[str, Any]:
    auth_file = get_auth_path()
    if not auth_file.exists():
        return {}
    try:
        with open(auth_file, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_auth(auth: Dict[str, Any]) -> None:
    auth_file = get_auth_path()
    auth_file.parent.mkdir(parents=True, exist_ok=True)
    try:
        with open(auth_file, "w", encoding="utf-8") as f:
            json.dump(auth, f, indent=2)
    except Exception as e:
        print(f"Error saving credentials: {e}", file=sys.stderr)


class ConsoleOAuthCallbacks(OAuthLoginCallbacks):
    def __init__(self, *, auto_login_method: str | None = None) -> None:
        self._auto_login_method = auto_login_method

    def on_auth(self, info: OAuthAuthInfo) -> None:
        url = info.get("url", "")
        print(f"\nOpen this URL in your browser:\n{url}")
        if info.get("instructions"):
            print(info["instructions"])
        if url:
            open_browser(url)
        print()

    def on_device_code(self, info: OAuthDeviceCodeInfo) -> None:
        verification_uri = info.get("verificationUri", "")
        print(f"\nOpen this URL in your browser:\n{verification_uri}")
        print(f"Enter code: {info.get('userCode')}")
        if verification_uri:
            open_browser(verification_uri)
        print()

    async def on_prompt(self, p: OAuthPrompt) -> str:
        placeholder = f" ({p['placeholder']})" if p.get("placeholder") else ""
        prompt_str = f"{p['message']}{placeholder}: "
        loop = asyncio.get_running_loop()
        return await loop.run_in_executor(None, input, prompt_str)

    async def on_manual_code_input(self) -> str:
        loop = asyncio.get_running_loop()
        print("\nPaste redirect URL below, or complete login in browser:")
        return await loop.run_in_executor(None, input, "> ")

    def on_progress(self, message: str) -> None:
        print(message)

    async def on_select(self, p: OAuthSelectPrompt) -> Optional[str]:
        if self._auto_login_method is not None:
            return self._auto_login_method

        print(f"\n{p['message']}")
        for i, option in enumerate(p["options"]):
            print(f"  {i + 1}. {option['label']}")

        loop = asyncio.get_running_loop()
        choice = await loop.run_in_executor(None, input, f"Enter number (1-{len(p['options'])}): ")
        try:
            index = int(choice) - 1
            if 0 <= index < len(p["options"]):
                return p["options"][index]["id"]
        except ValueError:
            pass
        return None


def _auto_login_method_for_provider(provider_id: str, args: list[str]) -> str | None:
    if "--device-code" in args:
        return OPENAI_CODEX_DEVICE_CODE_LOGIN_METHOD
    if provider_id != "openai-codex":
        return None
    return OPENAI_CODEX_BROWSER_LOGIN_METHOD


async def login(
    provider_id: str,
    *,
    auto_login_method: str | None = None,
    api_key: str | None = None,
) -> None:
    if provider_id == "cursor" and api_key is not None:
        api_key = api_key.strip()
        if not api_key:
            print("Error: Cursor SDK API key cannot be empty.", file=sys.stderr)
            sys.exit(1)

        auth = load_auth()
        auth[provider_id] = {"type": "api_key", "key": api_key}
        save_auth(auth)
        print(f"\nCredentials saved to {get_auth_path()}")
        return

    if provider_id == "cursor":
        try:
            await login_cursor_account()
            print("Cursor login completed via agent CLI.")
            return
        except FileNotFoundError:
            print(
                "Error: Cursor Agent CLI not found. Install `agent` or set CURSOR_AGENT_PATH.",
                file=sys.stderr,
            )
            sys.exit(1)
        except Exception as e:
            print(f"\nError logging in to Cursor: {e}", file=sys.stderr)
            sys.exit(1)

    provider = get_oauth_provider(provider_id)
    if not provider:
        print(f"Unknown provider: {provider_id}", file=sys.stderr)
        sys.exit(1)

    try:
        callbacks = ConsoleOAuthCallbacks(auto_login_method=auto_login_method)
        credentials = await provider.login(callbacks)

        auth = load_auth()
        auth[provider_id] = {"type": "oauth", **credentials}
        save_auth(auth)

        print(f"\nCredentials saved to {get_auth_path()}")
    except NotImplementedError as e:
        print(f"\nError: {e}", file=sys.stderr)
        sys.exit(1)
    except Exception as e:
        print(f"\nError logging in: {e}", file=sys.stderr)
        sys.exit(1)


async def main() -> None:
    args = sys.argv[1:]
    command = args[0] if len(args) > 0 else None

    if not command or command in ("help", "--help", "-h"):
        provider_list = "\n".join(f"  {p.id:<20} {p.name}" for p in PROVIDERS)
        print(
            f"""Usage: python -m pi_mono.ai.cli <command> [provider]

Commands:
  login [provider]  Login to a provider
  list              List available providers

Providers:
{provider_list}

Examples:
  python -m pi_mono.ai.cli login              # interactive provider selection
  python -m pi_mono.ai.cli login anthropic    # login to specific provider
  python -m pi_mono.ai.cli login openai-codex # browser login (ChatGPT Plus/Pro)
  python -m pi_mono.ai.cli login openai-codex --device-code
  python -m pi_mono.ai.cli login cursor       # run `agent login`
  python -m pi_mono.ai.cli login cursor --api-key \"$CURSOR_API_KEY\"
  python -m pi_mono.ai.cli list               # list providers
"""
        )
        return

    if command == "list":
        print("Available providers:\n")
        for p in PROVIDERS:
            print(f"  {p.id:<20} {p.name}")
        return

    if command == "login":
        provider = args[1] if len(args) > 1 and not args[1].startswith("-") else None
        login_args = args[2:] if provider else args[1:]

        if not provider:
            print("Select a provider:\n")
            for i, p in enumerate(PROVIDERS):
                print(f"  {i + 1}. {p.name}")
            print()

            loop = asyncio.get_running_loop()
            choice = await loop.run_in_executor(None, input, f"Enter number (1-{len(PROVIDERS)}): ")
            try:
                index = int(choice) - 1
                if 0 <= index < len(PROVIDERS):
                    provider = PROVIDERS[index].id
                else:
                    print("Invalid selection", file=sys.stderr)
                    sys.exit(1)
            except ValueError:
                print("Invalid selection", file=sys.stderr)
                sys.exit(1)

        if provider != "cursor" and not any(p.id == provider for p in PROVIDERS):
            print(f"Unknown provider: {provider}", file=sys.stderr)
            print("Use 'python -m pi_mono.ai.cli list' to see available providers", file=sys.stderr)
            sys.exit(1)

        api_key = None
        if provider == "cursor" and "--api-key" in login_args:
            api_key_index = login_args.index("--api-key")
            if api_key_index + 1 >= len(login_args):
                print("Missing value for --api-key", file=sys.stderr)
                sys.exit(1)
            api_key = login_args[api_key_index + 1]

        auto_login_method = _auto_login_method_for_provider(provider, login_args)
        print(f"Logging in to {provider}...")
        if api_key is not None:
            await login(provider, auto_login_method=auto_login_method, api_key=api_key)
        else:
            await login(provider, auto_login_method=auto_login_method)
        return

    print(f"Unknown command: {command}", file=sys.stderr)
    print("Use 'python -m pi_mono.ai.cli --help' for usage", file=sys.stderr)
    sys.exit(1)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        print("\nAborted.")
        sys.exit(1)
    except Exception as err:
        print(f"Error: {err}", file=sys.stderr)
        sys.exit(1)
