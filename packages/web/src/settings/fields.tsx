import { useId } from "react";
import type { ReactNode } from "react";
import { modelChoices } from "../chat/models.js";

function Hint({ id, children }: { id: string; children: ReactNode }) {
  return (
    <span id={id} className="field-hint muted">
      {children}
    </span>
  );
}

export function ModelField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
}) {
  const id = useId();
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      <select
        id={id}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {modelChoices(value).map((choice) => (
          <option key={choice.value} value={choice.value}>
            {choice.label}
          </option>
        ))}
      </select>
    </div>
  );
}

export function TextField({
  label,
  hint,
  value,
  multiline = false,
  onChange,
}: {
  label: string;
  hint?: string;
  value: string;
  multiline?: boolean;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const control = {
    id,
    value,
    className: "mono",
    spellCheck: false,
    "aria-describedby": hint === undefined ? undefined : hintId,
    onChange: (event: { target: { value: string } }) => {
      onChange(event.target.value);
    },
  };
  return (
    <div className="form-field">
      <label htmlFor={id}>{label}</label>
      {multiline ? <textarea rows={3} {...control} /> : <input type="text" {...control} />}
      {hint !== undefined && <Hint id={hintId}>{hint}</Hint>}
    </div>
  );
}

export function CheckField({
  label,
  hint,
  checked,
  onChange,
}: {
  label: string;
  hint?: ReactNode;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  return (
    <div className="check-field">
      <input
        type="checkbox"
        id={id}
        checked={checked}
        aria-describedby={hint === undefined ? undefined : hintId}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
      />
      <label htmlFor={id}>{label}</label>
      {hint !== undefined && <Hint id={hintId}>{hint}</Hint>}
    </div>
  );
}

export interface Choice<Value extends string> {
  value: Value;
  label: string;
  hint: string;
}

export function ChoiceField<Value extends string>({
  legend,
  name,
  choices,
  value,
  onChange,
}: {
  legend: string;
  name: string;
  choices: readonly Choice<Value>[];
  value: Value;
  onChange: (value: Value) => void;
}) {
  const id = useId();
  return (
    <fieldset className="choice-field">
      <legend>{legend}</legend>
      {choices.map((choice) => (
        <div key={choice.value} className="check-field">
          <input
            type="radio"
            id={`${id}-${choice.value}`}
            name={name}
            value={choice.value}
            checked={choice.value === value}
            aria-describedby={`${id}-${choice.value}-hint`}
            onChange={() => {
              onChange(choice.value);
            }}
          />
          <label htmlFor={`${id}-${choice.value}`}>{choice.label}</label>
          <Hint id={`${id}-${choice.value}-hint`}>{choice.hint}</Hint>
        </div>
      ))}
    </fieldset>
  );
}
