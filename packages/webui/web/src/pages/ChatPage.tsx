import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ws, api } from "../lib/api";
import type { Message, InputImage, Part } from "../lib/api";
import { Title } from "../components/topbar/Title";
import { Actions } from "../components/topbar/Actions";
import { ModelSelector } from "../components/topbar/ModelSelector";
import { InputArea } from "../components/input/InputArea";
import ChatMessages from "../components/ChatMessages";
import { ThinkingIndicator } from "../components/ThinkingIndicator";
import AskUserQuestionPending from "../components/AskUserQuestionPending";

function buildParts(content: any): Part[] {
  if (!Array.isArray(content)) return [];
  return content.map((c: any): Part => {
    if (c.type === "text") return { type: "text", text: c.text ?? "" };
    if (c.type === "thinking") return { type: "thinking", text: c.text ?? "" };
    if (c.type === "toolCall") return { type: "toolCall", id: c.id ?? "", name: c.name ?? "", args: c.arguments ?? c.args ?? {} };
    if (c.type === "toolResult") return { type: "toolResult", toolCallId: c.toolCallId ?? "", content: typeof c.content === "string" ? c.content : JSON.stringify(c.content ?? "") };
    if (c.type === "image") return { type: "image", mediaType: c.mediaType, data: c.data };
    return { type: "text", text: "?" };
  });
}

export default function ChatPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [inputText, setInputText] = useState("");
  const [inputImages, setInputImages] = useState<InputImage[]>([]);
  const [currentModel, setCurrentModel] = useState<{provider: string, model: string} | null>(null);
  const [providers, setProviders] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(false);
  const [isManaged, setIsManaged] = useState<boolean | null>(null);
  const [sessionStatus, setSessionStatus] = useState<"running" | "idle" | "reconnecting" | "error">("idle");
  // Drives the "thinking..." indicator visibility. Toggled by:
  //   - handleSubmit: set true (we just sent a prompt)
  //   - message_update (assistant, first of turn): set false (real text is streaming)
  //   - session_status_changed: idle → set false; running → set true
  //   - id change: set false (new session, not yet responding)
  const [isThinking, setIsThinking] = useState<boolean>(false);
  // Tracks pending ask_user_question placeholders keyed by request id.
  // Populated on extension_ui_request (select/input), cleared on
  // tool_execution_end with toolName=ask_user_question.
  const [pendingQuestions, setPendingQuestions] = useState<Map<string, { id: string; question: string }>>(new Map());
  const [title, setTitle] = useState<string>("");
  const [messageCount, setMessageCount] = useState<number>(0);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const streamingMsgId = useRef<string | null>(null);

  // Load messages + current model + providers on mount / id change
  useEffect(() => {
    if (!id) return;
    // Clear thinking indicator + streaming ref synchronously so a new
    // session doesn't inherit the previous session's "thinking" state.
    setIsThinking(false);
    let cancelled = false;
    async function init() {
      setIsLoading(true);
      try {
        const [msgs, settings, modelsResp, sessions] = await Promise.all([
          api.getMessages(id!),
          api.getSettings().catch(() => ({})),
          api.getModels().catch(() => ({providers: []})),
          api.listSessions().catch(() => []),
        ]);
        if (!cancelled) {
          setMessages(msgs);
          setProviders(modelsResp.providers ?? []);
          const session = sessions.find((s: any) => s.id === id);
          setIsManaged(session?.isManaged ?? null);
          setTitle(session?.title || "New chat");
          // Use the count from /api/sessions, not msgs.length, so the header
          // shows the true JSONL count even when the messages array is
          // paginated (default limit=200) or TUI sessions with thousands
          // of messages. Falls back to msgs.length if the list hasn't
          // returned yet (e.g. sessions API failed).
          setMessageCount(session?.messageCount ?? msgs.length);
          // Clear any draft from a previous session so we don't carry typed
          // text into a different (possibly TUI-owned) session.
          setInputText("");
          setInputImages([]);
          // Default the model selector to:
          //   1. session's current model from model_change in JSONL (highest
          //      priority — this is the model the session is actually
          //      configured to use; the user explicitly picked it via the
          //      webui's set_model RPC or the TUI's /model command)
          //   2. the most recent assistant message's (provider, model)
          //      — handles the case where the session was created without
          //        a model_change but an assistant response already used
          //        a model
          //   3. settings.defaultProvider / defaultModel (system default —
          //      this is what the pi process actually uses for a fresh
          //      session, so the selector must match)
          //   4. settings.webui.defaultModel (UI preference — only used if
          //      no system default is set, since otherwise the selector
          //      would show a model that the running pi process isn't using)
          //   5. (none) — selector hidden until user picks one
          const s = settings as any;
          let modelPicked: { provider: string; model: string } | null = null;

          const currentModel = await api.getSessionModel(id!).catch(() => null);
          if (currentModel && currentModel.provider && currentModel.model) {
            modelPicked = { provider: currentModel.provider, model: currentModel.model };
          }

          if (!modelPicked) {
            for (let i = msgs.length - 1; i >= 0; i--) {
              const m = msgs[i];
              if (m.role === "assistant" && m.provider && m.model) {
                modelPicked = { provider: m.provider, model: m.model };
                break;
              }
            }
          }
          if (!modelPicked && s?.defaultProvider && s?.defaultModel) {
            modelPicked = { provider: s.defaultProvider, model: s.defaultModel };
          }
          if (!modelPicked && s?.webui?.defaultModel) {
            const [provider, model] = s.webui.defaultModel.split("/");
            if (provider && model) modelPicked = { provider, model };
          }
          if (modelPicked) setCurrentModel(modelPicked);
        }
      } catch (err) {
        console.error("init failed:", err);
      } finally {
        if (!cancelled) setIsLoading(false);
      }
    }
    init();
    setInputText("");
    setInputImages([]);
    return () => { cancelled = true; };
  }, [id]);

  // WebSocket subscribe
  useEffect(() => {
    if (!id) return;
    ws.connect();
    // If the singleton WS is already in OPEN state (because the user is
    // navigating from a previous chat page that left the connection up),
    // the `open` event will not re-fire. Send subscribe immediately so the
    // server starts forwarding events for this session; otherwise the
    // first message_start / message_update arrives but the server's
    // state.activeSession for our WS is still the previous session, and
    // the new session renders blank.
    if (ws.isOpen()) {
      ws.send({ type: "subscribe", sessionId: id });
    }
    const unsubOpen = ws.subscribe("open", () => {
      ws.send({ type: "subscribe", sessionId: id });
    });
    const unsub = ws.subscribe("session_event", (msg: any) => {
      if (msg.sessionId !== id) return;
      const e = msg.event;
      if (!e) return;

      if (e.type === "message_start" && e.message?.role === "assistant") {
        // pi RPC events don't include message.id; we generate one and use
        // it as the streaming key so subsequent message_update / message_end
        // events with the same id find the same message.
        const realId = e.message.id || streamingMsgId.current || crypto.randomUUID();
        streamingMsgId.current = realId;
        const parts = buildParts(e.message.content);
        setMessages(prev => {
          const idx = prev.findIndex(m => m.id === realId);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = { ...updated[idx], parts, model: e.message.model, provider: e.message.provider };
            return updated;
          }
          // Avoid duplicating: only reuse an empty assistant bubble if it was
          // the MOST RECENT one — an old empty bubble from a past aborted
          // turn (still in state because the user reloaded the page) is
          // NOT the right target. findIndex returns the FIRST match, which
          // can be hundreds of messages old; using it inserts the new
          // assistant far above the current user message that triggered it,
          // and the resulting out-of-order state renders as a garbled
          // multi-message bubble via ChatMessages' turn-grouping. Always
          // appending is the safe behavior: a stale empty bubble in the
          // old position will still show "(empty turn)" but it won't
          // silently eat the new reply.
          return [...prev, { id: realId, sessionId: id!, role: "assistant", parts, timestamp: new Date().toISOString(), model: e.message.model, provider: e.message.provider }];
        });
      } else if (e.type === "message_update" && e.message?.role === "assistant") {
        // message_update may come WITHOUT a prior message_start (depends on
        // pi's RPC implementation) AND pi RPC events don't include message.id.
        // In that case neither e.message.id nor streamingMsgId.current is set
        // — generate a tracking id and continue so the assistant's first
        // streaming reply is rendered, not silently dropped until the next
        // polling cycle. The next event for the same turn (message_start or
        // message_end) will fall through to the same streamingMsgId.current
        // and update the existing bubble instead of creating a duplicate.
        const msgId = e.message.id || streamingMsgId.current || crypto.randomUUID();
        streamingMsgId.current = msgId;
        const parts = buildParts(e.message.content);
        setMessages(prev => {
          const idx = prev.findIndex(m => m.id === msgId);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = { ...updated[idx], parts, usage: e.message.usage, model: e.message.model, provider: e.message.provider };
            return updated;
          }
          // No existing message — create one. The next message_start for the
          // same logical turn will reconcile its id.
          return [...prev, { id: msgId, sessionId: id!, role: "assistant", parts, timestamp: new Date().toISOString(), usage: e.message.usage, model: e.message.model, provider: e.message.provider }];
        });
        // First streaming token of this turn — the model is now actually
        // producing output, hide the "thinking..." indicator.
        setIsThinking(false);
      } else if (e.type === "message_end") {
        const message = e.message;
        if (message?.role === "assistant") {
          // message_end should reconcile with the in-flight streaming message.
          // Prefer the streaming id (the one we set on message_start) so
          // updates and end events hit the same message.
          const msgId = streamingMsgId.current || message.id || crypto.randomUUID();
          streamingMsgId.current = null;
          const parts = buildParts(message.content);
          setMessages(prev => {
            const idx = prev.findIndex(m => m.id === msgId);
            if (idx >= 0) {
              const updated = [...prev];
              updated[idx] = { ...updated[idx], parts, usage: message.usage, model: message.model, provider: message.provider };
              return updated;
            }
            return [...prev, { id: msgId, sessionId: id!, role: "assistant", parts, timestamp: new Date().toISOString(), usage: message.usage, model: message.model, provider: message.provider }];
          });
        }
      } else if (e.type === "session_status_changed") {
        setSessionStatus(e.status);
        // Hide the indicator once the model reports it's done. If the
        // server reports running, show it (covers the case where the
        // stream_started event was missed — e.g. mid-reconnect).
        if (e.status === "idle") {
          setIsThinking(false);
        } else if (e.status === "running") {
          setIsThinking(true);
        }
      } else if (e.type === "extension_ui_request" && (e.method === "select" || e.method === "input")) {
        // Show pending question placeholder while waiting for user to answer.
        setPendingQuestions((prev) => new Map(prev).set(e.id, { id: e.id, question: e.title ?? e.message ?? "" }));
      } else if (e.type === "tool_execution_end" && e.toolName === "ask_user_question") {
        // User answered or the tool finished — remove the placeholder.
        setPendingQuestions((prev) => {
          const next = new Map(prev);
          next.delete(e.toolCallId ?? e.id);
          return next;
        });
      }
    });
    return () => { unsubOpen(); unsub(); };
  }, [id]);

  // Poll for external messages (e.g. from TUI writing to same JSONL)
  useEffect(() => {
    if (!id) return;
    let cancelled = false;
    const interval = setInterval(async () => {
      if (cancelled) return;
      try {
        const msgs = await api.getMessages(id);
        if (cancelled) return;
        setMessages(prev => {
          // Build a content-only fingerprint for each existing message so the
          // poll can't add a JSONL-side copy of something we already have
          // from a streaming WS event. WS message id (random UUID) differs
          // from JSONL entry id (pi's actual id), and WS timestamp is the
          // React-receive time vs JSONL's actual stamp — so we can only
          // match by content. Same role + same concatenated part text /
          // toolCallId = same message.
          const sig = (m: { role: string; parts: Array<Record<string, unknown>> }) => {
            const body = m.parts
              .map(p => {
                if (p.type === "text" || p.type === "thinking") return (p as any).text ?? "";
                if (p.type === "toolCall") return `tc:${(p as any).id ?? ""}`;
                if (p.type === "toolResult") return `tr:${(p as any).toolCallId ?? ""}`;
                if (p.type === "image") return `img`;
                return JSON.stringify(p);
              })
              .join("|");
            return `${m.role}|${body}`;
          };
          // Build lookup maps keyed by content signature, separately for
          // the current state and the freshly polled messages. The merge
          // uses the polled version to fill in fields the WS streaming
          // path doesn't carry (provider, authoritative timestamp, usage).
          const prevBySig = new Map(prev.map(m => [sig(m), m]));
          const polledBySig = new Map(msgs.map(m => [sig(m), m]));
          let changed = false;
          // First pass: merge field updates from polled messages into
          // existing same-signature messages. The WS streaming path
          // sometimes creates messages with only `model` (no provider)
          // and may have older timestamp / no usage; the JSONL side is
          // authoritative for those once the file is written, so adopt
          // the polled values when they differ.
          const merged = prev.map(existing => {
            const polled = polledBySig.get(sig(existing));
            if (!polled) return existing;
            const needsUpdate =
              (polled.provider && !existing.provider) ||
              (polled.model && existing.model !== polled.model) ||
              (polled.usage && !existing.usage) ||
              (polled.timestamp && existing.timestamp !== polled.timestamp);
            if (!needsUpdate) return existing;
            changed = true;
            return {
              ...existing,
              model: polled.model ?? existing.model,
              provider: polled.provider ?? existing.provider,
              usage: polled.usage ?? existing.usage,
              timestamp: polled.timestamp ?? existing.timestamp,
            };
          });
          // Second pass: append truly new messages (no signature match
          // in the prior state).
          const newMsgs = msgs.filter(m => !prevBySig.has(sig(m)));
          if (!changed && newMsgs.length === 0) return prev;
          return [...merged, ...newMsgs];
        });
      } catch { /* ignore */ }
    }, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [id]);

  // Scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
    // Prefer the server-provided total (true JSONL message count, set on
    // initial load). If the loaded window is larger than the cached total
    // (e.g. streaming added messages since the list was fetched), trust
    // the in-memory count instead.
    setMessageCount((prev) => Math.max(prev, messages.length));
  }, [messages]);

  // Submit
  const handleSubmit = useCallback(() => {
    const text = inputText.trim();
    if (!text || !id) return;
    if (!ws.isOpen()) {
      alert("Connection not ready, please wait a moment and try again.");
      return;
    }
    setInputText("");
    setInputImages([]);
    // Optimistic user message
    const userParts: Part[] = [{type: "text", text}];
    inputImages.forEach(img => {
      const base64 = img.dataUrl.split(",")[1] ?? "";
      userParts.push({type: "image", mediaType: img.mediaType, data: base64});
    });
    setMessages(prev => [...prev, {
      id: crypto.randomUUID(),
      sessionId: id,
      role: "user",
      parts: userParts,
      timestamp: new Date().toISOString(),
    }]);
    // Send WS — also include sessionId so the server can route even if our
    // subscribe message hasn't been processed yet (singleton WS that's
    // already OPEN when the page mounts doesn't re-fire the open event).
    ws.send({
      type: "prompt",
      text,
      images: inputImages.map(img => ({
        mediaType: img.mediaType,
        data: img.dataUrl.split(",")[1] ?? "",
      })),
      sessionId: id,
    });
    // Show the thinking indicator optimistically. The server's
    // session_status_changed("running") will arrive almost immediately and
    // re-affirm it. The first message_update will clear it.
    setIsThinking(true);
  }, [inputText, inputImages, id]);

  // Clear
  const handleClear = useCallback(() => {
    setMessages([]);
  }, []);

  // Abort the in-flight pi turn. Sends the same `abort` RPC the TUI sends
  // when the user presses Esc. The model stream ends, the server emits
  // agent_end, the session-pool translates that into session_status_changed
  // ("idle"), and isThinking flips back to false — clearing the Stop button.
  const handleAbort = useCallback(() => {
    if (!ws.isOpen()) return;
    ws.send({ type: "abort" });
  }, []);

  if (!id) return <div className="flex items-center justify-center h-full"><p>Session not found</p></div>;

  return (
    <div className="flex flex-col h-full">
      {/* Topbar - sticky */}
      <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 border-b border-stone-200 bg-stone-50">
        <Title title={title} messageCount={messageCount} />
        <div className="flex items-center gap-2">
          {currentModel && (
            <ModelSelector
              current={currentModel}
              providers={providers}
              onChange={async (sel) => {
                setCurrentModel(sel);
                try {
                  await api.setDefaultModel(sel);
                } catch (e) { console.error(e); }
              }}
            />
          )}
          <Actions onClear={handleClear} onSettings={() => {}} />
        </div>
      </div>
      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        {pendingQuestions.size > 0 && (
          <div className="border-b border-stone-200">
            {Array.from(pendingQuestions.values()).map((p) => (
              <AskUserQuestionPending key={p.id} id={p.id} question={p.question} />
            ))}
          </div>
        )}
        <ChatMessages messages={messages} />
        {isThinking && <ThinkingIndicator />}
        <div ref={messagesEndRef} />
      </div>
      {/* Non-managed session notice */}
      {isManaged === false && (
        <div className="px-4 py-3 bg-amber-50 border-t border-amber-200 text-amber-800 text-sm flex items-center gap-2">
          <span className="px-1.5 py-0.5 text-[10px] font-semibold rounded bg-amber-200 text-amber-900 uppercase tracking-wider">
            TUI
          </span>
          <span>
            This session is owned by the TUI. You can view its history here,
            but messages must be sent from the TUI.
          </span>
        </div>
      )}
      {/* Input */}
      <InputArea
        images={inputImages}
        text={inputText}
        onChangeText={setInputText}
        onAddImage={(img) => setInputImages(prev => [...prev, img])}
        onRemoveImage={(id) => setInputImages(prev => prev.filter(i => i.id !== id))}
        onError={(reason) => {
          const messages: Record<string, string> = {
            type: "Unsupported image type",
            size: "Image too large, max 5MB",
            count: "Max 4 images per message",
            total: "Total image size exceeds 20MB",
          };
          alert(messages[reason] ?? "Image error");
        }}
        onSubmit={handleSubmit}
        // Drive the Stop button from sessionStatus (the source of truth
        // emitted by the session-pool as "running" on prompt() and "idle"
        // on agent_end), not from isThinking. message_update fires for
        // tool calls as well as text, so a turn that streams text then
        // invokes a tool would otherwise flip isThinking to false on the
        // first token and leave the user with no way to abort the still-
        // running tool. sessionStatus stays "running" through the entire
        // turn (text + every tool call) and only flips to "idle" when
        // agent_end arrives.
        onAbort={sessionStatus === "running" ? handleAbort : undefined}
        disabled={isLoading || isManaged === false}
      />
    </div>
  );
}
