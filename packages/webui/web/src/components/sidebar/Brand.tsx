interface BrandProps {
  version: string;
}

export function Brand({ version }: BrandProps) {
  return (
    <div className="flex items-center gap-2 px-3 py-3 border-b border-stone-200">
      <span className="text-base font-semibold text-stone-900">pi</span>
      <span className="text-xs text-stone-400">v{version}</span>
    </div>
  );
}
