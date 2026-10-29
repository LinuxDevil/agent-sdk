import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { CircleAlert, CircleCheck, Info, X, type LucideIcon } from 'lucide-react';
import './primitives.css';
import './toast.css';

/** What {@link useToast}'s `show` takes: a message, a tone (default `info`) and an optional action button. */
export interface ToastOptions {
  message: string;
  tone?: 'info' | 'success' | 'error';
  action?: { label: string; onClick: () => void };
}

/** The toast API from {@link useToast}: `show` returns the toast's id, which `dismiss` takes. */
export interface ToastApi {
  show(t: ToastOptions): string;
  dismiss(id: string): void;
}

interface ToastItem extends ToastOptions {
  id: string;
}

const AUTO_DISMISS_MS = 5000;

const ToastContext = createContext<ToastApi | null>(null);

const TONE_ICON: Record<NonNullable<ToastOptions['tone']>, LucideIcon> = {
  info: Info,
  success: CircleCheck,
  error: CircleAlert,
};

function ToastView({ toast, onDismiss }: { toast: ToastItem; onDismiss: (id: string) => void }) {
  const { id, message, tone = 'info', action } = toast;
  const Icon = TONE_ICON[tone];
  return (
    <div className={`toast toast-${tone}`} role={tone === 'error' ? 'alert' : undefined}>
      <Icon className="toast-icon" size={16} strokeWidth={1.75} aria-hidden="true" />
      <span className="toast-message">{message}</span>
      {action && (
        <button
          type="button"
          className="btn btn-sm btn-ghost toast-action"
          onClick={() => {
            action.onClick();
            onDismiss(id);
          }}
        >
          {action.label}
        </button>
      )}
      <button type="button" className="toast-close" aria-label="Dismiss notification" onClick={() => onDismiss(id)}>
        <X size={16} strokeWidth={1.75} aria-hidden="true" />
      </button>
    </div>
  );
}

/**
 * Hosts the app's toasts: one polite `role="status"` live region for info and
 * success toasts (auto-dismissed after 5 s) and `role="alert"` error toasts
 * that stay until dismissed. Mount once near the app root.
 */
export function ToastProvider({ children }: { children: ReactNode }) {
  const [toasts, setToasts] = useState<ToastItem[]>([]);
  const timers = useRef(new Map<string, ReturnType<typeof setTimeout>>());
  const nextId = useRef(0);

  const dismiss = useCallback((id: string) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) clearTimeout(timer);
    timers.current.delete(id);
    setToasts((list) => list.filter((t) => t.id !== id));
  }, []);

  const show = useCallback(
    (t: ToastOptions) => {
      const id = `toast-${++nextId.current}`;
      setToasts((list) => [...list, { ...t, id }]);
      if (t.tone !== 'error') timers.current.set(id, setTimeout(() => dismiss(id), AUTO_DISMISS_MS));
      return id;
    },
    [dismiss],
  );

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  const api = useMemo(() => ({ show, dismiss }), [show, dismiss]);
  const errors = toasts.filter((t) => t.tone === 'error');
  const polite = toasts.filter((t) => t.tone !== 'error');

  return (
    <ToastContext.Provider value={api}>
      {children}
      <div className="toast-stack">
        {errors.map((t) => (
          <ToastView key={t.id} toast={t} onDismiss={dismiss} />
        ))}
        <div className="toast-region" role="status" aria-live="polite">
          {polite.map((t) => (
            <ToastView key={t.id} toast={t} onDismiss={dismiss} />
          ))}
        </div>
      </div>
    </ToastContext.Provider>
  );
}

/** The toast API of the nearest {@link ToastProvider}; throws when there is none. */
export function useToast(): ToastApi {
  const api = useContext(ToastContext);
  if (!api) throw new Error('useToast must be used inside a <ToastProvider>.');
  return api;
}
