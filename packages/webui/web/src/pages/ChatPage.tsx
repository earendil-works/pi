import { useParams } from "react-router-dom";

export default function ChatPage() {
  const { id } = useParams<{ id: string }>();
  return (
    <div className="p-4">
      <h1 className="text-2xl font-bold">Chat: {id}</h1>
    </div>
  );
}
