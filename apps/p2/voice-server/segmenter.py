"""Speech segmentation for /listen: Silero VAD (sherpa-onnx) plus a pre-roll, so quiet first words survive.

sherpa-onnx starts a segment 2 VAD windows + min_speech_duration before the window in which it detects speech
(1024 + 4000 samples = 314 ms at the defaults), and drops older audio. A first word that is too quiet or short to
trigger detection is lost. The segmenter keeps a rolling copy of recent audio and, when speech is detected, extends
the segment so it starts `preroll_ms` before the detection point. Audio sherpa already kept is not duplicated, and
the pre-roll never reaches back into the previous utterance.
"""

import numpy as np
import sherpa_onnx

WINDOW = 512


class Segmenter:
    def __init__(self, config: sherpa_onnx.VadModelConfig, preroll_ms: float):
        self.config = config
        self.sample_rate = config.sample_rate
        self.preroll = int(self.sample_rate * max(0.0, preroll_ms) / 1000)
        self.vad = sherpa_onnx.VoiceActivityDetector(config, buffer_size_in_seconds=60)
        self.keep = self.preroll + self.sample_rate  # rolling history length; must cover sherpa's own look-back
        self.reset()

    def reset(self) -> None:
        self.vad.reset()
        self.pending = np.zeros(0, dtype=np.float32)
        self.history = np.zeros(0, dtype=np.float32)
        self.history_start = 0  # absolute index of history[0]
        self.fed = 0  # samples given to the VAD since the last reset; equals sherpa's absolute buffer index
        self.speaking = False
        self.snapshot: tuple[int, int, np.ndarray] | None = None  # (detection index, start index, audio)
        self.previous_end = 0

    def accept(self, samples: np.ndarray) -> list[tuple[str, np.ndarray | None]]:
        """Feeds 16 kHz float32 audio. Returns events: ("speech_start", None) and ("speech_end", utterance)."""
        events: list[tuple[str, np.ndarray | None]] = []
        self.pending = np.concatenate([self.pending, samples.astype(np.float32, copy=False)])
        while len(self.pending) >= WINDOW:
            window = self.pending[:WINDOW]
            self.pending = self.pending[WINDOW:]
            self.vad.accept_waveform(window)
            self.fed += WINDOW
            self.history = np.concatenate([self.history, window])
            if len(self.history) > self.keep:
                drop = len(self.history) - self.keep
                self.history = self.history[drop:]
                self.history_start += drop
            if self.vad.is_speech_detected() and not self.speaking:
                self.speaking = True
                self.snapshot = (self.fed, self.history_start, self.history.copy())
                events.append(("speech_start", None))
            while not self.vad.empty():
                segment = self.vad.front
                start = segment.start
                audio = np.array(segment.samples, dtype=np.float32)
                self.vad.pop()
                self.speaking = False
                events.append(("speech_end", self.extend(start, audio)))
                self.previous_end = start + len(audio)
        return events

    def extend(self, start: int, audio: np.ndarray) -> np.ndarray:
        snapshot, self.snapshot = self.snapshot, None
        if snapshot is None or self.preroll == 0:
            return audio
        detected, snap_start, snap = snapshot
        if not snap_start <= start <= snap_start + len(snap):
            return audio  # a continuation after sherpa split a long utterance
        begin = max(detected - self.preroll, snap_start, self.previous_end)
        if begin >= start:
            return audio
        return np.concatenate([snap[begin - snap_start : start - snap_start], audio])
