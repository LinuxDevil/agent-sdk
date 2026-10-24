interface VariableInputsProps {
  names: string[];
  values: Record<string, string>;
  onChange: (values: Record<string, string>) => void;
}

/** One input per `{variable}` found in the messages; nothing when there are none. */
export function VariableInputs({ names, values, onChange }: VariableInputsProps) {
  if (names.length === 0) return null;
  return (
    <section className="pg-panel pg-variables" aria-labelledby="pg-variables-title">
      <h3 id="pg-variables-title" className="pg-panel-title">
        Variables
      </h3>
      {names.map((name) => (
        <label key={name} className="pg-field">
          <span className="pg-field-label">{`{${name}}`}</span>
          <input
            type="text"
            value={values[name] ?? ''}
            onChange={(e) => onChange({ ...values, [name]: e.target.value })}
          />
        </label>
      ))}
    </section>
  );
}
