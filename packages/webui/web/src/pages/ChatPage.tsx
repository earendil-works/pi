import { useCallback, useEffect, useRef, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { Send, Trash2, ArrowLeft } from "lucide-react";
import { ws, api } from "../lib/api";
import type { Message } from "../lib/api";
import ChatMessages from "../components/ChatMessages";

export default function ChatPage() {
  const { id } = useParams<{ id: string }>();
  
  const navigate = useNavigate();
  const [messages, setMessages] = useState<Message[]>([]);
  const [streamingContent, setStreamingContent] = useState<string>("");
  const [inputValue, setInputValue] = useState("");
  const [isLoading, setIsLoading] = useState(false);
  const [isConnected, setIsConnected] = useState(false);
  const messagesEndRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  const unsubscribesRef = useRef<(() => void)[]>([]);

  // Fetch initial messages and set up WebSocket
  useEffect(() => {
    if (!id) return;

    let cancelled = false;

    async function init() {
      setIsLoading(true);
      try {
        // Fetch existing messages
        const msgs = await api.getMessages(id!);
        if (!cancelled) {
          setMessages(msgs);
        }
      } catch (err) {
        if (!cancelled) {
          console.error("Failed to load messages:", err);
        }
      } finally {
        if (!cancelled) {
          setIsLoading(false);
        }
      }
    }

    init();

    // Connect WebSocket and subscribe
    ws.connect();

    // Subscribe to session events
    const unsubSession = ws.subscribe("session_event", (msg: unknown) => {
      const event = msg as { sessionId?: string; type?: string; content?: string };
      if (event.sessionId !== id) return;

      if (event.type === "message_update") {
        setStreamingContent(event.content ?? "");
      }
    });

    // Subscribe to message events (for new messages)
    const unsubMessage = ws.subscribe("message", (msg: unknown) => {
      const message = msg as { sessionId?: string; role?: string; content?: string };
      if (message.sessionId !== id) return;
      const role = message.role;
      const content = message.content;
      if (role && content) {
        setMessages((prev) => [
          ...prev,
          {
            id: crypto.randomUUID(),
            sessionId: id!,
            role: role as "user" | "assistant" | "system",
            content,
            timestamp: new Date().toISOString(),
          },
        ]);
      }
    });

    // Subscribe to streaming done
    const unsubDone = ws.subscribe("stream_end", (msg: unknown) => {
      const event = msg as { sessionId?: string };
      if (event.sessionId !== id) return;
      setStreamingContent((prev) => {
        if (prev) {
          // Finalize streaming content as a new message
          setMessages((msgs) => [
            ...msgs,
            {
              id: crypto.randomUUID(),
              sessionId: id!,
              role: "assistant",
              content: prev,
              timestamp: new Date().toISOString(),
            },
          ]);
        }
        return "";
      });
    });

    // Connection status
    const unsubOpen = ws.subscribe("open", () => {
      setIsConnected(true);
      // Subscribe to the session on the server
      ws.send({ type: "subscribe", sessionId: id! });
    });

    unsubscribesRef.current = [
      unsubSession,
      unsubMessage,
      unsubDone,
      unsubOpen,
    ];

    return () => {
      cancelled = true;
      // Unsubscribe all
      unsubscribesRef.current.forEach((unsub) => unsub());
      unsubscribesRef.current = [];
    };
  }, [id]);

  // Scroll to bottom when messages change
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages, streamingContent]);

  const handleSubmit = useCallback(
    (e: React.FormEvent) => {
      e.preventDefault();
      const text = inputValue.trim();
      if (!text || !id) return;

      setInputValue("");
      setStreamingContent(text); // Show user message immediately as streaming
      setMessages((prev) => [
        ...prev,
        {
          id: crypto.randomUUID(),
          sessionId: id!,
          role: "user",
          content: text,
          timestamp: new Date().toISOString(),
        },
      ]);

      // Send via WebSocket
      ws.send({ type: "prompt", text, sessionId: id! });
    },
    [inputValue, id]
  );

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        handleSubmit(e);
      }
    },
    [handleSubmit]
  );

  const handleDelete = useCallback(async () => {
    if (!id) return;
    if (!window.confirm("Delete this session? This cannot be undone.")) {
      return;
    }

    try {
      await api.deleteSession(id);
      navigate("/sessions");
    } catch (err) {
      console.error("Failed to delete session:", err);
      alert("Failed to delete session. Please try again.");
    }
  }, [id, navigate]);

  if (!id) {
    return (
      <div className="flex items-center justify-center h-full">
        <p className="text-gray-500">Session not found</p>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Header */}
      <div className="flex items-center justify-between px-4 py-3 border-b border-gray-200 bg-white">
        <div className="flex items-center gap-3">
          <button
            onClick={() => navigate("/sessions")}
            className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-md transition-colors"
            title="Back to sessions"
          >
            <ArrowLeft className="w-5 h-5" />
          </button>
          <div className="flex items-center gap-2">
            <h1 className="text-lg font-semibold text-gray-900">Chat</h1>
            {!isLoading && (
              <span
                className={`w-2 h-2 rounded-full ${
                  isConnected ? "bg-green-500" : "bg-gray-300"
                }`}
                title={isConnected ? "Connected" : "Disconnected"}
              />
            )}
          </div>
        </div>
        <button
          onClick={handleDelete}
          className="flex items-center gap-2 px-3 py-2 text-sm text-red-600 hover:bg-red-50 rounded-md transition-colors"
          title="Delete session"
        >
          <Trash2 className="w-4 h-4" />
          Delete Session
        </button>
      </div>

      {/* Messages */}
      <div className="flex-1 overflow-y-auto">
        <ChatMessages messages={messages} streamingContent={streamingContent} />
        <div ref={messagesEndRef} />
      </div>

      {/* Input */}
      <form onSubmit={handleSubmit} className="p-4 border-t border-gray-200 bg-white">
        <div className="flex gap-3">
          <textarea
            ref={inputRef}
            value={inputValue}
            onChange={(e) => setInputValue(e.target.value)}
            onKeyDown={handleKeyDown}
            placeholder="Type your message..."
            rows={1}
            className="flex-1 resize-none rounded-md border border-gray-300 px-4 py-3 text-sm focus:outline-none focus:ring-2 focus:ring-blue-500 focus:border-transparent"
            style={{ maxHeight: "120px" }}
          />
          <button
            type="submit"
            disabled={!inputValue.trim()}
            className="px-4 py-2 bg-blue-600 text-white rounded-md hover:bg-blue-700 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            <Send className="w-5 h-5" />
          </button>
        </div>
      </form>
    </div>
  );
}