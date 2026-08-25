import { validateObjectiveRecord } from "./orchestration-schema.mjs";
import { createDurableRecordStore } from "./orchestration-store.mjs";

const store = createDurableRecordStore({ collection: "objectives", idField: "objectiveId", validate: validateObjectiveRecord });

export function sortObjectivesDescending(records = []) {
  return [...records].sort((left, right) => (
    String(right?.createdAt ?? right?.objectiveId ?? "").localeCompare(String(left?.createdAt ?? left?.objectiveId ?? ""))
    || String(right?.objectiveId ?? "").localeCompare(String(left?.objectiveId ?? ""))
  ));
}

export const objectiveStore = Object.freeze({
  ...store,
  list: (runsRoot, validationOptions = {}) => sortObjectivesDescending(store.list(runsRoot, validationOptions)),
});

export const createObjective = objectiveStore.create;
export const getObjective = objectiveStore.get;
export const listObjectives = objectiveStore.list;
export function updateObjective(options = {}) {
  return objectiveStore.update({ ...options, id: options.id ?? options.objectiveId });
}
export const objectivePath = objectiveStore.pathFor;
