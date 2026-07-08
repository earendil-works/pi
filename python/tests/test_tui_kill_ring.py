from pi_mono.tui.kill_ring import KillRing


def test_kill_ring_basic():
    ring = KillRing()
    assert ring.length == 0
    assert ring.peek() is None

    ring.push("hello")
    assert ring.length == 1
    assert ring.peek() == "hello"

    ring.push("world")
    assert ring.length == 2
    assert ring.peek() == "world"


def test_kill_ring_accumulate():
    ring = KillRing()

    # Empty push does nothing
    ring.push("")
    assert ring.length == 0

    ring.push("hello")
    # Accumulate append
    ring.push(" world", accumulate=True)
    assert ring.length == 1
    assert ring.peek() == "hello world"

    # Accumulate prepend
    ring.push("say ", prepend=True, accumulate=True)
    assert ring.length == 1
    assert ring.peek() == "say hello world"


def test_kill_ring_rotate():
    ring = KillRing()
    ring.push("a")
    ring.push("b")
    ring.push("c")

    assert ring.peek() == "c"

    ring.rotate()
    # "c" is popped and inserted at index 0.
    # New ring is ["c", "a", "b"].
    # So peek (which is ring[-1]) should be "b".
    assert ring.peek() == "b"

    ring.rotate()
    # "b" is popped and inserted at index 0.
    # New ring is ["b", "c", "a"].
    # So peek should be "a".
    assert ring.peek() == "a"
