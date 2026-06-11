import React from 'react';

interface TitleProps {
  title: string;
  messageCount: number;
}

export function Title({ title, messageCount }: TitleProps): React.ReactElement {
  return (
    <div className="flex flex-col">
      <h1 className="text-lg font-semibold text-stone-900">{title}</h1>
      <span className="text-xs text-stone-500">{messageCount} messages</span>
    </div>
  );
}
