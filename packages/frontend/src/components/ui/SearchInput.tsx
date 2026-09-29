'use client';

import { Search } from 'lucide-react';

export function SearchInput({
  label,
  placeholder,
  value,
  onChange,
}: {
  label: string;
  placeholder?: string;
  value?: string;
  onChange?: (value: string) => void;
}) {
  return (
    <label className="flex w-full flex-col gap-1.5 text-sm sm:min-w-[130px] sm:w-auto sm:flex-1">
      <span className="font-medium text-gray-900">{label}</span>
      <span className="relative">
        <Search className="pointer-events-none absolute top-1/2 left-3 h-4 w-4 -translate-y-1/2 text-gray-400" />
        <input
          type="text"
          placeholder={placeholder}
          value={value}
          onChange={(event) => onChange?.(event.target.value)}
          className="w-full rounded-md border border-gray-300 py-2 pr-3 pl-9 text-sm text-gray-900 placeholder:text-gray-400 focus:border-brand focus:outline-none"
        />
      </span>
    </label>
  );
}
