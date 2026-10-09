import { useEffect, useRef, type ReactNode } from 'react';

interface ModalProps {
  open: boolean;
  onClose: () => void;
  title: string;
  /** Shown under the title, in the interface voice. */
  description?: string;
  width?: 'sm' | 'md' | 'lg';
  children: ReactNode;
  footer?: ReactNode;
}

const WIDTHS = { sm: 'max-w-sm', md: 'max-w-xl', lg: 'max-w-3xl' } as const;

/**
 * A dialog over the counter screen.
 *
 * Escape always closes, focus moves inside on open and returns to whatever had
 * it on close — so pressing F2, picking a customer and carrying on typing never
 * requires reaching for the mouse.
 */
export function Modal({
  open,
  onClose,
  title,
  description,
  width = 'md',
  children,
  footer,
}: ModalProps): React.JSX.Element | null {
  const panelRef = useRef<HTMLDivElement>(null);
  const returnFocusTo = useRef<Element | null>(null);

  useEffect(() => {
    if (!open) return undefined;

    returnFocusTo.current = document.activeElement;

    function handleKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== 'Tab' || !panelRef.current) return;

      const focusable = panelRef.current.querySelectorAll<HTMLElement>(
        'button:not([disabled]), input:not([disabled]), select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      if (focusable.length === 0) return;

      const first = focusable[0]!;
      const last = focusable[focusable.length - 1]!;
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    }

    // Capture phase, so this wins over the billing screen's own shortcuts.
    document.addEventListener('keydown', handleKey, true);

    const target = panelRef.current?.querySelector<HTMLElement>('[data-autofocus]');
    (target ?? panelRef.current)?.focus();

    return () => {
      document.removeEventListener('keydown', handleKey, true);
      if (returnFocusTo.current instanceof HTMLElement) returnFocusTo.current.focus();
    };
  }, [open, onClose]);

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-6">
      <div
        className="absolute inset-0 bg-ink/35"
        onClick={onClose}
        aria-hidden="true"
      />
      <div
        ref={panelRef}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        tabIndex={-1}
        className={`relative flex max-h-[85vh] w-full ${WIDTHS[width]} flex-col rounded-lg bg-surface shadow-xl outline-none`}
      >
        <header className="border-b border-rule px-6 py-4">
          <h2 className="text-section font-semibold text-ink">{title}</h2>
          {description && <p className="mt-1 text-meta text-ink-soft">{description}</p>}
        </header>

        <div className="min-h-0 flex-1 overflow-y-auto px-6 py-5">{children}</div>

        {footer && (
          <footer className="flex items-center justify-end gap-3 border-t border-rule px-6 py-4">
            {footer}
          </footer>
        )}
      </div>
    </div>
  );
}
