import { validateObjectiveRecord } from "./orchestration-schema.mjs";
import { createDurableRecordStore } from "./orchestration-store.mjs";

export const objectiveStore = createDurableRecordStore({ collection: "objectives", idField: "objectiveId", validate: validateObjectiveRecord });
export const createObjective = objectiveStore.create;
export const getObjective = objectiveStore.get;
export const listObjectives = objectiveStore.list;
export function updateObjective(options = {}) {
  return objectiveStore.update({ ...options, id: options.id ?? options.objectiveId });
}
export const objectivePath = objectiveStore.pathFor;
