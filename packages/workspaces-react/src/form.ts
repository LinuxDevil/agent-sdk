import { useCallback, useMemo, useState } from 'react';
import type { FormState } from './context';
import { getAt, inputSegments, setAt } from './paths';

export type FormCheck = (values: Record<string, unknown>) => Record<string, string>;

export function useFormState(initial: Record<string, unknown>, check: FormCheck): FormState {
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<Record<string, string>>({});
  const set = useCallback((bind: string, value: unknown) => setValues((current) => setAt(current, inputSegments(bind), value === '' ? undefined : value)), []);
  const validate = useCallback(() => {
    const next = check(values);
    setErrors(next);
    return Object.keys(next);
  }, [check, values]);
  return useMemo(() => ({ values, errors, get: (bind: string) => getAt({ inputs: values }, bind), set, validate }), [values, errors, set, validate]);
}
