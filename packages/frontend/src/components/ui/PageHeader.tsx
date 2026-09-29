'use client';

import type { ReactNode } from 'react';

type PageHeaderAction = {
  label: string;
  onClick?: () => void;
  icon?: ReactNode;
};

export function PageHeader({
  title,
  subtitle,
  action,
  right,
}: {
  title: string;
  subtitle?: string;
  action?: PageHeaderAction;
  right?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-start justify-between gap-4">
      <div>
        <h1 className="font-display text-2xl text-gray-900 italic lg:text-3xl">{title}</h1>
        {subtitle && <p className="mt-1 text-sm text-gray-500">{subtitle}</p>}
      </div>
      {right}
      {!right && action && (
        <button
          type="button"
          onClick={action.onClick}
          className="flex items-center gap-2 rounded-full bg-ink px-5 py-2.5 text-sm font-semibold text-white hover:opacity-90"
        >
          {action.icon}
          {action.label}
        </button>
      )}
    </div>
  );
}
