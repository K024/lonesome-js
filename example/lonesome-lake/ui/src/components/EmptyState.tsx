import type { ComponentChildren } from 'preact'

interface EmptyStateProps {
  title: string
  description?: string
  icon?: ComponentChildren
  className?: string
}

export function EmptyState(
  { title, description, icon, className }: EmptyStateProps,
) {
  return (
    <div
      class={`flex flex-col items-center justify-center gap-2 rounded-box border border-dashed border-base-300 px-6 py-10 text-center ${
        className ?? ''
      }`}
    >
      {icon && <div class='opacity-40'>{icon}</div>}
      <p class='text-sm font-medium'>{title}</p>
      {description && <p class='max-w-sm text-sm opacity-60'>{description}</p>}
    </div>
  )
}
