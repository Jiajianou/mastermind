import { useId, useState } from "react";
import type { ChangeEvent, SyntheticEvent } from "react";
import { capitalized } from "@mastermind/core/contracts";
import { useRequest } from "../components/use-request.js";
import { useLive } from "../store/hooks.js";
import type { FieldIssues, FormResult, TaskField, TaskFormValues } from "./form.js";

interface FieldSpec {
  name: TaskField;
  label: string;
  hint?: string;
  control: "input" | "textarea" | "number";
  mono?: boolean;
}

const fields: readonly FieldSpec[] = [
  {
    name: "id",
    label: "Id",
    hint: "A short slug, such as ext2-driver.",
    control: "input",
    mono: true,
  },
  { name: "title", label: "Title", control: "input" },
  { name: "goal", label: "Goal", hint: "What to build and why.", control: "textarea" },
  {
    name: "acceptance",
    label: "Acceptance",
    hint: "A shell command that must exit 0.",
    control: "input",
    mono: true,
  },
  {
    name: "deps",
    label: "Depends on",
    hint: "Task ids that must be done first, separated by commas.",
    control: "input",
    mono: true,
  },
  {
    name: "touches",
    label: "Touches",
    hint: "Path prefixes the task may edit, one per line.",
    control: "textarea",
    mono: true,
  },
  { name: "priority", label: "Priority", hint: "Higher starts first.", control: "number" },
];

function FormField({
  spec,
  value,
  issue,
  onChange,
}: {
  spec: FieldSpec;
  value: string;
  issue: string | undefined;
  onChange: (value: string) => void;
}) {
  const id = useId();
  const hintId = `${id}-hint`;
  const issueId = `${id}-issue`;
  const described = [spec.hint === undefined ? null : hintId, issue === undefined ? null : issueId]
    .filter((part) => part !== null)
    .join(" ");
  const control = {
    id,
    name: spec.name,
    value,
    className: spec.mono === true ? "mono" : undefined,
    "aria-invalid": issue !== undefined,
    "aria-describedby": described === "" ? undefined : described,
    onChange: (event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>) => {
      onChange(event.target.value);
    },
  };
  return (
    <div className="form-field">
      <label htmlFor={id}>{spec.label}</label>
      {spec.control === "textarea" ? (
        <textarea rows={spec.name === "goal" ? 5 : 3} {...control} />
      ) : (
        <input type={spec.control === "number" ? "number" : "text"} step={1} {...control} />
      )}
      {spec.hint !== undefined && (
        <span id={hintId} className="field-hint muted">
          {spec.hint}
        </span>
      )}
      {issue !== undefined && (
        <span id={issueId} className="field-issue">
          {capitalized(issue)}
        </span>
      )}
    </div>
  );
}

export interface TaskFormProps<Input> {
  heading: string;
  initial: TaskFormValues;
  withId: boolean;
  submitLabel: string;
  busyLabel: string;
  parse: (values: TaskFormValues) => FormResult<Input>;
  save: (input: Input) => Promise<void>;
  onCancel: () => void;
}

export function TaskForm<Input>({
  heading,
  initial,
  withId,
  submitLabel,
  busyLabel,
  parse,
  save,
  onCancel,
}: TaskFormProps<Input>) {
  const live = useLive((state) => state.connection === "live");
  const [values, setValues] = useState(initial);
  const [issues, setIssues] = useState<FieldIssues>({});
  const { busy, failure, run } = useRequest();

  const submit = (event: SyntheticEvent) => {
    event.preventDefault();
    const result = parse(values);
    if (!result.ok) {
      setIssues(result.issues);
      return;
    }
    setIssues({});
    void run(() => save(result.input));
  };

  return (
    <form className="task-form panel" aria-label={heading} onSubmit={submit} noValidate>
      <h2>{heading}</h2>
      {fields
        .filter((spec) => withId || spec.name !== "id")
        .map((spec) => (
          <FormField
            key={spec.name}
            spec={spec}
            value={values[spec.name]}
            issue={issues[spec.name]}
            onChange={(value) => {
              setValues((current) => ({ ...current, [spec.name]: value }));
            }}
          />
        ))}
      {failure !== null && (
        <p role="alert" className="control-failure">
          Couldn't save: {failure}
        </p>
      )}
      <div className="form-actions">
        <button type="submit" className="primary" disabled={!live || busy}>
          {busy ? busyLabel : submitLabel}
        </button>
        <button type="button" onClick={onCancel} disabled={busy}>
          Cancel
        </button>
      </div>
    </form>
  );
}
