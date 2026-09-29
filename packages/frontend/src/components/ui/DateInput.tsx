'use client';

export function DateInput({
  label,
  value,
  onChange,
}: {
  label: string;
  value?: string;
  onChange?: (value: string) => void;
}) {
  return (
    <label className="flex w-full flex-col gap-1.5 text-sm sm:min-w-[150px] sm:w-auto sm:flex-1">
      <span className="font-medium text-gray-900">{label}</span>
      <input
        type="date"
        value={value}
        onChange={(event) => onChange?.(event.target.value)}
        className="w-full rounded-md border border-gray-300 px-3 py-2 text-sm text-gray-900 focus:border-brand focus:outline-none"
      />
    </label>
  );
}
