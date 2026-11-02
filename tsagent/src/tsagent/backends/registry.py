"""按模型家族选择 backend。原生 API 未连接时，可以退回 stub。"""

from __future__ import annotations

from tsagent.backends.amazon_chronos import AmazonChronosBackend
from tsagent.backends.base import TSFMBackend
from tsagent.backends.google_timesfm import GoogleTimesFMBackend
from tsagent.backends.stub import StubBackend
from tsagent.types import ModelSpec


class BackendRegistry:
    def __init__(
        self,
        fallback: str = "stub",
        google: GoogleTimesFMBackend | None = None,
        amazon: AmazonChronosBackend | None = None,
        stub: StubBackend | None = None,
    ) -> None:
        if fallback not in {"stub", "strict"}:
            raise ValueError("fallback 只能是 stub 或 strict")
        self.fallback = fallback
        self.google = google if google is not None else GoogleTimesFMBackend()
        self.amazon = amazon if amazon is not None else AmazonChronosBackend()
        self.stub = stub if stub is not None else StubBackend()

    def resolve(self, model: ModelSpec) -> tuple[TSFMBackend, str]:
        """返回实际调用的 backend，以及 native 或 stub。"""
        native = self._native_for(model)
        if native.status().connected:
            return native, "native"
        if self.fallback == "stub":
            return self.stub, "stub"
        return native, "native"

    def describe(self) -> tuple[tuple[str, bool, str], ...]:
        rows = []
        for backend in (self.google, self.amazon, self.stub):
            status = backend.status()
            rows.append((backend.name, status.connected, status.detail))
        return tuple(rows)

    def _native_for(self, model: ModelSpec) -> TSFMBackend:
        if model.family == "google":
            return self.google
        if model.family == "amazon":
            return self.amazon
        raise ValueError(f"没有 {model.family} 家族的 backend")
