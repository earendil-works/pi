"""Extension loader - discovers and loads Python extension modules."""

from __future__ import annotations

import importlib.util
import json
import os
import sys
from typing import Any

from pi_mono.config import CONFIG_DIR_NAME, get_agent_dir
from pi_mono.core.event_bus import EventBusController, create_event_bus
from pi_mono.coding_agent.core.exec import exec_command
from pi_mono.coding_agent.core.extensions.types import (
    Extension,
    ExtensionFactory,
    ExtensionRuntime,
    HandlerFn,
    LoadExtensionsResult,
    ProviderConfig,
    RegisteredCommand,
    ToolDefinition,
)
from pi_mono.coding_agent.core.source_info import create_synthetic_source_info
from pi_mono.core.settings_manager import SettingsManager
from pi_mono.utils.paths import resolve_path


def create_extension_runtime() -> ExtensionRuntime:
    runtime = ExtensionRuntime()

    def not_initialized(*_args: Any, **_kwargs: Any) -> None:
        raise RuntimeError(
            "Extension runtime not initialized. Action methods cannot be called during extension loading."
        )

    async def not_initialized_async(*_args: Any, **_kwargs: Any) -> bool:
        raise RuntimeError(
            "Extension runtime not initialized. Action methods cannot be called during extension loading."
        )

    runtime.send_message = not_initialized
    runtime.send_user_message = not_initialized
    runtime.append_entry = not_initialized
    runtime.set_session_name = not_initialized
    runtime.get_session_name = lambda: (_ for _ in ()).throw(
        RuntimeError("Extension runtime not initialized.")
    )
    runtime.set_label = not_initialized
    runtime.get_active_tools = lambda: (_ for _ in ()).throw(
        RuntimeError("Extension runtime not initialized.")
    )
    runtime.get_all_tools = lambda: (_ for _ in ()).throw(
        RuntimeError("Extension runtime not initialized.")
    )
    runtime.set_active_tools = not_initialized
    runtime.refresh_tools = lambda: None
    runtime.get_commands = lambda: (_ for _ in ()).throw(
        RuntimeError("Extension runtime not initialized.")
    )
    runtime.set_model = not_initialized_async
    runtime.get_thinking_level = lambda: (_ for _ in ()).throw(
        RuntimeError("Extension runtime not initialized.")
    )
    runtime.set_thinking_level = not_initialized
    return runtime


class _ExtensionAPI:
    def __init__(
        self,
        extension: Extension,
        runtime: ExtensionRuntime,
        cwd: str,
        event_bus: EventBusController,
    ) -> None:
        self._extension = extension
        self._runtime = runtime
        self._cwd = cwd
        self._event_bus = event_bus

    def on(self, event: str, handler: HandlerFn) -> None:
        self._runtime.assert_active()
        handlers = self._extension.handlers.setdefault(event, [])
        handlers.append(handler)

    def register_tool(self, tool: ToolDefinition) -> None:
        self._runtime.assert_active()
        from pi_mono.coding_agent.core.extensions.types import RegisteredTool

        self._extension.tools[tool.name] = RegisteredTool(
            definition=tool,
            source_info=self._extension.source_info,
        )
        self._runtime.refresh_tools()

    def register_command(self, name: str, options: dict[str, Any]) -> None:
        self._runtime.assert_active()
        self._extension.commands[name] = RegisteredCommand(
            name=name,
            source_info=self._extension.source_info,
            handler=options["handler"],
            description=options.get("description"),
        )

    def register_shortcut(self, shortcut: str, options: dict[str, Any]) -> None:
        self._runtime.assert_active()
        from pi_mono.coding_agent.core.extensions.types import ExtensionShortcut

        self._extension.shortcuts[shortcut] = ExtensionShortcut(
            shortcut=shortcut,
            extension_path=self._extension.path,
            description=options.get("description"),
            handler=options.get("handler"),
        )

    def register_flag(self, name: str, options: dict[str, Any]) -> None:
        self._runtime.assert_active()
        from pi_mono.coding_agent.core.extensions.types import ExtensionFlag

        flag = ExtensionFlag(
            name=name,
            extension_path=self._extension.path,
            description=options.get("description"),
            type=options.get("type", "boolean"),
            default=options.get("default"),
        )
        self._extension.flags[name] = flag
        if options.get("default") is not None and name not in self._runtime.flag_values:
            self._runtime.flag_values[name] = options["default"]

    def register_message_renderer(self, custom_type: str, renderer: Any) -> None:
        self._runtime.assert_active()
        self._extension.message_renderers[custom_type] = renderer

    def register_entry_renderer(self, custom_type: str, renderer: Any) -> None:
        self._runtime.assert_active()
        self._extension.entry_renderers[custom_type] = renderer

    def get_flag(self, name: str) -> bool | str | None:
        self._runtime.assert_active()
        if name not in self._extension.flags:
            return None
        return self._runtime.flag_values.get(name)

    def send_message(self, message: dict[str, Any], options: dict[str, Any] | None = None) -> None:
        self._runtime.assert_active()
        self._runtime.send_message(message, options)

    def send_user_message(
        self,
        content: str | list[dict[str, Any]],
        options: dict[str, Any] | None = None,
    ) -> None:
        self._runtime.assert_active()
        self._runtime.send_user_message(content, options)

    def append_entry(self, custom_type: str, data: Any = None) -> None:
        self._runtime.assert_active()
        self._runtime.append_entry(custom_type, data)

    def set_session_name(self, name: str) -> None:
        self._runtime.assert_active()
        self._runtime.set_session_name(name)

    def get_session_name(self) -> str | None:
        self._runtime.assert_active()
        return self._runtime.get_session_name()

    def set_label(self, entry_id: str, label: str | None) -> None:
        self._runtime.assert_active()
        self._runtime.set_label(entry_id, label)

    async def exec(
        self,
        command: str,
        args: list[str],
        options: dict[str, Any] | None = None,
    ) -> Any:
        self._runtime.assert_active()
        cwd = (options or {}).get("cwd") or self._cwd
        return await exec_command(command, args, cwd, options)  # type: ignore[arg-type]

    def get_active_tools(self) -> list[str]:
        self._runtime.assert_active()
        return self._runtime.get_active_tools()

    def get_all_tools(self) -> list[dict[str, Any]]:
        self._runtime.assert_active()
        return self._runtime.get_all_tools()

    def set_active_tools(self, tool_names: list[str]) -> None:
        self._runtime.assert_active()
        self._runtime.set_active_tools(tool_names)

    def get_commands(self) -> list[Any]:
        self._runtime.assert_active()
        return self._runtime.get_commands()

    async def set_model(self, model: Any) -> bool:
        self._runtime.assert_active()
        return await self._runtime.set_model(model)

    def get_thinking_level(self) -> str:
        self._runtime.assert_active()
        return self._runtime.get_thinking_level()

    def set_thinking_level(self, level: str) -> None:
        self._runtime.assert_active()
        self._runtime.set_thinking_level(level)

    def register_provider(self, name: str, config: ProviderConfig) -> None:
        self._runtime.assert_active()
        self._runtime.register_provider(name, config, self._extension.path)

    def unregister_provider(self, name: str) -> None:
        self._runtime.assert_active()
        self._runtime.unregister_provider(name, self._extension.path)

    @property
    def events(self) -> EventBusController:
        return self._event_bus


def _create_extension(extension_path: str, resolved_path: str) -> Extension:
    if extension_path.startswith("<") and extension_path.endswith(">"):
        source = extension_path[1:-1].split(":")[0] or "temporary"
        base_dir = None
    else:
        source = "local"
        base_dir = os.path.dirname(resolved_path)
    return Extension(
        path=extension_path,
        resolved_path=resolved_path,
        source_info=create_synthetic_source_info(extension_path, source=source, base_dir=base_dir),
    )


def _load_extension_module(extension_path: str) -> ExtensionFactory | None:
    module_name = f"pi_extension_{abs(hash(extension_path))}"
    spec = importlib.util.spec_from_file_location(module_name, extension_path)
    if spec is None or spec.loader is None:
        return None
    module = importlib.util.module_from_spec(spec)
    sys.modules[module_name] = module
    spec.loader.exec_module(module)
    factory = getattr(module, "default", None) or getattr(module, "factory", None)
    if callable(factory):
        return factory
    if callable(module):
        return module  # type: ignore[return-value]
    return None


async def load_extension(
    extension_path: str,
    cwd: str,
    event_bus: EventBusController,
    runtime: ExtensionRuntime,
) -> tuple[Extension | None, str | None]:
    resolved_path = resolve_path(extension_path, cwd)
    try:
        factory = _load_extension_module(resolved_path)
        if factory is None:
            return None, f"Extension does not export a valid factory function: {extension_path}"
        extension = _create_extension(extension_path, resolved_path)
        api = _ExtensionAPI(extension, runtime, cwd, event_bus)
        result = factory(api)
        if hasattr(result, "__await__"):
            await result
        return extension, None
    except Exception as err:
        return None, f"Failed to load extension: {err}"


async def load_extension_from_factory(
    factory: ExtensionFactory,
    cwd: str,
    event_bus: EventBusController,
    runtime: ExtensionRuntime,
    extension_path: str = "<inline>",
) -> Extension:
    extension = _create_extension(extension_path, extension_path)
    api = _ExtensionAPI(extension, runtime, resolve_path(cwd), event_bus)
    result = factory(api)
    if hasattr(result, "__await__"):
        await result
    return extension


async def load_extensions(
    paths: list[str],
    cwd: str,
    event_bus: EventBusController | None = None,
) -> LoadExtensionsResult:
    extensions: list[Extension] = []
    errors: list[dict[str, str]] = []
    resolved_cwd = resolve_path(cwd)
    resolved_event_bus = event_bus or create_event_bus()
    runtime = create_extension_runtime()

    for ext_path in paths:
        extension, error = await load_extension(ext_path, resolved_cwd, resolved_event_bus, runtime)
        if error:
            errors.append({"path": ext_path, "error": error})
            continue
        if extension is not None:
            extensions.append(extension)

    return LoadExtensionsResult(extensions=extensions, errors=errors, runtime=runtime)


def _read_pi_manifest(package_json_path: str) -> dict[str, Any] | None:
    try:
        with open(package_json_path, encoding="utf-8") as handle:
            pkg = json.load(handle)
        pi_manifest = pkg.get("pi")
        return pi_manifest if isinstance(pi_manifest, dict) else None
    except (OSError, json.JSONDecodeError):
        return None


def _is_extension_file(name: str) -> bool:
    return name.endswith((".py", ".ts", ".js"))


def _resolve_extension_entries(directory: str) -> list[str] | None:
    package_json_path = os.path.join(directory, "package.json")
    if os.path.exists(package_json_path):
        manifest = _read_pi_manifest(package_json_path)
        extensions = manifest.get("extensions") if manifest else None
        if isinstance(extensions, list) and extensions:
            entries: list[str] = []
            for ext_path in extensions:
                resolved_ext_path = os.path.abspath(os.path.join(directory, str(ext_path)))
                if os.path.exists(resolved_ext_path):
                    entries.append(resolved_ext_path)
            if entries:
                return entries

    index_py = os.path.join(directory, "__init__.py")
    index_ts = os.path.join(directory, "index.ts")
    index_js = os.path.join(directory, "index.js")
    if os.path.exists(index_py):
        return [index_py]
    if os.path.exists(index_ts):
        return [index_ts]
    if os.path.exists(index_js):
        return [index_js]
    return None


def discover_extensions_in_dir(directory: str) -> list[str]:
    if not os.path.isdir(directory):
        return []

    discovered: list[str] = []
    try:
        for entry in os.listdir(directory):
            entry_path = os.path.join(directory, entry)
            if os.path.isfile(entry_path) or os.path.islink(entry_path):
                if _is_extension_file(entry):
                    if entry.endswith(".py") or entry.endswith((".ts", ".js")):
                        discovered.append(entry_path)
                continue
            if os.path.isdir(entry_path) or os.path.islink(entry_path):
                entries = _resolve_extension_entries(entry_path)
                if entries:
                    discovered.extend(entries)
    except OSError:
        return []
    return discovered


async def collect_configured_extension_paths(
    cwd: str,
    agent_dir: str,
    settings_manager: SettingsManager,
    additional_paths: list[str] | None = None,
) -> list[str]:
    from pi_mono.coding_agent.core.package_manager import DefaultPackageManager

    resolved_cwd = resolve_path(cwd)
    resolved_agent_dir = resolve_path(agent_dir)
    paths: list[str] = list(additional_paths or [])
    seen: set[str] = set()

    def add_path(path: str) -> None:
        resolved = os.path.abspath(resolve_path(path, resolved_cwd))
        if resolved in seen:
            return
        seen.add(resolved)
        paths.append(path)

    package_manager = DefaultPackageManager(
        cwd=resolved_cwd,
        agent_dir=resolved_agent_dir,
        settings_manager=settings_manager,
    )
    resolved = await package_manager.resolve()
    for resource in resolved["extensions"]:
        if resource.get("enabled", True):
            add_path(str(resource["path"]))

    for path in settings_manager.get_extension_paths():
        add_path(path)

    return paths


async def discover_and_load_extensions(
    configured_paths: list[str],
    cwd: str,
    agent_dir: str | None = None,
    event_bus: EventBusController | None = None,
) -> LoadExtensionsResult:
    resolved_cwd = resolve_path(cwd)
    resolved_agent_dir = resolve_path(agent_dir or str(get_agent_dir()))
    all_paths: list[str] = []
    seen: set[str] = set()

    def add_paths(paths: list[str]) -> None:
        for path in paths:
            resolved = os.path.abspath(path)
            if resolved not in seen:
                seen.add(resolved)
                all_paths.append(path)

    local_ext_dir = os.path.join(resolved_cwd, CONFIG_DIR_NAME, "extensions")
    add_paths(discover_extensions_in_dir(local_ext_dir))

    global_ext_dir = os.path.join(resolved_agent_dir, "extensions")
    add_paths(discover_extensions_in_dir(global_ext_dir))

    for path in configured_paths:
        resolved = resolve_path(path, resolved_cwd)
        if os.path.isdir(resolved):
            entries = _resolve_extension_entries(resolved)
            if entries:
                add_paths(entries)
                continue
            add_paths(discover_extensions_in_dir(resolved))
            continue
        add_paths([resolved])

    python_paths = [path for path in all_paths if path.endswith(".py")]
    ts_js_paths = [path for path in all_paths if path.endswith((".ts", ".js", ".mts", ".mjs"))]
    result = await load_extensions(python_paths, resolved_cwd, event_bus)
    if not ts_js_paths:
        return result

    from pi_mono.coding_agent.core.extensions.ts_extension_loader import load_ts_extensions

    extensions, errors = await load_ts_extensions(
        ts_js_paths,
        resolved_cwd,
        event_bus,
        existing_extensions=result.extensions,
        existing_errors=result.errors,
    )
    return LoadExtensionsResult(extensions=extensions, errors=errors, runtime=result.runtime)
