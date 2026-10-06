import { useId } from "react";
import { useApi, useDispatch, useLive } from "../store/hooks.js";
import { modelChoices } from "./models.js";
import { useRequest } from "../components/use-request.js";

export function ModelMenu({ disabled }: { disabled: boolean }) {
  const api = useApi();
  const dispatch = useDispatch();
  const model = useLive((state) => state.chat.model);
  const { busy, failure, run } = useRequest();
  const id = useId();

  const choose = (conductor: string) =>
    run(async () => {
      dispatch({
        type: "config.updated",
        config: await api.act("setConfig", { models: { conductor } }),
      });
    });

  return (
    <div className="model-menu">
      <label htmlFor={id} className="visually-hidden">
        Model
      </label>
      <select
        id={id}
        value={model ?? ""}
        disabled={disabled || busy || model === null}
        onChange={(event) => void choose(event.target.value)}
      >
        {modelChoices(model).map(({ value, label }) => (
          <option key={value} value={value}>
            {label}
          </option>
        ))}
      </select>
      {failure !== null && (
        <span role="alert" className="control-failure">
          Couldn&apos;t change the model: {failure}
        </span>
      )}
    </div>
  );
}
