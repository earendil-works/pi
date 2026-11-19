"""Invoke the existing Pi source runner with evaluation-scoped process state."""

from __future__ import annotations

import asyncio
import base64
import hashlib
import json
import os
import shutil
import sys
from pathlib import Path
from typing import Any

from .data import PROTOCOL, TaskInput
from .runtime import NODE, log_tail, prepare_checkout, stop_process


# Base64 grows files by a third and must fit Beaker's 32 MiB execution envelope with the rest of
# the case result (16k-character response, manifest, stats), so 24 MiB less 128 KiB is the ceiling.
MAX_DELIVERABLE_BYTES = 24 * 1024 * 1024 - 128 * 1024


PROVIDER_KEYS = {"openai": "OPENAI_API_KEY", "openrouter": "OPENROUTER_API_KEY"}


def rollout_model(model: str | None = None) -> tuple[str, str]:
    """Resolve the provider and model ID from the launch override or protocol default."""
    selected = PROTOCOL["agent_model"] if model is None else model
    provider, separator, model_id = selected.strip().partition(":")
    if not separator:
        provider, model_id = "openai", provider
    if provider not in PROVIDER_KEYS or not model_id.strip():
        raise ValueError("Pi JobBench rollouts require an openai: or openrouter: model ID; a bare ID means OpenAI")
    return provider, model_id.strip()


async def run_task(
    task: TaskInput, *, inputs: Path, root: Path, run_dir: Path, model: str | None = None,
) -> dict[str, Any]:
    """Run the selected model and retain files outside the source tree."""
    provider, model_id = rollout_model(model)
    key_name = PROVIDER_KEYS[provider]
    if os.name != "posix":
        raise RuntimeError("The local JobBench evaluator currently requires Linux or macOS")
    if not os.environ.get(key_name, "").strip():
        raise RuntimeError(f"{key_name} is required for local candidate execution")
    entry_dir = root / "packages/coding-agent/src/experimental"
    if not (entry_dir / "local-runner-cli.ts").is_file():
        raise RuntimeError(f"No candidate Pi source checkout at {root}")
    workspace = run_dir / "workspace"
    workspace.mkdir(parents=True, exist_ok=False)
    shutil.copytree(inputs / "task_folder", workspace / "task_folder")
    (workspace / "output").mkdir()
    (workspace / "scratch").mkdir()
    agent_dir = run_dir / "home/.pi/agent"
    agent_dir.mkdir(parents=True)
    (agent_dir / "settings.json").write_text(json.dumps({
        "defaultThinkingLevel": PROTOCOL["thinking_level"],
    }), encoding="utf-8")
    # Separate configuration and sessions, without imposing a filesystem sandbox.
    allowed = {
        "PATH", "LANG", "LC_ALL", "TMPDIR", key_name, "HTTP_PROXY", "HTTPS_PROXY", "NO_PROXY",
        "http_proxy", "https_proxy", "no_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
        "SYSTEMROOT", "SystemRoot",
    }
    env = {key: value for key, value in os.environ.items() if key in allowed}
    env["PATH"] = os.pathsep.join((str(NODE.parent), str(Path(sys.executable).parent), env.get("PATH", os.defpath)))
    env.update(HOME=str(run_dir / "home"), PI_CODING_AGENT_DIR=str(agent_dir))
    await prepare_checkout(root, run_dir=run_dir, env=env)
    # Verbatim prompt of upstream eval/run_benchmark_{codex_cli,claude_code_cli,opencode}.sh.
    task_folder, output = workspace / "task_folder", workspace / "output"
    prompt = f"""=== TASK FOLDER ===
{task_folder}

=== INSTRUCTIONS ===
1. Read the TASK_INSTRUCTIONS.txt file in the task folder above
2. Based on the Reference Files section in TASK_INSTRUCTIONS.txt, read the corresponding files from the same task folder using appropriate tools.
3. Complete the task as specified in TASK_INSTRUCTIONS.txt
4. Only save the final deliverables to the output directory specified below. Do not save any intermediate or temporary files.

=== OUTPUT DIRECTORY ===
{output}

IMPORTANT:
- All reference files are in the task folder: {task_folder}
- Only save the final deliverables to the output directory {output}. Do not save any intermediate or temporary files.
- You MUST only access files within {workspace} or search online for new reference files if you find needed. Do NOT access any files or directories in this system outside of this path.
- If you encounter ambiguous or conflicting information, analyze the conflict, explain your reasoning, and justify the approach you choose.
- If a file cannot be read directly (e.g., .xlsx, .docx, .db, .pptx), use appropriate tools, MCP servers, or code to extract and process its contents."""
    request = {"cwd": str(workspace), "prompt": prompt, "provider": provider, "model": model_id}
    with (run_dir / "pi.stderr.log").open("wb") as stderr:
        process = await asyncio.create_subprocess_exec(
            str(NODE), "--import", (entry_dir / "source-resolver.ts").as_uri(),
            str(entry_dir / "local-runner-cli.ts"), cwd=workspace, env=env,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=stderr,
            start_new_session=True,
        )
        communication = asyncio.create_task(process.communicate(json.dumps(request).encode()))
        try:
            stdout, _ = await asyncio.wait_for(asyncio.shield(communication), timeout=PROTOCOL["timeout_seconds"])
        except BaseException:
            await stop_process(process)
            await communication
            raise
    returncode = process.returncode
    (run_dir / "pi.stdout.json").write_bytes(stdout)
    if returncode != 0:
        # The temporary rollout directory is deleted on failure. Preserve the
        # runner's structured error, or Node's startup error, in Beaker's case report.
        detail = log_tail(run_dir / "pi.stderr.log")
        try:
            failed = json.loads(stdout)
            if isinstance(failed, dict) and isinstance(failed.get("error"), dict):
                detail = str(failed["error"].get("message") or detail)
        except (ValueError, UnicodeDecodeError):
            pass
        detail = detail.replace(env[key_name], "[REDACTED]")
        raise RuntimeError(f"Pi exited with code {returncode}: {detail[-4000:] or 'No diagnostics emitted'}")
    envelope = json.loads(stdout)
    if envelope.get("ok") is not True:
        raise RuntimeError(f"Pi runner failed: {envelope.get('error')}")
    result = envelope["result"]
    if result["model"] != model_id or result["provider"] != provider:
        raise RuntimeError("Pi returned a different provider or model than requested")
    packed = []
    total = 0
    for path in sorted((workspace / "output").rglob("*")):
        if path.is_symlink():
            raise ValueError(f"Submission contains a symlink: {path.name}")
        if path.is_dir():
            continue
        if not path.is_file():
            raise ValueError(f"Submission contains a non-regular file: {path.name}")
        total += path.stat().st_size
        if total > MAX_DELIVERABLE_BYTES:
            raise RuntimeError("Submission exceeds the 23.9 MiB binary transport limit; not scored as zero")
        content = path.read_bytes()
        packed.append({
            "name": path.relative_to(workspace / "output").as_posix(),
            "sha256": hashlib.sha256(content).hexdigest(), "size": len(content),
            "content_base64": base64.b64encode(content).decode("ascii"),
        })
    observed = {
        "task": task.task, "response": result["response"], "messages": result["messages"], "files": packed,
        "stats": result["stats"], "protocol": {**PROTOCOL, "agent_model": f"{provider}:{model_id}"},
    }
    (run_dir / "result.json").write_text(json.dumps(observed), encoding="utf-8")
    return observed
