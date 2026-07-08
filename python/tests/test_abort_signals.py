from pi_mono.utils.abort_signals import AbortController, combine_abort_signals


def test_abort_controller_basic():
    controller = AbortController()
    signal = controller.signal

    assert signal.aborted is False
    assert signal.reason is None

    called = []

    def on_abort():
        called.append(True)

    signal.add_event_listener("abort", on_abort)
    controller.abort("timeout")

    assert signal.aborted is True
    assert signal.reason == "timeout"
    assert len(called) == 1


def test_abort_signal_once_listener():
    controller = AbortController()
    signal = controller.signal

    called_count = 0

    def on_abort():
        nonlocal called_count
        called_count += 1

    signal.add_event_listener("abort", on_abort, once=True)
    controller.abort("test")
    # Triggering abort again shouldn't run it (signal already aborted anyway, but tests removal)
    controller.abort("test2")

    assert called_count == 1


def test_abort_signal_remove_listener():
    controller = AbortController()
    signal = controller.signal

    called = False

    def on_abort():
        nonlocal called
        called = True

    signal.add_event_listener("abort", on_abort)
    signal.remove_event_listener("abort", on_abort)
    controller.abort()

    assert called is False


def test_combine_abort_signals_empty():
    combined = combine_abort_signals([])
    assert "signal" not in combined
    assert callable(combined["cleanup"])


def test_combine_abort_signals_single():
    controller = AbortController()
    combined = combine_abort_signals([controller.signal])
    assert combined["signal"] is controller.signal


def test_combine_abort_signals_multiple():
    c1 = AbortController()
    c2 = AbortController()

    combined = combine_abort_signals([c1.signal, c2.signal])
    assert "signal" in combined
    combined_signal = combined["signal"]
    assert combined_signal.aborted is False

    called = False

    def on_abort():
        nonlocal called
        called = True

    combined_signal.add_event_listener("abort", on_abort)

    # Abort second controller
    c2.abort("reason_c2")

    assert combined_signal.aborted is True
    assert combined_signal.reason == "reason_c2"
    assert called is True

    # Cleanup should run without error
    combined["cleanup"]()
