import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { ws, api } from "../lib/api";
import type { Message, InputImage, Part } from "../lib/api";
import { Title } from "../components/topbar/Title";
import { Actions } from "../components/topbar/Actions";
import { ModelSelector } from "../components/topbar/ModelSelector";
import { InputArea } from "../components/input/InputArea";
import ChatMessages from "../components/ChatMessages";

function buildParts(content: any): Part[] {
  if (!Array.isArray(content)) return [];
  return content.map((c: any): Part => {
    if (c.type === "text") return { type: "text", text: c.text ?? "" };
    if (c.type === "thinking") return { type: "thinking", text: c.text ?? "" };
    if (c.type === "toolCall") return { type: "toolCall", id: c.id ?? "", name: c.name ?? "", args: c.args ?? {} };
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
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const streamingMsgId = useRef<string | null>(null);

  // Load messages + current model + providers on mount / id change
  useEffect(() => {
    if (!id) return;
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
          setIsManaged(session?.isManaged ?? false);
          const s = settings as any;
          if (s?.webui?.defaultModel) {
            const [provider, model] = s.webui.defaultModel.split("/");
            if (provider && model) setCurrentModel({provider, model});
          }
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
    const unsubOpen = ws.subscribe("open", () => {
      ws.send({ type: "subscribe", sessionId: id });
    });
    const unsub = ws.subscribe("session_event", (msg: any) => {
      if (msg.sessionId !== id) return;
      const e = msg.event;
      if (!e) return;

      if (e.type === "message_start" && e.message?.role === "assistant") {
        const realId = e.message.id || crypto.randomUUID();
        streamingMsgId.current = realId;
        const parts = buildParts(e.message.content);
        setMessages(prev => {
          const idx = prev.findIndex(m => m.role === "assistant" && m.parts.length === 0);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = { ...updated[idx], id: realId, parts, model: e.message.model };
            return updated;
          }
          return [...prev, { id: realId, sessionId: id!, role: "assistant", parts, timestamp: new Date().toISOString(), model: e.message.model }];
        });
      } else if (e.type === "message_update" && e.message?.role === "assistant") {
        const parts = buildParts(e.message.content);
        const msgId = e.message.id || streamingMsgId.current;
        if (!msgId) return;
        streamingMsgId.current = msgId;
        setMessages(prev => {
          const idx = prev.findIndex(m => m.id === msgId);
          if (idx >= 0) {
            const updated = [...prev];
            updated[idx] = { ...updated[idx], parts, usage: e.message.usage, model: e.message.model };
            return updated;
          }
          return [...prev, { id: msgId, sessionId: id!, role: "assistant", parts, timestamp: new Date().toISOString(), usage: e.message.usage, model: e.message.model }];
        });
      } else if (e.type === "message_end") {
        const message = e.message;
        if (message?.role === "assistant") {
          const msgId = message.id || streamingMsgId.current;
          streamingMsgId.current = null;
          if (msgId) {
            const parts = buildParts(message.content);
            setMessages(prev => {
              const idx = prev.findIndex(m => m.id === msgId);
              if (idx >= 0) {
                const updated = [...prev];
                updated[idx] = { ...updated[idx], parts, usage: message.usage, model: message.model };
                return updated;
              }
              return [...prev, { id: msgId, sessionId: id!, role: "assistant", parts, timestamp: new Date().toISOString(), usage: message.usage, model: message.model }];
            });
          }
        }
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
          const prevIds = new Set(prev.map(m => m.id));
          const newMsgs = msgs.filter(m => !prevIds.has(m.id));
          if (newMsgs.length === 0) return prev;
          return [...prev, ...newMsgs];
        });
      } catch { /* ignore */ }
    }, 3000);
    return () => { cancelled = true; clearInterval(interval); };
  }, [id]);

  // Scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  // Submit
  const handleSubmit = useCallback(() => {
    const text = inputText.trim();
    if (!text || !id) return;
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
    // Send WS
    ws.send({
      type: "prompt",
      text,
      images: inputImages.map(img => ({
        mediaType: img.mediaType,
        data: img.dataUrl.split(",")[1] ?? "",
      })),
      sessionId: id,
    });
  }, [inputText, inputImages, id]);

  // Clear
  const handleClear = useCallback(() => {
    setMessages([]);
  }, []);

  if (!id) return <div className="flex items-center justify-center h-full"><p>Session not found</p></div>;

  return (
    <div className="flex flex-col h-full">
      {/* Topbar - sticky */}
      <div className="sticky top-0 z-10 flex items-center justify-between px-4 py-3 border-b border-stone-200 bg-stone-50">
        <Title title="Chat" messageCount={messages.length} />
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
        <ChatMessages messages={messages} />
        <div ref={messagesEndRef} />
      </div>
      {/* Non-managed session notice */}
      {isManaged === false && (
        <div className="px-4 py-2 bg-amber-50 border-t border-amber-200 text-amber-700 text-sm">
          This session is managed by TUI. Continue in TUI to send messages, or create a new session in WebUI.
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
        disabled={isLoading || isManaged === false}
      />
    </div>
  );
}
