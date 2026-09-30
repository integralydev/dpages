'use client';

export function DateRangeInput({
  label,
  from,
  to,
  onFromChange,
  onToChange,
}: {
  label: string;
  from?: string;
  to?: string;
  onFromChange?: (value: string) => void;
  onToChange?: (value: string) => void;
}) {
  return (
    <div className="flex w-full flex-col gap-1.5 text-sm sm:min-w-[160px] sm:w-auto sm:flex-1">
      <span className="font-medium text-gray-900">{label}</span>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-500">Des</span>
        <input
          type="date"
          value={from}
          onChange={(event) => onFromChange?.(event.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-brand focus:outline-none"
        />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs font-medium text-gray-500">Fins</span>
        <input
          type="date"
          value={to}
          onChange={(event) => onToChange?.(event.target.value)}
          className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-brand focus:outline-none"
        />
      </div>
    </div>
  );
}
