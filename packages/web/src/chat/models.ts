const knownModels: readonly string[] = ["opus", "sonnet", "haiku"];

export interface ModelChoice {
  value: string;
  label: string;
}

const label = (model: string): string =>
  knownModels.includes(model) ? `${model.charAt(0).toUpperCase()}${model.slice(1)}` : model;

export function modelChoices(current: string | null): ModelChoice[] {
  const models =
    current === null || knownModels.includes(current) ? knownModels : [...knownModels, current];
  return models.map((value) => ({ value, label: label(value) }));
}
