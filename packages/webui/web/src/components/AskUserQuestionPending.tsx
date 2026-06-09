interface AskUserQuestionPendingProps {
  id: string;
  question: string;
}

export default function AskUserQuestionPending({ id, question }: AskUserQuestionPendingProps) {
  return (
    <div
      data-pending-question-id={id}
      data-testid="ask-user-question-pending"
      className="px-4 py-2 italic text-gray-500 flex items-center gap-2"
    >
      <span>⏳</span>
      <span>Waiting for user to answer: {question}</span>
    </div>
  );
}
