import { describe, it, expect, vi } from "vitest";
import { render, screen } from "@testing-library/react";
import type React from "react";
import { MessageBubble } from "./MessageBubble";
import type { Message } from "../../lib/api";

// Task 2.1 RED: stub MessageParts so we can assert prop forwarding without
// depending on the real component's internal rendering. We wrap the real
// MessageParts with a side-car stub div (data-testid="mp") that exposes
// `isStreaming` and `timestamp` as data-attributes. The wrapper keeps the
// real rendering for the existing tests (e.g. "assistant message renders
// header + parts + footer") so the mock is scoped to prop inspection only.
vi.mock("./MessageParts", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./MessageParts")>();
  const Original = actual.MessageParts;
  type Props = React.ComponentProps<typeof Original>;
  const Wrapped = (props: Props) => (
    <>
      <Original {...props} />
      <div
        data-testid="mp"
        data-streaming={String(props.isStreaming)}
        data-ts={props.timestamp}
      />
    </>
  );
  return { MessageParts: Wrapped };
});

describe("MessageBubble", () => {
  const baseUserMessage: Message = {
    id: "1",
    sessionId: "s1",
    role: "user",
    parts: [],
    timestamp: "2024-01-01T00:00:00.000Z",
  };

  const baseAssistantMessage: Message = {
    id: "2",
    sessionId: "s1",
    role: "assistant",
    parts: [],
    timestamp: "2024-01-01T00:00:01.000Z",
  };

  // Test 1: user message renders text parts
  it("user message renders text part", () => {
    const message: Message = {
      ...baseUserMessage,
      parts: [{ type: "text", text: "Hello world" }],
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText("Hello world")).toBeTruthy();
  });

  // Test 2: user message with image shows 40x40 thumbnail
  it("user message with image shows 40x40 thumbnail", () => {
    const message: Message = {
      ...baseUserMessage,
      parts: [
        { type: "text", text: "Check this" },
        { type: "image", mediaType: "image/png", data: "abc123" },
      ],
    };
    render(<MessageBubble message={message} />);
    const img = screen.getByRole("img");
    expect(img).toBeTruthy();
    expect(img.className).toContain("w-10");
    expect(img.className).toContain("h-10");
  });

  // Test 3: assistant message renders header + parts + footer
  it("assistant message renders header + parts + footer", () => {
    const message: Message = {
      ...baseAssistantMessage,
      model: "gpt-4",
      parts: [{ type: "text", text: "I am an assistant" }],
      usage: { input: 100, output: 200 },
    };
    render(<MessageBubble message={message} />);
    expect(screen.getByText("pi")).toBeTruthy();
    expect(screen.getByText("gpt-4")).toBeTruthy();
    expect(screen.getByText("I am an assistant")).toBeTruthy();
  });

  // Test 4: assistant message without usage does not render footer
  it("assistant message without usage does not render footer", () => {
    const message: Message = {
      ...baseAssistantMessage,
      parts: [{ type: "text", text: "No usage info" }],
    };
    const { container } = render(<MessageBubble message={message} />);
    expect(container.querySelector(".text-right")).toBeNull();
  });

  // Test 5: assistant message without model does not render model badge
  it("assistant message without model does not render model badge", () => {
    const message: Message = {
      ...baseAssistantMessage,
      parts: [{ type: "text", text: "No model" }],
    };
    render(<MessageBubble message={message} />);
    // Model badge has bg-stone-100 class - should not be present without model
    const modelBadges = document.querySelectorAll('[class*="bg-stone-100"]');
    expect(modelBadges.length).toBe(0);
  });

  // Test 6: toolResult message does not throw (returns null or placeholder)
  it("toolResult message does not throw and returns placeholder", () => {
    const message: Message = {
      id: "3",
      sessionId: "s1",
      role: "toolResult",
      parts: [{ type: "toolResult", toolCallId: "tc1", content: "result content" }],
      timestamp: "2024-01-01T00:00:02.000Z",
    };
    expect(() => render(<MessageBubble message={message} />)).not.toThrow();
    const text = screen.getByText(/tc1.*result/);
    expect(text).toBeTruthy();
  });

  // Test 7: forwards isStreaming and timestamp to MessageParts (Task 2.1 RED)
  // MessageBubble must accept `isStreaming` and forward both `isStreaming`
  // and `message.timestamp` to MessageParts, so StepHeader can render the
  // "● Executing (Xs) ▼" status + duration when streaming.
  it("forwards isStreaming and timestamp to MessageParts", () => {
    const message: Message = {
      ...baseAssistantMessage,
      parts: [
        { type: "thinking", text: "Let me think..." },
        { type: "text", text: "Done." },
      ],
      timestamp: "2026-06-24T15:00:00.000Z",
    };
    // @ts-expect-error -- `isStreaming` prop is added in Task 2.2 (GREEN).
    render(<MessageBubble message={message} isStreaming={true} />);
    const stub = screen.getByTestId("mp");
    expect(stub.getAttribute("data-streaming")).toBe("true");
    expect(stub.getAttribute("data-ts")).toBe("2026-06-24T15:00:00.000Z");
  });
});
