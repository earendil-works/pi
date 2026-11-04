"""Deterministic pre-roll test for segmenter.py. Run in the image: docker run --rm p2-voice python test_segmenter.py

Builds 16 kHz audio: 1.5 s of silence, a quiet word (-30 dB, too quiet to trigger Silero), a 150 ms pause, a
normal sentence, 2 s of silence (Supertonic 3 voice F1, fixed seed). Without pre-roll Parakeet misses the first word;
with 750 ms the utterance reaches back past its onset, is a contiguous slice of the input (no duplicated samples),
and Parakeet hears the first word.
"""

import os
import sys

import numpy as np

os.environ.setdefault("VOICE_ENGINES", "supertonic")
os.environ.setdefault("VOICE_TOKEN", "test")
import sherpa_onnx  # noqa: E402

from engines import Supertonic  # noqa: E402
from segmenter import Segmenter  # noqa: E402

SR = 16000
MODELS = os.environ.get("VOICE_MODELS", "/models")


def config() -> sherpa_onnx.VadModelConfig:
    c = sherpa_onnx.VadModelConfig()
    c.silero_vad.model = f"{MODELS}/silero_vad.onnx"
    c.silero_vad.threshold = 0.5
    c.silero_vad.min_silence_duration = 1.2
    c.silero_vad.min_speech_duration = 0.25
    c.silero_vad.max_speech_duration = 30
    c.silero_vad.window_size = 512
    c.sample_rate = SR
    c.num_threads = 1
    return c


def resample(audio: np.ndarray, rate: int) -> np.ndarray:
    positions = np.arange(int(len(audio) * SR / rate)) * rate / SR
    return np.interp(positions, np.arange(len(audio)), audio).astype(np.float32)


def trim(audio: np.ndarray) -> np.ndarray:
    loud = np.flatnonzero(np.abs(audio) > 0.01)
    return audio[loud[0] : loud[-1] + 1]


def run(audio: np.ndarray, preroll_ms: float) -> list[np.ndarray]:
    segmenter = Segmenter(config(), preroll_ms)
    utterances = []
    for offset in range(0, len(audio), 1600):  # 100 ms frames, like the browser
        utterances += [u for event, u in segmenter.accept(audio[offset : offset + 1600]) if u is not None]
    return utterances


def main() -> int:
    np.random.seed(7)
    tts = Supertonic()
    word = trim(resample(tts.sentence("Okay.", "F1", 1.05), tts.sample_rate)) * 0.03  # about -30 dB
    rest = trim(resample(tts.sentence("Deploy the voice service to slayer now.", "F1", 1.05), tts.sample_rate))
    rng = np.random.default_rng(1)
    parts = [np.zeros(int(1.5 * SR)), word, np.zeros(int(0.15 * SR)), rest, np.zeros(2 * SR)]
    audio = np.concatenate(parts).astype(np.float32)
    audio += rng.normal(0, 0.0005, len(audio)).astype(np.float32)  # faint noise floor
    onset = int(1.5 * SR)

    from server import transcribe  # noqa: E402  (loads Parakeet)

    results = {}
    for preroll in (0, 750):
        utterances = run(audio, preroll)
        assert len(utterances) == 1, f"preroll {preroll}: {len(utterances)} utterances"
        u = utterances[0]
        # Locate the utterance in the input to get its start; it must be a contiguous slice (no duplicates).
        start = int(np.argmin([np.abs(audio[s : s + 4000] - u[:4000]).sum() for s in range(0, onset + SR)]))
        assert np.allclose(audio[start : start + len(u)], u, atol=1e-6), f"preroll {preroll}: not contiguous"
        text = transcribe(u)
        results[preroll] = (start, len(u), text)
        print(f"preroll {preroll:4d} ms: begins {(onset - start) * 1000 / SR:+5.0f} ms before the quiet word (negative: after its onset), "
              f"{len(u) / SR:.2f} s, heard: {text!r}")
    start0, _, text0 = results[0]
    assert not text0.lower().startswith("okay"), "test audio too loud: sherpa alone kept the first word"
    start750, _, text750 = results[750]
    assert start750 <= onset, "pre-roll did not reach the first word"
    assert start0 - start750 > 0, "pre-roll added nothing"
    assert text750.lower().startswith("okay"), f"first word missing: {text750!r}"
    print("ok")
    return 0


if __name__ == "__main__":
    sys.exit(main())
