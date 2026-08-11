import { useEffect, useRef } from 'preact/hooks'
import type { ComponentChildren } from 'preact'

interface ModalProps {
  open: boolean
  onClose: () => void
  className?: string
  children: ComponentChildren
}

export function Modal({ open, onClose, className, children }: ModalProps) {
  const ref = useRef<HTMLDialogElement>(null)

  useEffect(() => {
    const dialog = ref.current
    if (!dialog) return
    if (open && !dialog.open) {
      dialog.showModal()
    } else if (!open && dialog.open) {
      dialog.close()
    }
  }, [open])

  return (
    <dialog
      ref={ref}
      class='modal overflow-y-auto py-8'
      onClose={() => {
        if (open) onClose()
      }}
    >
      <form method='dialog' class='modal-backdrop fixed inset-0'>
        <button aria-label='Close dialog'>close</button>
      </form>
      <div class={`modal-box max-h-none overflow-y-visible ${className ?? ''}`}>
        {children}
      </div>
    </dialog>
  )
}
