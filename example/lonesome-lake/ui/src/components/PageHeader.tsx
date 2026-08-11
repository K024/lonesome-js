import type { ComponentChildren } from 'preact'

interface PageHeaderProps {
  title: string
  description?: string
  children?: ComponentChildren
}

export function PageHeader({ title, description, children }: PageHeaderProps) {
  return (
    <div class='flex flex-col gap-3 sm:flex-row sm:items-end sm:justify-between'>
      <div class='min-w-0'>
        <h2 class='text-xl font-semibold tracking-tight'>{title}</h2>
        {description && (
          <p class='mt-1 max-w-2xl text-sm opacity-60'>{description}</p>
        )}
      </div>
      {children && (
        <div class='flex shrink-0 flex-wrap items-center gap-2'>{children}</div>
      )}
    </div>
  )
}
