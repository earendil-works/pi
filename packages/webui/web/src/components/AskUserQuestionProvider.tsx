import { useEffect, useRef, useState, type ReactNode } from "react";
import { ws } from "../lib/api";
import AskUserQuestionModal from "./AskUserQuestionModal";

interface ModalState {
  sessionId: string;
  id: string;
  question: string;
  options: Array<{ label: string; description?: string }>;
  multiSelect: boolean;
}

export function AskUserQuestionProvider({ children }: { children: ReactNode }) {
  // Queue per-session
  const queuesRef = useRef<Map<string, ModalState[]>>(new Map());
  const [activeModal, setActiveModal] = useState<ModalState | null>(null);
  const [pendingCounts, setPendingCounts] = useState<Map<string, number>>(new Map());
  // Track whether a modal is visible to avoid stale closure issues in useEffect
  const isModalVisibleRef = useRef(false);

  function refreshActive() {
    // Find first non-empty queue (any session)
    for (const [sessionId, queue] of queuesRef.current) {
      if (queue.length > 0) {
        const [next, ...rest] = queue;
        if (rest.length === 0) {
          queuesRef.current.delete(sessionId);
        } else {
          queuesRef.current.set(sessionId, rest);
        }
        isModalVisibleRef.current = true;
        setActiveModal(next);
        updatePendingCounts();
        return;
      }
    }
    isModalVisibleRef.current = false;
    setActiveModal(null);
    updatePendingCounts();
  }

  function updatePendingCounts() {
    const counts = new Map<string, number>();
    let total = 0;
    for (const [sessionId, queue] of queuesRef.current) {
      counts.set(sessionId, queue.length);
      total += queue.length;
    }
    setPendingCounts(counts);
  }

  useEffect(() => {
    const unsub = ws.subscribe("session_event", (raw: unknown) => {
      const msg = raw as { type?: string; sessionId?: string; event?: any };
      if (msg.type !== "session_event") return;
      const event = msg.event;
      if (!event || event.type !== "extension_ui_request") return;
      if (event.method !== "select" && event.method !== "input") return;
      const sessionId = msg.sessionId ?? "";
      if (!sessionId) return;

      // Normalize options: server may send {item:[...]} or array
      let options: Array<{ label: string; description?: string }> = [];
      let rawOpts = event.options;
      while (rawOpts && typeof rawOpts === "object" && !Array.isArray(rawOpts) && "item" in rawOpts) {
        rawOpts = rawOpts.item;
      }
      if (Array.isArray(rawOpts)) {
        options = rawOpts
          .filter((o: any) => o && typeof o.label === "string")
          .map((o: any) => ({ label: o.label, description: typeof o.description === "string" ? o.description : undefined }));
      }

      // For method=input, no real options — synthesize a single "submit" option
      if (event.method === "input") {
        options = [{ label: "Submit", description: event.placeholder }];
      }

      const state: ModalState = {
        sessionId,
        id: event.id,
        question: event.title ?? event.message ?? "Please answer",
        options,
        multiSelect: event.method === "input", // input() = multi-select flow
      };

      const queue = queuesRef.current.get(sessionId) ?? [];
      queue.push(state);
      queuesRef.current.set(sessionId, queue);
      if (!isModalVisibleRef.current) {
        refreshActive();
      } else {
        updatePendingCounts();
      }
    });
    return unsub;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  function handleSubmit(value: string) {
    if (!activeModal) return;
    ws.send({ type: "extension_ui_response", id: activeModal.id, value });
    isModalVisibleRef.current = false;
    setActiveModal(null);
    refreshActive();
  }

  function handleCancel() {
    if (!activeModal) return;
    ws.send({ type: "extension_ui_response", id: activeModal.id, cancelled: true });
    isModalVisibleRef.current = false;
    setActiveModal(null);
    refreshActive();
  }

  const totalPending = Array.from(pendingCounts.values()).reduce((a, b) => a + b, 0);

  return (
    <>
      {children}
      {activeModal && (
        <AskUserQuestionModal
          isOpen={true}
          question={activeModal.question}
          options={activeModal.options}
          multiSelect={activeModal.multiSelect}
          onSubmit={handleSubmit}
          onCancel={handleCancel}
        />
      )}
      {totalPending > 0 && (
        <div
          className="fixed top-4 left-1/2 -translate-x-1/2 z-50 px-3 py-1 bg-yellow-100 border border-yellow-300 rounded-full text-xs text-yellow-800 shadow"
          data-testid="ask-user-question-pending"
        >
          ⏳ 还有 {totalPending} 个未答
        </div>
      )}
    </>
  );
}
