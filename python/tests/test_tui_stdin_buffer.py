import pytest
import anyio
from pi_mono.tui.stdin_buffer import StdinBuffer


@pytest.mark.anyio
async def test_stdin_buffer_regular_characters():
    buffer = StdinBuffer({"timeout": 10})
    emitted = []
    buffer.on("data", lambda x: emitted.append(x))

    buffer.process("a")
    assert emitted == ["a"]

    buffer.process("abc")
    assert emitted == [
        "a",
        "abc"[0],
        "abc"[1],
        "abc"[2],
    ]  # ["a", "a", "b", "c"] because "abc" was processed

    buffer.clear()
    emitted.clear()
    buffer.process("abc")
    assert emitted == ["a", "b", "c"]

    buffer.clear()
    emitted.clear()
    buffer.process("hello 世界")
    assert emitted == ["h", "e", "l", "l", "o", " ", "世", "界"]


@pytest.mark.anyio
async def test_stdin_buffer_complete_escape_sequences():
    buffer = StdinBuffer({"timeout": 10})
    emitted = []
    buffer.on("data", lambda x: emitted.append(x))

    mouse_seq = "\x1b[<35;20;5m"
    buffer.process(mouse_seq)
    assert emitted == [mouse_seq]

    emitted.clear()
    up_arrow = "\x1b[A"
    buffer.process(up_arrow)
    assert emitted == [up_arrow]

    emitted.clear()
    f1 = "\x1b[11~"
    buffer.process(f1)
    assert emitted == [f1]

    emitted.clear()
    meta_a = "\x1ba"
    buffer.process(meta_a)
    assert emitted == [meta_a]

    emitted.clear()
    ss3 = "\x1bOA"
    buffer.process(ss3)
    assert emitted == [ss3]


@pytest.mark.anyio
async def test_stdin_buffer_partial_escape_sequences():
    buffer = StdinBuffer({"timeout": 10})
    emitted = []
    buffer.on("data", lambda x: emitted.append(x))

    buffer.process("\x1b")
    assert emitted == []
    assert buffer.getBuffer() == "\x1b"

    buffer.process("[<35")
    assert emitted == []
    assert buffer.getBuffer() == "\x1b[<35"

    buffer.process(";20;5m")
    assert emitted == ["\x1b[<35;20;5m"]
    assert buffer.getBuffer() == ""


@pytest.mark.anyio
async def test_stdin_buffer_incomplete_csi_sequence():
    buffer = StdinBuffer({"timeout": 10})
    emitted = []
    buffer.on("data", lambda x: emitted.append(x))

    buffer.process("\x1b[")
    assert emitted == []

    buffer.process("1;")
    assert emitted == []

    buffer.process("5H")
    assert emitted == ["\x1b[1;5H"]


@pytest.mark.anyio
async def test_stdin_buffer_split_across_many_chunks():
    buffer = StdinBuffer({"timeout": 10})
    emitted = []
    buffer.on("data", lambda x: emitted.append(x))

    chunks = ["\x1b", "[", "<", "3", "5", ";", "2", "0", ";", "5", "m"]
    for chunk in chunks:
        buffer.process(chunk)

    assert emitted == ["\x1b[<35;20;5m"]


@pytest.mark.anyio
async def test_stdin_buffer_flush_incomplete_sequence_after_timeout():
    buffer = StdinBuffer({"timeout": 10})
    emitted = []
    buffer.on("data", lambda x: emitted.append(x))

    buffer.process("\x1b[<35")
    assert emitted == []

    # Wait for timeout
    await anyio.sleep(0.02)
    assert emitted == ["\x1b[<35"]


@pytest.mark.anyio
async def test_stdin_buffer_mixed_content():
    buffer = StdinBuffer({"timeout": 10})
    emitted = []
    buffer.on("data", lambda x: emitted.append(x))

    buffer.process("abc\x1b[A")
    assert emitted == ["a", "b", "c", "\x1b[A"]

    emitted.clear()
    buffer.process("\x1b[Aabc")
    assert emitted == ["\x1b[A", "a", "b", "c"]

    emitted.clear()
    buffer.process("\x1b[A\x1b[B\x1b[C")
    assert emitted == ["\x1b[A", "\x1b[B", "\x1b[C"]


@pytest.mark.anyio
async def test_stdin_buffer_kitty_keyboard_protocol():
    buffer = StdinBuffer({"timeout": 10})
    emitted = []
    buffer.on("data", lambda x: emitted.append(x))

    buffer.process("\x1b[97u")
    assert emitted == ["\x1b[97u"]

    emitted.clear()
    buffer.process("\x1b[97;1:3u")
    assert emitted == ["\x1b[97;1:3u"]

    emitted.clear()
    buffer.process("\x1b[97u\x1b[97;1:3u")
    assert emitted == ["\x1b[97u", "\x1b[97;1:3u"]

    emitted.clear()
    buffer.process("\x1b[97u\x1b[97;1:3u\x1b[98u\x1b[98;1:3u")
    assert emitted == ["\x1b[97u", "\x1b[97;1:3u", "\x1b[98u", "\x1b[98;1:3u"]

    emitted.clear()
    buffer.process("\x1b[1;1:1A")
    assert emitted == ["\x1b[1;1:1A"]

    emitted.clear()
    buffer.process("\x1b[3;1:3~")
    assert emitted == ["\x1b[3;1:3~"]


@pytest.mark.anyio
async def test_stdin_buffer_wezterm_escape_regression():
    buffer = StdinBuffer({"timeout": 10})
    emitted = []
    buffer.on("data", lambda x: emitted.append(x))

    buffer.process("\x1b\x1b[27;129:3u")
    assert emitted == ["\x1b", "\x1b[27;129:3u"]

    emitted.clear()
    buffer.process("\x1b\x1b[27;1:3u")
    assert emitted == ["\x1b", "\x1b[27;1:3u"]

    emitted.clear()
    buffer.process("\x1b\x1b")
    assert emitted == ["\x1b\x1b"]


@pytest.mark.anyio
async def test_stdin_buffer_kitty_duplicates():
    buffer = StdinBuffer({"timeout": 10})
    emitted = []
    buffer.on("data", lambda x: emitted.append(x))

    buffer.process("\x1b[224uà")
    assert emitted == ["\x1b[224u"]

    emitted.clear()
    buffer.process("\x1b[64u")
    buffer.process("@")
    assert emitted == ["\x1b[64u"]

    emitted.clear()
    buffer.process("\x1b[97ub")
    assert emitted == ["\x1b[97u", "b"]

    emitted.clear()
    buffer.process("\x1b[64;3u@")
    assert emitted == ["\x1b[64;3u", "@"]


@pytest.mark.anyio
async def test_stdin_buffer_mouse_events():
    buffer = StdinBuffer({"timeout": 10})
    emitted = []
    buffer.on("data", lambda x: emitted.append(x))

    buffer.process("\x1b[<0;10;5M")
    assert emitted == ["\x1b[<0;10;5M"]

    emitted.clear()
    buffer.process("\x1b[<0;10;5m")
    assert emitted == ["\x1b[<0;10;5m"]

    emitted.clear()
    buffer.process("\x1b[<35;20;5m")
    assert emitted == ["\x1b[<35;20;5m"]

    emitted.clear()
    buffer.process("\x1b[<3")
    buffer.process("5;1")
    buffer.process("5;")
    buffer.process("10m")
    assert emitted == ["\x1b[<35;15;10m"]

    emitted.clear()
    buffer.process("\x1b[<35;1;1m\x1b[<35;2;2m\x1b[<35;3;3m")
    assert emitted == ["\x1b[<35;1;1m", "\x1b[<35;2;2m", "\x1b[<35;3;3m"]

    emitted.clear()
    buffer.process("\x1b[M abc")
    assert emitted == ["\x1b[M ab", "c"]

    emitted.clear()
    buffer.process("\x1b[M")
    assert buffer.getBuffer() == "\x1b[M"
    buffer.process(" a")
    assert buffer.getBuffer() == "\x1b[M a"
    buffer.process("b")
    assert emitted == ["\x1b[M ab"]


@pytest.mark.anyio
async def test_stdin_buffer_bracketed_paste():
    buffer = StdinBuffer({"timeout": 10})
    emitted_data = []
    emitted_paste = []
    buffer.on("data", lambda x: emitted_data.append(x))
    buffer.on("paste", lambda x: emitted_paste.append(x))

    paste_start = "\x1b[200~"
    paste_end = "\x1b[201~"
    content = "hello world"

    buffer.process(paste_start + content + paste_end)
    assert emitted_paste == ["hello world"]
    assert emitted_data == []

    emitted_paste.clear()
    buffer.process("\x1b[200~")
    assert emitted_paste == []
    buffer.process("hello ")
    assert emitted_paste == []
    buffer.process("world\x1b[201~")
    assert emitted_paste == ["hello world"]
    assert emitted_data == []

    emitted_paste.clear()
    buffer.process("a")
    buffer.process("\x1b[200~pasted\x1b[201~")
    buffer.process("b")
    assert emitted_data == ["a", "b"]
    assert emitted_paste == ["pasted"]
