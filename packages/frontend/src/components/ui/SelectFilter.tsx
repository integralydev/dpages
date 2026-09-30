'use client';

import { ChevronDown } from 'lucide-react';

export function SelectFilter({
  label,
  options,
  value,
  onChange,
}: {
  label: string;
  options: string[];
  value?: string;
  onChange?: (value: string) => void;
}) {
  return (
    <label className="flex w-full flex-col gap-1.5 text-sm sm:min-w-[110px] sm:w-auto sm:flex-1">
      <span className="font-medium text-gray-900">{label}</span>
      <span className="relative">
        <select
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
          className="w-full appearance-none rounded-md border border-gray-300 bg-white py-2 pr-9 pl-3 text-sm text-gray-900 focus:border-brand focus:outline-none"
        >
          {options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        <ChevronDown className="pointer-events-none absolute top-1/2 right-3 h-4 w-4 -translate-y-1/2 text-gray-400" />
      </span>
    </label>
  );
}
