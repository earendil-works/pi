/// <reference types="vitest/globals" />
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { MessageParts } from "./MessageParts";
import type { Part } from "../../lib/api";
import type { CardState } from "../AskUserQuestionCard";

// Mock scrollIntoView for JSDOM
Element.prototype.scrollIntoView = vi.fn();

describe("MessageParts", () => {
  describe("S4/S5: Thinking default collapsed + click expand", () => {
    // Test 1: thinking (default closed)
    it("renders thinking header with Brain icon and 思考 label", () => {
      const parts: Part[] = [{ type: "thinking", text: "Let me think..." }];
      const { container } = render(<MessageParts parts={parts} />);
      // Should have "思考" button
      expect(screen.getByText(/思考/)).toBeTruthy();
      // Should NOT contain the thinking text in DOM (collapsed)
      expect(container.textContent).not.toContain("Let me think");
    });

    // Test 2: thinking click expands
    it("clicking thinking button expands content", () => {
      const parts: Part[] = [{ type: "thinking", text: "Let me think..." }];
      const { container } = render(<MessageParts parts={parts} />);
      const button = screen.getByText(/展开/i);
      fireEvent.click(button);
      expect(container.textContent).toContain("Let me think");
    });

    it("clicking hide button collapses thinking again", () => {
      const parts: Part[] = [{ type: "thinking", text: "Hidden content" }];
      render(<MessageParts parts={parts} />);

      // Expand
      const expandButton = screen.getByText(/展开/i);
      fireEvent.click(expandButton);

      // Should now be visible
      expect(screen.getByText("Hidden content")).toBeTruthy();

      // Collapse
      const collapseButton = screen.getByText(/收起/i);
      fireEvent.click(collapseButton);

      // Should no longer be visible
      expect(screen.queryByText("Hidden content")).toBeNull();
    });
  });

  describe("S6: Tool call name + summary", () => {
    // Test 3: tool call shows icon + name + summary, no raw JSON by default
    it("tool call shows name and friendly summary, no raw JSON by default", () => {
      const parts: Part[] = [
        { type: "toolCall", id: "tc1", name: "read", args: { path: "/foo/bar.txt" } },
      ];
      render(<MessageParts parts={parts} />);
      // Should show the tool name
      expect(screen.getByText("read")).toBeTruthy();
      // Should show the path as summary
      expect(screen.getByText("/foo/bar.txt")).toBeTruthy();
      // Should NOT show raw JSON visible
      expect(screen.queryByText(/"path":/)).toBeNull();
    });

    // Test 4: tool call click expands to show full args
    it("clicking tool call chevron expands full args JSON", () => {
      const parts: Part[] = [
        { type: "toolCall", id: "tc1", name: "bash", args: { command: "ls -la" } },
      ];
      const { container } = render(<MessageParts parts={parts} />);
      expect(container.textContent).not.toContain('"command"');
      // Find the button containing the tool name
      const button = screen.getByText("bash").closest("button")!;
      fireEvent.click(button);
      expect(container.textContent).toContain('"command"');
    });
  });

  describe("S7: Tool result collapsed with size badge", () => {
    // Test 5: tool result shows first line + size badge, not full content
    it("tool result shows first line and size badge, full content collapsed", () => {
      const longContent = "Line 1: important info\n" + "x".repeat(5000);
      const parts: Part[] = [
        { type: "toolResult", toolCallId: "tc1", content: longContent },
      ];
      const { container } = render(<MessageParts parts={parts} />);
      // Should show first line
      expect(container.textContent).toContain("Line 1: important info");
      // Should show size badge
      expect(screen.getByText(/KB/)).toBeTruthy();
      // Should NOT show all 5000 x's in default view
      expect(container.textContent?.length).toBeLessThan(6000);
    });

    it("tool result expands on click to show full content", () => {
      const longContent = "First line\nSecond line content";
      const parts: Part[] = [
        { type: "toolResult", toolCallId: "tc1", content: longContent },
      ];
      const { container } = render(<MessageParts parts={parts} />);

      // Initially collapsed - second line not visible
      expect(container.textContent).not.toContain("Second line content");

      // Click to expand
      const button = screen.getByText("First line").closest("button")!;
      fireEvent.click(button);

      // Now visible
      expect(container.textContent).toContain("Second line content");
    });

    it("short tool result shows content without size badge exceeding small threshold", () => {
      const shortContent = "Short result";
      const parts: Part[] = [
        { type: "toolResult", toolCallId: "tc1", content: shortContent },
      ];
      render(<MessageParts parts={parts} />);

      // Should show content
      expect(screen.getByText("Short result")).toBeTruthy();
    });
  });

  describe("S8: Tool call + result grouped into ToolGroup", () => {
    // Test 6: tool call + result grouped into one container
    it("groups tool calls and results into single ToolGroup container", () => {
      const parts: Part[] = [
        { type: "toolCall", id: "tc1", name: "read", args: { path: "/foo" } },
        { type: "toolResult", toolCallId: "tc1", content: "file content here" },
        { type: "toolCall", id: "tc2", name: "bash", args: { command: "ls" } },
        { type: "toolResult", toolCallId: "tc2", content: "total 0" },
      ];
      const { container } = render(<MessageParts parts={parts} />);
      // Both tool names should be in DOM
      expect(screen.getByText("read")).toBeTruthy();
      expect(screen.getByText("bash")).toBeTruthy();
      // Both results should be visible (first lines visible, full content may be collapsed)
      expect(container.textContent).toContain("file content here");
      expect(container.textContent).toContain("total 0");
    });
  });

  describe("S8b: Large tool group is collapsed by default", () => {
    // 5+ tool-related items in a single turn should default to a summary
    // line ("14 tool calls: bash ×6, todowrite ×6, ...") so the bubble
    // doesn't flood vertically. The user can click to expand.
    it("collapses a 14-tool group behind a summary and shows it on click", async () => {
      const user = userEvent.setup();
      const parts: Part[] = [];
      for (let i = 0; i < 6; i++) {
        parts.push({ type: "toolCall", id: `tcb${i}`, name: "bash", args: { command: `echo ${i}` } });
        parts.push({ type: "toolResult", toolCallId: `tcb${i}`, content: `out ${i}` });
      }
      parts.push({ type: "toolCall", id: "tcw1", name: "todowrite", args: {} });
      parts.push({ type: "toolCall", id: "tcr1", name: "read", args: { path: "/x" } });
      parts.push({ type: "toolCall", id: "tce1", name: "edit", args: { path: "/y" } });
      const { container } = render(<MessageParts parts={parts} />);

      // Summary header present, individual tool rows hidden
      expect(screen.getByText(/9 tool calls/)).toBeTruthy();
      expect(screen.getByText(/bash ×6/)).toBeTruthy();
      expect(screen.getByText(/todowrite ×1/)).toBeTruthy();
      // Individual tool name rows are NOT in DOM yet
      expect(container.textContent).not.toContain("echo 0");

      // Click to expand
      await user.click(screen.getByText(/9 tool calls/));
      expect(container.textContent).toContain("echo 0");
    });

    it("does not collapse a small (≤4) tool group", () => {
      const parts: Part[] = [
        { type: "toolCall", id: "tc1", name: "read", args: { path: "/foo" } },
        { type: "toolResult", toolCallId: "tc1", content: "file content here" },
      ];
      const { container } = render(<MessageParts parts={parts} />);
      // No summary header
      expect(container.textContent).not.toMatch(/\d+ tool calls/);
      expect(screen.getByText("read")).toBeTruthy();
      expect(container.textContent).toContain("file content here");
    });
  });

  describe("S9: Empty assistant renders", () => {
    it("shows (empty turn) placeholder when parts is empty", () => {
      render(<MessageParts parts={[]} />);
      expect(screen.getByText("(empty turn)")).toBeTruthy();
    });

    it("renders thinking + tool card for assistant with no text, NOT empty bubble", () => {
      const parts: Part[] = [
        { type: "thinking", text: "Let me think about this..." },
        { type: "toolCall", id: "tc1", name: "read", args: { path: "/foo" } },
      ];
      render(<MessageParts parts={parts} />);

      // Should show thinking header with Chinese label
      expect(screen.getByText(/思考/)).toBeTruthy();
      // Should show tool call name
      expect(screen.getByText("read")).toBeTruthy();
      // Should NOT show "(empty turn)" placeholder
      expect(screen.queryByText("(empty turn)")).toBeNull();
    });
  });

  describe("S16: Image renders inline", () => {
    // Test 8: image renders inline
    it("image renders with data URL and max-h-96", () => {
      const parts: Part[] = [
        { type: "image", mediaType: "image/png", data: "iVBORw0KGgo=" },
      ];
      const { container } = render(<MessageParts parts={parts} />);
      const img = container.querySelector("img");
      expect(img).toBeTruthy();
      expect(img?.getAttribute("src")).toBe("data:image/png;base64,iVBORw0KGgo=");
      expect(img?.className).toMatch(/max-h-96/);
    });
  });

  describe("StepHeader (via MessageParts)", () => {
    // These tests cover the StepHeader wrapper around assistant turns.
    // Case 1 is a regression guard — it asserts that pure-text turns do
    // NOT gain a step header. Cases 2-5 cover the streaming / collapsed
    // / user-toggle / auto-collapse contract.

    it("renders no step header for a pure-text turn", () => {
      const parts: Part[] = [{ type: "text", text: "hi" }];
      render(<MessageParts parts={parts} isStreaming={false} />);
      // Regression guard: no "Executing" / "Completed" text → no step header.
      expect(screen.queryByText(/Execut|Completed/i)).toBeNull();
    });

    it("shows Executing header and expands the body when streaming a thinking+text turn", () => {
      const parts: Part[] = [
        { type: "thinking", text: "x" },
        { type: "text", text: "y" },
      ];
      render(<MessageParts parts={parts} isStreaming={true} />);
      // Step header shows "● Executing (Xs) ▼"
      expect(screen.getByText(/Executing/i)).toBeTruthy();
      // Body is expanded by default when isStreaming=true → text "y" visible
      expect(screen.getByText("y")).toBeTruthy();
    });

    it("shows Completed header with the body collapsed when not streaming a tool call turn", () => {
      const parts: Part[] = [
        { type: "toolCall", id: "t1", name: "read", args: { path: "/x" } },
      ];
      render(<MessageParts parts={parts} isStreaming={false} />);
      // Step header shows "✓ Completed (Xs) ▲"
      expect(screen.getByText(/Completed/i)).toBeTruthy();
      // Body is collapsed by default when isStreaming=false → "/x" not in DOM
      expect(screen.queryByText("/x")).toBeNull();
    });

    it("expands the body when the user clicks the Completed step header", () => {
      const parts: Part[] = [
        { type: "toolCall", id: "t1", name: "read", args: { path: "/x" } },
      ];
      const { container } = render(
        <MessageParts parts={parts} isStreaming={false} />,
      );
      // Pre-click: body collapsed
      expect(screen.queryByText("/x")).toBeNull();
      // Find the step header button via its "Completed" label
      const headerButton = screen.getByText(/Completed/i).closest("button");
      expect(headerButton).toBeTruthy();
      fireEvent.click(headerButton!);
      // Post-click: body expanded → "/x" appears in the DOM
      expect(screen.queryByText("/x")).not.toBeNull();
      // sanity: still has the read tool name rendered
      expect(container.textContent).toContain("read");
    });

    // Spec scenario: isStreaming 切到 false 后 fold 折叠, 但 turn 的
    // 最终结论 text (在 fold 外) 仍可见. 这是核心 spec: fold 只包
    // inference (thinking + tool + 中间推理 text), 仅有最后一条 text
    // part (turn 的最终结论) 渲染在 fold 外, 永远可见.
    it("auto-collapses the fold when isStreaming transitions from true to false, but keeps the final text visible (outside fold)", () => {
      const parts: Part[] = [
        { type: "thinking", text: "thinking-co" },
        { type: "text", text: "visible-reply" },
      ];
      const { rerender } = render(
        <MessageParts parts={parts} isStreaming={true} />,
      );
      // While streaming, fold is open → thinking button "思考" + text "visible-reply" both visible
      expect(screen.getByText(/思考/)).toBeTruthy();
      expect(screen.getByText("visible-reply")).toBeTruthy();
      // Transition to not streaming (same instance, same parts)
      rerender(
        <MessageParts parts={parts} isStreaming={false} />,
      );
      // Fold auto-collapses → thinking button NOT in DOM
      expect(screen.queryByText(/思考/)).toBeNull();
      // The text "visible-reply" is the LAST (and only) text part → the
      // turn's final conclusion → renders OUTSIDE the fold, stays visible
      expect(screen.getByText("visible-reply")).toBeTruthy();
    });

    // Regression: when the agent pauses on ask_user_question, the
    // isStreaming flag goes false → step body would auto-collapse → the
    // active AskUserQuestionCard becomes invisible to the user. The
    // card question only renders if the body is open, so this assertion
    // covers both "card rendered" and "body was forced open".
    it("force-opens the body when an active AskUserQuestionCard is present", () => {
      const parts: Part[] = [
        { type: "toolCall", id: "tc1", name: "ask_user_question", args: {} },
      ];
      const cardStates = new Map<string, CardState>([
        [
          "tc1",
          {
            id: "tc1",
            sessionId: "s1",
            question: "Color?",
            options: [{ label: "Red" }, { label: "Blue" }],
            multiSelect: false,
            status: "active",
          },
        ],
      ]);
      // isStreaming=false simulates the agent having paused waiting for
      // the user to answer the question.
      render(
        <MessageParts parts={parts} isStreaming={false} cardStates={cardStates} />,
      );
      // Without force-open, the body collapses (open = userOverride ?? isStreaming
      // = null ?? false = false) and "Color?" is not in the DOM. With the fix,
      // presence of cardStates.get("tc1") forces open=true and the card renders.
      expect(screen.getByText("Color?")).toBeTruthy();
    });

    // Spec scenario: 用户点击后 isStreaming 变化不覆盖. Once the user
    // manually expands the fold, subsequent isStreaming changes must NOT
    // override that choice. Implementation: `open = userOverride ?? isStreaming`,
    // so userOverride=true wins over isStreaming=true (true) and over
    // isStreaming=false (would be true because userOverride wins).
    // Note: test uses a toolCall (not text) because text is rendered OUTSIDE
    // the fold, so its visibility doesn't reflect fold state.
    it("preserves user override when isStreaming flips after a click", () => {
      const parts: Part[] = [
        { type: "toolCall", id: "t1", name: "read", args: { path: "/x" } },
      ];
      const { rerender } = render(
        <MessageParts parts={parts} isStreaming={false} />,
      );
      // Pre-click: fold collapsed, tool args not in DOM
      expect(screen.queryByText("/x")).toBeNull();
      // User clicks header to expand
      const headerButton = screen.getByText(/Completed/i).closest("button")!;
      fireEvent.click(headerButton);
      // Fold now open, tool args visible
      expect(screen.getByText("/x")).toBeTruthy();
      // isStreaming transitions false → true. User override must win.
      rerender(<MessageParts parts={parts} isStreaming={true} />);
      expect(screen.getByText("/x")).toBeTruthy();
      // isStreaming transitions true → false. User override STILL wins.
      rerender(<MessageParts parts={parts} isStreaming={false} />);
      expect(screen.getByText("/x")).toBeTruthy();
    });

    // Spec scenario: 多 text 中间夹 tool 顺序保留. Five parts in mixed
    // order: thinking, text(interim), toolCall, toolResult, text(final).
    // The fold contains inference + intermediate text (everything except
    // the LAST text part); only `final-text` renders OUTSIDE the fold as
    // the turn's final conclusion. Visible DOM order with isStreaming=true:
    // fold (思考 → interim-text → ToolGroup [bash, file1]) → final-text.
    it("preserves the order of 5 mixed parts (intermediate text inside fold, final text outside)", () => {
      const parts: Part[] = [
        { type: "thinking", text: "thinking-co-t" },
        { type: "text", text: "interim-text" },
        { type: "toolCall", id: "tc1", name: "bash", args: { command: "ls" } },
        { type: "toolResult", toolCallId: "tc1", content: "file1\nfile2" },
        { type: "text", text: "final-text" },
      ];
      render(<MessageParts parts={parts} isStreaming={true} />);
      // Fold open during streaming → all 5 visible.
      expect(screen.getByText("思考")).toBeTruthy();
      expect(screen.getByText("interim-text")).toBeTruthy();
      expect(screen.getByText("bash")).toBeTruthy();
      expect(screen.getByText("file1")).toBeTruthy();
      expect(screen.getByText("final-text")).toBeTruthy();
      // Order verification: fold content (思考, interim-text, bash, file1)
      // appears first in chronological order, then final-text after the
      // fold as the turn's final conclusion.
      const text = document.body.textContent ?? "";
      const positions = [
        "思考",
        "interim-text",
        "bash",
        "file1",
        "final-text",
      ].map((t) => text.indexOf(t));
      const sorted = [...positions].sort((a, b) => a - b);
      expect(positions).toEqual(sorted);
    });

    // Spec scenario: 5-part mixed turn with fold collapsed — only the
    // final text is visible. The fold auto-collapses on isStreaming=false
    // and hides inference + intermediate text. The final text (the LAST
    // text part in the turn) renders OUTSIDE the fold and remains visible
    // so the user can see the agent's conclusion without expanding the
    // step.
    it("keeps only the final text visible when fold auto-collapses after a 5-part mixed turn", () => {
      const parts: Part[] = [
        { type: "thinking", text: "thinking-co-t" },
        { type: "text", text: "interim-text" },
        { type: "toolCall", id: "tc1", name: "bash", args: { command: "ls" } },
        { type: "toolResult", toolCallId: "tc1", content: "file1\nfile2" },
        { type: "text", text: "final-text" },
      ];
      // isStreaming=false → fold collapsed
      render(<MessageParts parts={parts} isStreaming={false} />);
      // Fold content hidden: thinking button, tool name, tool result first
      // line, AND the intermediate text are all NOT in DOM (interim-text
      // is inside the fold body)
      expect(screen.queryByText("思考")).toBeNull();
      expect(screen.queryByText("interim-text")).toBeNull();
      expect(screen.queryByText("bash")).toBeNull();
      expect(screen.queryByText("file1")).toBeNull();
      // The final text is the LAST text part → OUTSIDE the fold, always
      // visible without expanding the step
      expect(screen.getByText("final-text")).toBeTruthy();
    });

    // Spec scenario: 1h+ 旧 turn 显示 elapsed 时间. timestamp = 1 hour ago,
    // isStreaming=false. StepHeader should display seconds count ≥ 3595
    // (allowing for setInterval drift / test wall-clock variance).
    it("renders the elapsed-since-timestamp seconds for an old completed turn", () => {
      const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
      const parts: Part[] = [
        { type: "thinking", text: "x" },
        { type: "text", text: "y" },
      ];
      render(
        <MessageParts parts={parts} isStreaming={false} timestamp={oneHourAgo} />,
      );
      // Header shows "(Ns)" with N >= 3595
      const text = document.body.textContent ?? "";
      const match = text.match(/\((\d+)s\)/);
      expect(match).not.toBeNull();
      const seconds = Number(match![1]);
      expect(seconds).toBeGreaterThanOrEqual(3595);
    });
  });

  describe("Text parts rendered OUTSIDE the fold wrapper", () => {
    // Spec scenario: thinking + text turn with isStreaming=false. The fold
    // (which wraps thinking) auto-collapses, but the text part is rendered
    // OUTSIDE the fold and remains visible. This is the core "text outside
    // fold" assertion.
    it("keeps text visible when fold is collapsed (thinking + text turn)", () => {
      const parts: Part[] = [
        { type: "thinking", text: "co-t-content" },
        { type: "text", text: "final-reply" },
      ];
      render(<MessageParts parts={parts} isStreaming={false} />);
      // Fold collapsed → thinking button NOT in DOM
      expect(screen.queryByText(/思考/)).toBeNull();
      expect(screen.queryByText("co-t-content")).toBeNull();
      // But text "final-reply" is rendered outside the fold, visible
      expect(screen.getByText("final-reply")).toBeTruthy();
    });

    // Spec scenario: toolCall + text turn with isStreaming=false. The fold
    // (which wraps toolCall via ToolGroup) auto-collapses, but the text
    // part is rendered OUTSIDE the fold and remains visible. This proves
    // the fold wraps ONLY inference, not text.
    it("keeps text visible when fold is collapsed (toolCall + text turn)", () => {
      const parts: Part[] = [
        { type: "toolCall", id: "t1", name: "read", args: { path: "/secret" } },
        { type: "text", text: "user-visible-reply" },
      ];
      render(<MessageParts parts={parts} isStreaming={false} />);
      // Fold collapsed → tool summary / args NOT in DOM
      expect(screen.queryByText("read")).toBeNull();
      expect(screen.queryByText("/secret")).toBeNull();
      // But text "user-visible-reply" is outside the fold, visible
      expect(screen.getByText("user-visible-reply")).toBeTruthy();
    });

    // Spec scenario: pure text turn never gains a fold wrapper. The text
    // is rendered as a plain TextItem with no StepHeader and no border.
    it("renders pure text turn as a plain TextItem, no fold wrapper at all", () => {
      const parts: Part[] = [{ type: "text", text: "hello-world" }];
      const { container } = render(
        <MessageParts parts={parts} isStreaming={false} />,
      );
      // Text visible
      expect(screen.getByText("hello-world")).toBeTruthy();
      // No step header (no fold)
      expect(screen.queryByText(/Execut|Completed/i)).toBeNull();
      // No thinking button (no fold, no ThinkingItem)
      expect(screen.queryByText(/思考/)).toBeNull();
      // No fold border (the rounded-lg class is only applied to the fold wrapper)
      // Pure text path returns <div className="flex flex-col gap-2"> which lacks
      // the fold's "rounded-lg border border-gray-200 bg-white" classes.
      const foldWrapper = container.querySelector(
        "div.rounded-lg.border.border-gray-200.bg-white",
      );
      expect(foldWrapper).toBeNull();
    });
  });
});
