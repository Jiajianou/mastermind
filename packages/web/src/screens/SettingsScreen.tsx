import { planLabel, resolveMaxWorkers } from "@mastermind/core/contracts";
import type { Config, SubscriptionPlan, WorkerPermissions } from "@mastermind/core/contracts";
import { useId, useState } from "react";
import type { SyntheticEvent } from "react";
import { useRequest } from "../components/use-request.js";
import { ChoiceField, CheckField, ModelField, TextField } from "../settings/fields.js";
import type { Choice } from "../settings/fields.js";
import { settingsChange, settingsValues } from "../settings/form.js";
import type { SettingsValues } from "../settings/form.js";
import { NotificationsField } from "../settings/NotificationsField.js";
import { useApi, useDispatch, useLive } from "../store/hooks.js";
import { Screen } from "./Screen.js";

const permissionChoices: readonly Choice<WorkerPermissions>[] = [
  {
    value: "bypass",
    label: "Bypass",
    hint: "Workers skip permission prompts inside their own workspace.",
  },
  {
    value: "auto",
    label: "Auto",
    hint: "Claude Code's auto mode decides what workers may do. It is not available with Haiku.",
  },
  {
    value: "allowlist",
    label: "Allowlist",
    hint: "Workers may edit files and use only the tools you list.",
  },
];

const workerCounts = [1, 2, 3, 4, 5, 6, 7, 8];

function workerChoices(current: string, plan: SubscriptionPlan | null) {
  const auto =
    plan === null
      ? "Auto"
      : `Auto (${String(resolveMaxWorkers("auto", plan))} on ${planLabel(plan)})`;
  const counts = workerCounts.map(String);
  const numbers = current === "auto" || counts.includes(current) ? counts : [...counts, current];
  return [{ value: "auto", label: auto }, ...numbers.map((value) => ({ value, label: value }))];
}

interface Edit {
  initial: SettingsValues;
  values: SettingsValues;
}

function SettingsForm({ config, plan }: { config: Config; plan: SubscriptionPlan | null }) {
  const api = useApi();
  const dispatch = useDispatch();
  const live = useLive((state) => state.connection === "live");
  const { busy, failure, run } = useRequest();
  const [edit, setEdit] = useState<Edit | null>(null);
  const [saved, setSaved] = useState(false);
  const workersId = useId();
  const values = edit?.values ?? settingsValues(config);
  const result = edit === null ? null : settingsChange(edit.initial, edit.values);
  const changed = result !== null && (!result.ok || !result.empty);

  const set = <Field extends keyof SettingsValues>(field: Field, value: SettingsValues[Field]) => {
    setSaved(false);
    setEdit((current) => {
      const initial = current?.initial ?? settingsValues(config);
      return { initial, values: { ...(current?.values ?? initial), [field]: value } };
    });
  };

  const save = (event: SyntheticEvent) => {
    event.preventDefault();
    if (!result?.ok) return;
    const { change } = result;
    void run(async () => {
      dispatch({ type: "config.updated", config: await api.act("setConfig", change) });
      setEdit(null);
      setSaved(true);
    });
  };

  return (
    <form className="settings-form" aria-label="Settings" onSubmit={save} noValidate>
      <fieldset className="settings-group panel">
        <legend>Models</legend>
        <ModelField
          label="Chat model"
          value={values.conductorModel}
          onChange={(value) => {
            set("conductorModel", value);
          }}
        />
        <ModelField
          label="Worker model"
          value={values.workerModel}
          onChange={(value) => {
            set("workerModel", value);
          }}
        />
        <ModelField
          label="Fixer model"
          value={values.fixerModel}
          onChange={(value) => {
            set("fixerModel", value);
          }}
        />
        <ModelField
          label="Reviewer model"
          value={values.reviewerModel}
          onChange={(value) => {
            set("reviewerModel", value);
          }}
        />
        <ModelField
          label="Model for small judgements"
          value={values.judgeModel}
          onChange={(value) => {
            set("judgeModel", value);
          }}
        />
        <CheckField
          label="Review every task with the reviewer"
          hint="Serious findings go to a fixer before the task can be rebased onto main."
          checked={values.reviewerEnabled}
          onChange={(checked) => {
            set("reviewerEnabled", checked);
          }}
        />
      </fieldset>

      <fieldset className="settings-group panel">
        <legend>Workers</legend>
        <div className="form-field">
          <label htmlFor={workersId}>Parallel workers</label>
          <select
            id={workersId}
            value={values.maxWorkers}
            onChange={(event) => {
              set("maxWorkers", event.target.value);
            }}
          >
            {workerChoices(values.maxWorkers, plan).map((choice) => (
              <option key={choice.value} value={choice.value}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
        <ChoiceField
          legend="Permissions"
          name="workerPermissions"
          choices={permissionChoices}
          value={values.workerPermissions}
          onChange={(value) => {
            set("workerPermissions", value);
          }}
        />
        {values.workerPermissions === "allowlist" && (
          <TextField
            label="Allowed tools"
            hint="One per line, such as Bash(make *)."
            multiline
            value={values.workerAllowedTools}
            onChange={(value) => {
              set("workerAllowedTools", value);
            }}
          />
        )}
      </fieldset>

      <fieldset className="settings-group panel">
        <legend>Sandbox</legend>
        <CheckField
          label="Run workers in Claude Code's sandbox"
          hint="Writes stay inside the task's workspace and network access is limited to the domains below."
          checked={values.sandboxEnabled}
          onChange={(checked) => {
            set("sandboxEnabled", checked);
          }}
        />
        <TextField
          label="Allowed domains"
          hint="One per line, such as registry.npmjs.org."
          multiline
          value={values.allowedDomains}
          onChange={(value) => {
            set("allowedDomains", value);
          }}
        />
      </fieldset>

      <fieldset className="settings-group panel">
        <legend>Commands</legend>
        <TextField
          label="Setup command"
          hint="Runs once in each new task workspace. Leave empty for none."
          value={values.setupCommand}
          onChange={(value) => {
            set("setupCommand", value);
          }}
        />
        <TextField
          label="Build command"
          value={values.buildCommand}
          onChange={(value) => {
            set("buildCommand", value);
          }}
        />
        <TextField
          label="Test command"
          value={values.testCommand}
          onChange={(value) => {
            set("testCommand", value);
          }}
        />
      </fieldset>

      <fieldset className="settings-group panel">
        <legend>Protected paths</legend>
        <TextField
          label="Paths that always wait for your review"
          hint="One path prefix per line, such as kernel/vfs/. A task that changes them waits in review instead of being rebased onto main automatically."
          multiline
          value={values.requireReviewFor}
          onChange={(value) => {
            set("requireReviewFor", value);
          }}
        />
      </fieldset>

      <fieldset className="settings-group panel">
        <legend>Notifications</legend>
        <NotificationsField
          checked={values.desktopNotifications}
          onChange={(checked) => {
            set("desktopNotifications", checked);
          }}
        />
      </fieldset>

      {result?.ok === false && (
        <p role="alert" className="control-failure">
          {result.message}
        </p>
      )}
      {failure !== null && (
        <p role="alert" className="control-failure">
          Couldn&apos;t save the settings: {failure}
        </p>
      )}
      <div className="form-actions settings-actions">
        <button type="submit" className="primary" disabled={!live || busy || !changed}>
          {busy ? "Saving…" : "Save"}
        </button>
        {edit !== null && (
          <button
            type="button"
            disabled={busy}
            onClick={() => {
              setEdit(null);
            }}
          >
            Discard changes
          </button>
        )}
        <p role="status" className="muted">
          {saved ? "Saved to .mastermind/config.yaml" : ""}
        </p>
      </div>
    </form>
  );
}

export function SettingsScreen() {
  const config = useLive((state) => state.config);
  const plan = useLive((state) => state.instance?.account.plan ?? null);
  return (
    <Screen title="Settings">
      {config === null ? (
        <p className="muted">Loading settings…</p>
      ) : (
        <SettingsForm config={config} plan={plan} />
      )}
    </Screen>
  );
}
