/**
 * Tests for StdinBuffer multi-codepoint Kitty CSI-u dedup
 *
 * Tests the forward dedup (CSI-u first, raw characters second) and
 * reverse dedup (raw characters first, CSI-u second) logic for
 * multi-character Chinese IME input.
 */
import assert from "node:assert";
import { beforeEach, describe, it } from "node:test";
import { StdinBuffer } from "../src/stdin-buffer.js";

describe("Multi-codepoint Kitty dedup", () => {
	let buffer: StdinBuffer;
	let emittedSequences: string[];

	beforeEach(() => {
		buffer = new StdinBuffer();
		emittedSequences = [];
		buffer.on("data", (seq: string) => emittedSequences.push(seq));
	});

	const processInput = (data: string) => {
		buffer.process(data);
	};

	it("should dedup multiple CSI-u sequences followed by raw characters", () => {
		processInput("\x1b[20320u\x1b[22909u你好");
		assert.deepStrictEqual(emittedSequences, ["\x1b[20320u", "\x1b[22909u"]);
	});

	it("should dedup raw characters followed by CSI-u sequences (reverse)", () => {
		processInput("你好\x1b[20320u\x1b[22909u");
		assert.deepStrictEqual(emittedSequences, ["你", "好"]);
	});

	it("should dedup interleaved CSI-u and raw characters", () => {
		processInput("\x1b[20320u你\x1b[22909u好");
		assert.deepStrictEqual(emittedSequences, ["\x1b[20320u", "\x1b[22909u"]);
	});

	it("should handle three characters from IME commit", () => {
		processInput("\x1b[20320u\x1b[22909u\x1b[19990u你好世");
		assert.deepStrictEqual(emittedSequences, ["\x1b[20320u", "\x1b[22909u", "\x1b[19990u"]);
	});

	it("should keep non-matching raw character after CSI-u", () => {
		processInput("\x1b[20320u好");
		assert.deepStrictEqual(emittedSequences, ["\x1b[20320u", "好"]);
	});

	it("should handle same character typed twice in a row (Map counting)", () => {
		// CSI-u1→pending{20320:1}, CSI-u2→pending{20320:2}
		// raw1(20320)→count-1→{20320:1} (去重)
		// raw2(20320)→count-1→{20320:0}→delete (去重)
		processInput("\x1b[20320u\x1b[20320u你你");
		assert.deepStrictEqual(emittedSequences, ["\x1b[20320u", "\x1b[20320u"]);
	});

	it("should handle CSI-u and raw arriving in separate chunks (cross-process forward dedup)", () => {
		processInput("\x1b[20320u\x1b[22909u");
		processInput("你好");
		assert.deepStrictEqual(emittedSequences, ["\x1b[20320u", "\x1b[22909u"]);
	});

	it("should handle reverse dedup with consecutive same characters (same batch)", () => {
		// raw "你你" 先到，CSI-u 后到（同一 batch 内）
		// emittedRawCodepointsInBatch 用 Map 计数：{20320: 2}
		// CSI-u1(20320)→count-1→{20320:1} (反向去重)
		// CSI-u2(20320)→count-1→{20320:0}→delete (反向去重)
		processInput("你你\x1b[20320u\x1b[20320u");
		assert.deepStrictEqual(emittedSequences, ["你", "你"]);
	});

	it("should handle reverse dedup across separate chunks (known limitation)", () => {
		// 跨 chunk 反向去重不工作——反向去重仅在单 batch 内有效。
		// 这是因为 emittedRawCodepointsInBatch 在每次 process() 开始时清理。
		processInput("你好");
		const firstBatch = [...emittedSequences];
		emittedSequences = []; // 清空第一 chunk 的产物
		processInput("\x1b[20320u\x1b[22909u");
		// 已知限制：CSI-u 被发射（无法匹配已清理的 raw 记录）
		assert.deepStrictEqual(emittedSequences, ["\x1b[20320u", "\x1b[22909u"]);
		assert.deepStrictEqual(firstBatch, ["你", "好"]);
	});

	it("should handle empty input without corrupting state", () => {
		processInput("");
		assert.deepStrictEqual(emittedSequences, [""]);
		// 验证状态未损坏：再输入正常数据
		emittedSequences = [];
		processInput("\x1b[97ua");
		assert.deepStrictEqual(emittedSequences, ["\x1b[97u"]);
	});

	it("should handle flush with pending codepoints", () => {
		processInput("\x1b[20320u"); // pending 中有 20320
		const flushed = buffer.flush();
		// flush 清理所有去重状态
		assert.deepStrictEqual(flushed, []);
		// 之后输入的 raw 不会被去重（pending 已清）
		processInput("你");
		assert.deepStrictEqual(emittedSequences, ["\x1b[20320u", "你"]);
	});

	it("should handle clear with pending codepoints", () => {
		processInput("\x1b[20320u");
		buffer.clear();
		processInput("你");
		assert.deepStrictEqual(emittedSequences, ["\x1b[20320u", "你"]);
	});

	it("should handle bracketed paste clearing dedup state", () => {
		processInput("\x1b[20320u");
		processInput("\x1b[200~hello\x1b[201~");
		processInput("你");
		// paste 后 pending 被清理，raw 不会被去重
		assert.deepStrictEqual(emittedSequences, ["\x1b[20320u", "你"]);
	});

	it("should restore normal dedup after paste ends", () => {
		processInput("\x1b[200~hello\x1b[201~"); // paste 期间清理去重状态
		emittedSequences = [];
		// paste 结束后，新的去重应正常工作
		processInput("\x1b[20320u\x1b[22909u你好");
		assert.deepStrictEqual(emittedSequences, ["\x1b[20320u", "\x1b[22909u"]);
	});

	it("should handle non-BMP emoji in CSI-u forward dedup (known limitation)", () => {
		// \x1b[128512u = U+1F600 (😀)，raw 是 UTF-16 surrogate pair（length=2）
		// rawCodepoint = sequence.length === 1 ? codePointAt(0) : undefined → undefined
		// 所以 raw 不被正向去重，两者都会发射——这是已知行为
		processInput("\x1b[128512u😀");
		assert.deepStrictEqual(emittedSequences, ["\x1b[128512u", "\ud83d", "\ude00"]);
	});

	it("should handle non-BMP emoji in CSI-u reverse dedup (known limitation)", () => {
		// raw 先到，CSI-u 后到（同一批次反向去重）
		processInput("😀\x1b[128512u");
		assert.deepStrictEqual(emittedSequences, ["\ud83d", "\ude00", "\x1b[128512u"]);
	});

	it("should clear pending dedup state on destroy", () => {
		processInput("\x1b[20320u"); // pending 中有 20320
		buffer.destroy();
		emittedSequences = [];
		processInput("你");
		assert.deepStrictEqual(emittedSequences, ["你"]);
	});
});
