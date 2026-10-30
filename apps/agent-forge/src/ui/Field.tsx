import { createContext, useContext, useId, type ReactNode } from 'react';
import './form.css';

/** Ids a control inside a {@link Field} picks up automatically. */
export interface FieldIds {
  /** The control id the Field's label points at. */
  id: string;
  /** Id of the hint `<p>`, present only when the Field has a hint. */
  hintId?: string;
  /** Id of the error `<p>`, present only when the Field has an error. */
  errorId?: string;
  /** True while the Field carries an error; controls become `aria-invalid`. */
  invalid: boolean;
  /** True when the Field is required; controls become `aria-required`. */
  required: boolean;
}

const FieldContext = createContext<FieldIds | undefined>(undefined);

/** Props for {@link Field}. */
export interface FieldProps {
  /** Visible label, linked to the control through `htmlFor`. */
  label: ReactNode;
  /** Muted help text under the control; its id joins `aria-describedby`. */
  hint?: ReactNode;
  /** Danger text under the hint; marks the control `aria-invalid`. */
  error?: string;
  /** Draws a faint `*` after the label and sets `aria-required` on the control. */
  required?: boolean;
  /** Control id; defaults to a `useId` value. */
  id?: string;
  /** Label left, control right (switch rows); hint/error wrap full-width below. */
  inline?: boolean;
  className?: string;
  children: ReactNode;
}

/**
 * A labelled, described control row. Controls rendered inside read their id,
 * `aria-describedby`, `aria-invalid` and `aria-required` from the enclosing
 * Field via {@link useFieldIds}, so screens stop hand-wiring ids.
 */
export function Field({
  label,
  hint,
  error,
  required = false,
  id,
  inline,
  className,
  children,
}: FieldProps): JSX.Element {
  const autoId = useId();
  const controlId = id ?? autoId;
  const ids: FieldIds = {
    id: controlId,
    hintId: hint != null ? `${controlId}-hint` : undefined,
    errorId: error != null ? `${controlId}-error` : undefined,
    invalid: error != null,
    required,
  };
  const classes = [
    'field',
    inline ? 'field-inline' : undefined,
    error != null ? 'field-invalid' : undefined,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return (
    <FieldContext.Provider value={ids}>
      <div className={classes}>
        <label className="field-label" htmlFor={controlId}>
          {label}
          {required ? (
            <span className="field-required" aria-hidden="true">
              {'*'}
            </span>
          ) : null}
        </label>
        {children}
        {hint != null ? (
          <p className="hint" id={ids.hintId}>
            {hint}
          </p>
        ) : null}
        {error != null ? (
          <p className="hint field-error" id={ids.errorId}>
            {error}
          </p>
        ) : null}
      </div>
    </FieldContext.Provider>
  );
}

/** The enclosing {@link Field}'s ids, or `undefined` outside a Field. */
export function useFieldIds(): FieldIds | undefined {
  return useContext(FieldContext);
}
