import {
  forwardRef,
  useEffect,
  useRef,
  type InputHTMLAttributes,
  type ReactNode,
  type SelectHTMLAttributes,
  type TextareaHTMLAttributes,
} from 'react';
import { useFieldIds } from './Field';
import './form.css';

/** Control density: `'md'` is the Studio's 32px default, `'sm'` a 28px variant. */
export type ControlSize = 'sm' | 'md';

interface ControlA11yProps {
  id?: string;
  invalid?: boolean;
  'aria-describedby'?: string;
  'aria-invalid'?: InputHTMLAttributes<HTMLElement>['aria-invalid'];
  'aria-required'?: InputHTMLAttributes<HTMLElement>['aria-required'];
}

/**
 * Merges an enclosing {@link Field}'s ids and state into a control's a11y
 * props. Explicit props always win; outside a Field only `invalid` applies.
 */
function useControlA11y(props: ControlA11yProps): ControlA11yProps {
  const field = useFieldIds();
  const described = [field?.hintId, field?.errorId].filter((v): v is string => v != null).join(' ');
  return {
    id: props.id ?? field?.id,
    'aria-describedby': props['aria-describedby'] ?? (described || undefined),
    'aria-invalid': props['aria-invalid'] ?? (props.invalid || field?.invalid ? true : undefined),
    'aria-required': props['aria-required'] ?? (field?.required ? true : undefined),
  };
}

/** Props for {@link Input}. */
// fallow-ignore-next-line unused-type -- prop contract; adopted by the form screens in the next tickets.
export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {
  /** Danger border + ring; also set automatically by an enclosing Field error. */
  invalid?: boolean;
  /** `'sm'` renders the 28px variant; default is the Studio's 32px control. */
  controlSize?: ControlSize;
}

/**
 * The `.input` text control. Inside a {@link Field} it picks up the label id,
 * `aria-describedby`, `aria-invalid` and `aria-required` automatically.
 */
export const Input = forwardRef<HTMLInputElement, InputProps>(function Input(props, ref) {
  const {
    invalid,
    controlSize,
    className,
    id,
    'aria-describedby': describedBy,
    'aria-invalid': ariaInvalid,
    'aria-required': ariaRequired,
    ...rest
  } = props;
  const a11y = useControlA11y({
    id,
    invalid,
    'aria-describedby': describedBy,
    'aria-invalid': ariaInvalid,
    'aria-required': ariaRequired,
  });
  const classes = ['input', controlSize === 'sm' ? 'input-sm' : undefined, className].filter(Boolean).join(' ');
  return <input ref={ref} className={classes} {...a11y} {...rest} />;
});

/** Props for {@link Textarea}. */
// fallow-ignore-next-line unused-type -- prop contract; adopted by the form screens in the next tickets.
export interface TextareaProps extends TextareaHTMLAttributes<HTMLTextAreaElement> {
  /** Danger border + ring; also set automatically by an enclosing Field error. */
  invalid?: boolean;
  /** UI font at 13px for prose (instructions); default keeps the mono 12px shell. */
  prose?: boolean;
  /** `field-sizing: content` auto-grow, clamped between 64px and 320px. */
  autoGrow?: boolean;
}

/** The `.textarea` control; same Field wiring as {@link Input}. */
export const Textarea = forwardRef<HTMLTextAreaElement, TextareaProps>(function Textarea(props, ref) {
  const {
    invalid,
    prose,
    autoGrow,
    className,
    id,
    'aria-describedby': describedBy,
    'aria-invalid': ariaInvalid,
    'aria-required': ariaRequired,
    ...rest
  } = props;
  const a11y = useControlA11y({
    id,
    invalid,
    'aria-describedby': describedBy,
    'aria-invalid': ariaInvalid,
    'aria-required': ariaRequired,
  });
  const classes = [
    'textarea',
    prose ? 'textarea-prose' : undefined,
    autoGrow ? 'textarea-autogrow' : undefined,
    className,
  ]
    .filter(Boolean)
    .join(' ');
  return <textarea ref={ref} className={classes} {...a11y} {...rest} />;
});

/** One option row for {@link Select}. */
export interface SelectOption {
  value: string;
  label: string;
  disabled?: boolean;
}

/** Props for {@link Select}. */
// fallow-ignore-next-line unused-type -- prop contract; adopted by the form screens in the next tickets.
export interface SelectProps extends Omit<SelectHTMLAttributes<HTMLSelectElement>, 'children'> {
  /** Options rendered in order after the optional placeholder. */
  options: SelectOption[];
  /** First option: `<option value="" disabled>`, selected while `value === ''`. */
  placeholder?: string;
  /** Danger border + ring; also set automatically by an enclosing Field error. */
  invalid?: boolean;
  /** `'sm'` renders the 28px variant; default is the Studio's 32px control. */
  controlSize?: ControlSize;
}

/** The `.select` control; options come from data, never children. */
export const Select = forwardRef<HTMLSelectElement, SelectProps>(function Select(props, ref) {
  const {
    options,
    placeholder,
    invalid,
    controlSize,
    className,
    id,
    'aria-describedby': describedBy,
    'aria-invalid': ariaInvalid,
    'aria-required': ariaRequired,
    ...rest
  } = props;
  const a11y = useControlA11y({
    id,
    invalid,
    'aria-describedby': describedBy,
    'aria-invalid': ariaInvalid,
    'aria-required': ariaRequired,
  });
  const classes = ['select', controlSize === 'sm' ? 'select-sm' : undefined, className].filter(Boolean).join(' ');
  return (
    <select ref={ref} className={classes} {...a11y} {...rest}>
      {placeholder != null ? (
        <option value="" disabled>
          {placeholder}
        </option>
      ) : null}
      {options.map((option) => (
        <option key={option.value} value={option.value} disabled={option.disabled}>
          {option.label}
        </option>
      ))}
    </select>
  );
});

/** Props for {@link Switch}. */
export interface SwitchProps {
  checked: boolean;
  onChange(checked: boolean): void;
  /** `aria-label`; required unless the Switch sits inside a {@link Field} (then the Field label names it). */
  label?: string;
  disabled?: boolean;
  /** Tooltip, e.g. why the switch is disabled. */
  title?: string;
  /** `'sm'` renders the 26x14 track; default is 32x18. */
  size?: ControlSize;
  /** Draws an aria-hidden 'On'/'Off' overline before the switch. */
  stateLabel?: boolean;
  id?: string;
}

/**
 * A `button[role=switch]`, so Enter/Space toggle it for free and its state is
 * announced. Inside a {@link Field} it borrows the Field's id and a11y state.
 */
export function Switch({
  checked,
  onChange,
  label,
  disabled,
  title,
  size,
  stateLabel,
  id,
}: SwitchProps): JSX.Element {
  const a11y = useControlA11y({ id });
  const classes = ['switch', checked ? 'on' : undefined, size === 'sm' ? 'switch-sm' : undefined]
    .filter(Boolean)
    .join(' ');
  return (
    <span className="switch-wrap">
      {stateLabel ? (
        <span className="switch-state overline" aria-hidden="true">
          {checked ? 'On' : 'Off'}
        </span>
      ) : null}
      <button
        type="button"
        role="switch"
        className={classes}
        aria-checked={checked}
        aria-label={label}
        disabled={disabled}
        title={title}
        onClick={() => {
          if (!disabled) onChange(!checked);
        }}
        {...a11y}
      />
    </span>
  );
}

/** Props for {@link Checkbox}. */
// fallow-ignore-next-line unused-type -- prop contract; adopted by the form screens in the next tickets.
export interface CheckboxProps extends Omit<InputHTMLAttributes<HTMLInputElement>, 'type'> {
  /** Primary line next to the box. */
  label: ReactNode;
  /** Muted secondary line under the label. */
  description?: ReactNode;
  /** Sets `el.indeterminate` in an effect (the dash state). */
  indeterminate?: boolean;
}

/** A styled checkbox: the whole row is a `<label>`, so the text toggles it. */
export const Checkbox = forwardRef<HTMLInputElement, CheckboxProps>(function Checkbox(props, ref) {
  const { label, description, indeterminate, className, disabled, ...rest } = props;
  const innerRef = useRef<HTMLInputElement | null>(null);
  useEffect(() => {
    if (innerRef.current) innerRef.current.indeterminate = Boolean(indeterminate);
  }, [indeterminate]);
  const setRefs = (el: HTMLInputElement | null) => {
    innerRef.current = el;
    if (typeof ref === 'function') ref(el);
    else if (ref) ref.current = el;
  };
  const rowClasses = ['checkbox-row', disabled ? 'checkbox-row-disabled' : undefined].filter(Boolean).join(' ');
  return (
    <label className={rowClasses}>
      <input
        ref={setRefs}
        type="checkbox"
        className={['checkbox', className].filter(Boolean).join(' ')}
        disabled={disabled}
        {...rest}
      />
      <span className="checkbox-text">
        <span className="checkbox-label">{label}</span>
        {description != null ? <span className="checkbox-description">{description}</span> : null}
      </span>
    </label>
  );
});
