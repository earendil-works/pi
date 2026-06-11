import React from "react";
import { formatToken } from "../../lib/format";

type Usage = { input: number; output: number };

interface MessageFooterProps {
  usage?: Usage;
}

export function MessageFooter({ usage }: MessageFooterProps): null | React.JSX.Element {
  if (!usage) {
    return null;
  }

  return (
    <div className="mt-1 text-right text-[10px] text-stone-400">
      {formatToken(usage.input)} in · {formatToken(usage.output)} out
    </div>
  );
}
