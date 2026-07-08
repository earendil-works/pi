import os
import time
import json
import logging
from typing import Any, Dict, List, Optional, Union, Callable, Awaitable, cast
from pathlib import Path

from pi_mono.ai.env_api_keys import find_env_keys, get_env_api_key
from pi_mono.ai.cursor_agent import is_cursor_agent_authenticated
from pi_mono.ai.oauth import (
    get_oauth_api_key,
    get_oauth_provider,
    get_oauth_providers,
    OAuthCredentials,
    OAuthLoginCallbacks,
    OAuthProviderInterface,
)
from pi_mono.config import get_agent_dir
from pi_mono.core.resolve_config_value import resolve_config_value

logger = logging.getLogger(__name__)

# Lock file write options
AUTH_FILE_WRITE_OPTIONS = {"encoding": "utf-8"}


class FileLock:
    """
    Atomic cross-process file lock using os.open with O_CREAT and O_EXCL.
    Works natively on macOS, Linux, and Windows without external dependencies.
    """

    def __init__(self, lock_path: str):
        self.lock_path = lock_path
        self._fd: Optional[int] = None

    def acquire(self, timeout: float = 10.0, delay: float = 0.1) -> None:
        start = time.time()
        while True:
            try:
                # Atomically create the lock file
                self._fd = os.open(self.lock_path, os.O_CREAT | os.O_EXCL | os.O_WRONLY)
                return
            except FileExistsError:
                if time.time() - start >= timeout:
                    raise TimeoutError(
                        f"Could not acquire lock on {self.lock_path} within {timeout} seconds"
                    )
                time.sleep(delay)

    def release(self) -> None:
        if self._fd is not None:
            try:
                os.close(self._fd)
            except OSError:
                pass
            self._fd = None
        try:
            os.remove(self.lock_path)
        except OSError:
            pass


class AuthStorageBackend:
    def with_lock(self, fn: Callable[[Optional[str]], Dict[str, Any]]) -> Any:
        raise NotImplementedError()

    async def with_lock_async(
        self, fn: Callable[[Optional[str]], Awaitable[Dict[str, Any]]]
    ) -> Any:
        raise NotImplementedError()


class FileAuthStorageBackend(AuthStorageBackend):
    def __init__(self, auth_path: Optional[Union[str, Path]] = None) -> None:
        if auth_path is None:
            auth_path = Path(get_agent_dir()) / "auth.json"
        self.auth_path = Path(auth_path).resolve()
        self.lock_path = self.auth_path.with_suffix(".json.lock")

    def _ensure_parent_dir(self) -> None:
        parent = self.auth_path.parent
        parent.mkdir(parents=True, exist_ok=True)
        try:
            parent.chmod(0o700)
        except OSError:
            pass

    def _ensure_file_exists(self) -> None:
        if not self.auth_path.exists():
            with open(self.auth_path, "w", encoding="utf-8") as f:
                f.write("{}")
            try:
                self.auth_path.chmod(0o600)
            except OSError:
                pass

    def with_lock(self, fn: Callable[[Optional[str]], Dict[str, Any]]) -> Any:
        self._ensure_parent_dir()
        self._ensure_file_exists()

        lock = FileLock(str(self.lock_path))
        lock.acquire(timeout=5.0)
        try:
            current = None
            if self.auth_path.exists():
                try:
                    with open(self.auth_path, "r", encoding="utf-8") as f:
                        current = f.read()
                except Exception:
                    pass

            res = fn(current)
            result = res.get("result")
            if "next" in res:
                next_val = res["next"]
                with open(self.auth_path, "w", encoding="utf-8") as f:
                    f.write(next_val)
                try:
                    self.auth_path.chmod(0o600)
                except OSError:
                    pass
            return result
        finally:
            lock.release()

    async def with_lock_async(
        self, fn: Callable[[Optional[str]], Awaitable[Dict[str, Any]]]
    ) -> Any:
        self._ensure_parent_dir()
        self._ensure_file_exists()

        lock = FileLock(str(self.lock_path))
        lock.acquire(timeout=10.0)
        try:
            current = None
            if self.auth_path.exists():
                try:
                    with open(self.auth_path, "r", encoding="utf-8") as f:
                        current = f.read()
                except Exception:
                    pass

            res = await fn(current)
            result = res.get("result")
            if "next" in res:
                next_val = res["next"]
                with open(self.auth_path, "w", encoding="utf-8") as f:
                    f.write(next_val)
                try:
                    self.auth_path.chmod(0o600)
                except OSError:
                    pass
            return result
        finally:
            lock.release()


class InMemoryAuthStorageBackend(AuthStorageBackend):
    def __init__(self) -> None:
        self.value: Optional[str] = None

    def with_lock(self, fn: Callable[[Optional[str]], Dict[str, Any]]) -> Any:
        res = fn(self.value)
        if "next" in res:
            self.value = res["next"]
        return res.get("result")

    async def with_lock_async(
        self, fn: Callable[[Optional[str]], Awaitable[Dict[str, Any]]]
    ) -> Any:
        res = await fn(self.value)
        if "next" in res:
            self.value = res["next"]
        return res.get("result")


class AuthStorage:
    def __init__(self, storage: AuthStorageBackend) -> None:
        self.storage = storage
        self.data: Dict[str, Any] = {}
        self.runtime_overrides: Dict[str, str] = {}
        self.fallback_resolver: Optional[Callable[[str], Optional[str]]] = None
        self.load_error: Optional[Exception] = None
        self.errors: List[Exception] = []
        self.reload()

    @classmethod
    def create(cls, auth_path: Optional[Union[str, Path]] = None) -> "AuthStorage":
        return cls(FileAuthStorageBackend(auth_path))

    @classmethod
    def from_storage(cls, storage: AuthStorageBackend) -> "AuthStorage":
        return cls(storage)

    @classmethod
    def in_memory(cls, data: Optional[Dict[str, Any]] = None) -> "AuthStorage":
        backend = InMemoryAuthStorageBackend()
        backend.with_lock(
            lambda current: {"result": None, "next": json.dumps(data or {}, indent=2)}
        )
        return cls(backend)

    def set_runtime_api_key(self, provider: str, api_key: str) -> None:
        self.runtime_overrides[provider] = api_key

    def remove_runtime_api_key(self, provider: str) -> None:
        self.runtime_overrides.pop(provider, None)

    def set_fallback_resolver(self, resolver: Callable[[str], Optional[str]]) -> None:
        self.fallback_resolver = resolver

    def record_error(self, error: Any) -> None:
        normalized = error if isinstance(error, Exception) else Exception(str(error))
        self.errors.append(normalized)

    def parse_storage_data(self, content: Optional[str]) -> Dict[str, Any]:
        if not content:
            return {}
        try:
            return json.loads(content)
        except Exception:
            return {}

    def reload(self) -> None:
        try:
            content = self.storage.with_lock(lambda current: {"result": current})
            self.data = self.parse_storage_data(content)
            self.load_error = None
        except Exception as e:
            self.load_error = e
            self.record_error(e)

    def _persist_provider_change(self, provider: str, credential: Optional[Dict[str, Any]]) -> None:
        if self.load_error:
            return
        try:

            def update_fn(current: Optional[str]) -> Dict[str, Any]:
                current_data = self.parse_storage_data(current)
                merged = {**current_data}
                if credential is not None:
                    merged[provider] = credential
                else:
                    merged.pop(provider, None)
                return {"result": None, "next": json.dumps(merged, indent=2)}

            self.storage.with_lock(update_fn)
        except Exception as e:
            self.record_error(e)

    def get(self, provider: str) -> Optional[Dict[str, Any]]:
        return self.data.get(provider)

    def get_provider_env(self, provider: str) -> dict[str, str] | None:
        cred = self.data.get(provider)
        if cred and cred.get("type") == "api_key" and cred.get("env"):
            env = cred.get("env")
            if isinstance(env, dict):
                return {str(key): str(value) for key, value in env.items()}
        return None

    def set(self, provider: str, credential: Dict[str, Any]) -> None:
        self.data[provider] = credential
        self._persist_provider_change(provider, credential)

    def remove(self, provider: str) -> None:
        self.data.pop(provider, None)
        self._persist_provider_change(provider, None)

    def list(self) -> List[str]:
        return list(self.data.keys())

    def has(self, provider: str) -> bool:
        return provider in self.data

    def has_auth(self, provider: str) -> bool:
        if provider in self.runtime_overrides:
            return True
        if provider == "cursor" and get_env_api_key(provider) is not None:
            return True
        if provider in self.data:
            if provider == "cursor":
                cred_type = self.data[provider].get("type")
                if cred_type == "api_key":
                    return True
                return is_cursor_agent_authenticated()
            return True
        if get_env_api_key(provider) is not None:
            return True
        if provider == "cursor":
            return is_cursor_agent_authenticated()
        if self.fallback_resolver and self.fallback_resolver(provider) is not None:
            return True
        return False

    def get_auth_status(self, provider: str) -> Dict[str, Any]:
        if provider in self.runtime_overrides:
            return {"configured": False, "source": "runtime", "label": "--api-key"}

        if provider == "cursor":
            env_keys = find_env_keys(provider)
            if env_keys and len(env_keys) > 0:
                return {"configured": False, "source": "environment", "label": env_keys[0]}
            if is_cursor_agent_authenticated():
                return {"configured": True, "source": "cursor_cli", "label": "agent status"}

        if provider in self.data:
            if provider == "cursor":
                if is_cursor_agent_authenticated():
                    return {"configured": True, "source": "cursor_cli", "label": "agent status"}
                cred_type = self.data[provider].get("type")
                if cred_type == "api_key":
                    return {"configured": True, "source": "stored"}
                return {"configured": False}
            return {"configured": True, "source": "stored"}

        env_keys = find_env_keys(provider)
        if env_keys and len(env_keys) > 0:
            return {"configured": False, "source": "environment", "label": env_keys[0]}

        if provider == "cursor" and is_cursor_agent_authenticated():
            return {"configured": True, "source": "cursor_cli", "label": "agent status"}

        if self.fallback_resolver and self.fallback_resolver(provider) is not None:
            return {"configured": False, "source": "fallback", "label": "custom provider config"}

        return {"configured": False}

    def get_all(self) -> Dict[str, Any]:
        return {**self.data}

    def drain_errors(self) -> List[Exception]:
        drained = list(self.errors)
        self.errors.clear()
        return drained

    async def login(self, provider_id: str, callbacks: OAuthLoginCallbacks) -> None:
        provider = get_oauth_provider(provider_id)
        if not provider:
            raise ValueError(f"Unknown OAuth provider: {provider_id}")

        credentials = await provider.login(callbacks)
        self.set(provider_id, {"type": "oauth", **credentials})

    def logout(self, provider: str) -> None:
        self.remove(provider)

    async def _refresh_oauth_token_with_lock(self, provider_id: str) -> Optional[Dict[str, Any]]:
        provider = get_oauth_provider(provider_id)
        if not provider:
            return None

        async def lock_fn(current: Optional[str]) -> Dict[str, Any]:
            current_data = self.parse_storage_data(current)
            self.data = current_data
            self.load_error = None

            cred = current_data.get(provider_id)
            if not cred or cred.get("type") != "oauth":
                return {"result": None}

            expires = cred.get("expires")
            if expires is not None and int(time.time() * 1000) < expires:
                # Not expired
                return {"result": {"apiKey": provider.get_api_key(cred), "newCredentials": cred}}

            oauth_creds: Dict[str, OAuthCredentials] = {}
            for k, v in current_data.items():
                if isinstance(v, dict) and v.get("type") == "oauth":
                    oauth_creds[k] = cast(OAuthCredentials, v)

            refreshed = await get_oauth_api_key(provider_id, oauth_creds)
            if not refreshed:
                return {"result": None}

            merged = {**current_data, provider_id: {"type": "oauth", **refreshed["newCredentials"]}}
            self.data = merged
            self.load_error = None
            return {"result": refreshed, "next": json.dumps(merged, indent=2)}

        return await self.storage.with_lock_async(lock_fn)

    async def get_api_key(
        self, provider_id: str, options: Optional[Dict[str, Any]] = None
    ) -> Optional[str]:
        opts = options or {}
        runtime_key = self.runtime_overrides.get(provider_id)
        if runtime_key:
            return runtime_key

        if provider_id == "cursor":
            env_key = get_env_api_key(provider_id)
            if env_key is not None:
                return env_key

            if is_cursor_agent_authenticated():
                return None

        cred = self.data.get(provider_id)
        if cred:
            if cred.get("type") == "api_key":
                if provider_id == "cursor" and is_cursor_agent_authenticated():
                    return None
                return resolve_config_value(cred.get("key", ""))

            if cred.get("type") == "oauth":
                provider = get_oauth_provider(provider_id)
                if not provider:
                    return None

                expires = cred.get("expires")
                needs_refresh = expires is not None and int(time.time() * 1000) >= expires

                if needs_refresh:
                    try:
                        result = await self._refresh_oauth_token_with_lock(provider_id)
                        if result:
                            return result["apiKey"]
                    except Exception as e:
                        self.record_error(e)
                        self.reload()
                        updated = self.data.get(provider_id)
                        u_expires = updated.get("expires") if updated else None
                        if (
                            updated
                            and updated.get("type") == "oauth"
                            and u_expires is not None
                            and int(time.time() * 1000) < u_expires
                        ):
                            return provider.get_api_key(updated)
                        return None
                else:
                    return provider.get_api_key(cred)

        env_key = get_env_api_key(provider_id)
        if env_key is not None:
            return env_key

        if opts.get("includeFallback", True) is not False:
            if self.fallback_resolver:
                return self.fallback_resolver(provider_id)

        return None

    def get_oauth_providers(self) -> List[OAuthProviderInterface]:
        return get_oauth_providers()
