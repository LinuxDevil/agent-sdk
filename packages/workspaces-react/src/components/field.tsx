import { useId, type ReactElement, type ReactNode } from 'react';
import type { RenderContext } from '../context';

export function fieldLabel(label: string | undefined, bind: string): string {
  return label ?? bind.split('.').at(-1) ?? bind;
}

export interface Control {
  id: string;
  error?: string;
  value: unknown;
  aria: { id: string; 'aria-invalid'?: true; 'aria-describedby'?: string };
}

export function useControl(ctx: RenderContext, bind: string): Control {
  const id = useId();
  const error = ctx.form.errors[bind];
  const aria = error === undefined ? { id } : { id, 'aria-invalid': true as const, 'aria-describedby': `${id}-error` };
  return { id, error, value: ctx.form.get(bind), aria };
}

export function FieldError({ id, error }: { id: string; error?: string }): ReactElement | null {
  return error === undefined ? null : <p className="lwr-error" id={`${id}-error`} role="alert">{error}</p>;
}

export function Field({ id, label, error, children }: { id: string; label: string; error?: string; children: ReactNode }): ReactElement {
  return (
    <div className="lwr-field">
      <label className="lwr-label" htmlFor={id}>{label}</label>
      {children}
      <FieldError id={id} error={error} />
    </div>
  );
}
