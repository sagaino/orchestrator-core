import { validateDecisionRecord } from "./orchestration-schema.mjs";
import { createDurableRecordStore } from "./orchestration-store.mjs";

export const decisionStore = createDurableRecordStore({ collection: "decisions", idField: "decisionId", validate: validateDecisionRecord });
export const createDecision = decisionStore.create;
export const getDecision = decisionStore.get;
export const listDecisions = decisionStore.list;
export function updateDecision(options = {}) {
  return decisionStore.update({ ...options, id: options.id ?? options.decisionId });
}
export const decisionPath = decisionStore.pathFor;
