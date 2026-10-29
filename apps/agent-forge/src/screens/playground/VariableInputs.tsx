interface VariableInputsProps {
  names: string[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}

/** One labelled input per `{variable}` found in the messages; a hint when there are none. */
export function VariableInputs({ names, values, onChange }: VariableInputsProps) {
  return (
    <section className="pg-config-section pg-variables" aria-labelledby="pg-variables-title">
      <h2 id="pg-variables-title" className="pg-section-title overline">
        Variables
      </h2>
      {names.length === 0 && (
        <p className="pg-hint">
          Write <code>{'{name}'}</code> in a message to get an input for it here.
        </p>
      )}
      {names.map((name) => (
        <label key={name} className="pg-field">
          <span className="pg-field-label pg-var-label">{`{${name}}`}</span>
          <input
            type="text"
            className="input"
            value={values[name] ?? ''}
            onChange={(e) => onChange({ ...values, [name]: e.target.value })}
          />
        </label>
      ))}
    </section>
  );
}
