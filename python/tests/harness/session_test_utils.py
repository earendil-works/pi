import tempfile
import time
import shutil
from typing import cast
from pi_mono.agent.types import AgentMessage


def createUserMessage(text: str) -> AgentMessage:
    return cast(
        AgentMessage,
        {
            "role": "user",
            "content": [{"type": "text", "text": text}],
            "timestamp": int(time.time() * 1000),
        },
    )


def createAssistantMessage(text: str) -> AgentMessage:
    return cast(
        AgentMessage,
        {
            "role": "assistant",
            "content": [{"type": "text", "text": text}],
            "api": "anthropic-messages",
            "provider": "anthropic",
            "model": "claude-sonnet-4-5",
            "usage": {
                "input": 0,
                "output": 0,
                "cacheRead": 0,
                "cacheWrite": 0,
                "totalTokens": 0,
                "cost": {
                    "input": 0.0,
                    "output": 0.0,
                    "cacheRead": 0.0,
                    "cacheWrite": 0.0,
                    "total": 0.0,
                },
            },
            "stopReason": "stop",
            "timestamp": int(time.time() * 1000),
        },
    )


tempDirs: list[str] = []


def createTempDir() -> str:
    dir_path = tempfile.mkdtemp(prefix="pi-agent-session-")
    tempDirs.append(dir_path)
    return dir_path


def getLatestTempDir() -> str:
    return tempDirs[-1]


def cleanupTempDirs() -> None:
    while tempDirs:
        d = tempDirs.pop()
        try:
            shutil.rmtree(d, ignore_errors=True)
        except Exception:
            pass
