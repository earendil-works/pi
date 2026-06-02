import { MessageSquare } from "lucide-react";

export default function EmptyChat() {
  return (
    <div className="flex items-center justify-center h-full bg-gray-50">
      <div className="text-center max-w-md p-8">
        <div className="inline-flex items-center justify-center w-16 h-16 rounded-full bg-blue-100 mb-4">
          <MessageSquare className="w-8 h-8 text-blue-600" />
        </div>
        <h2 className="text-xl font-semibold text-gray-900 mb-2">
          Start a new chat
        </h2>
        <p className="text-gray-600">
          Click <span className="font-medium">+ New Chat</span> in the sidebar to begin a new conversation, or pick an existing one.
        </p>
      </div>
    </div>
  );
}
