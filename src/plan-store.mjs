import { validatePlanRecord } from "./orchestration-schema.mjs";
import { createDurableRecordStore } from "./orchestration-store.mjs";

export const planStore = createDurableRecordStore({ collection: "plans", idField: "planId", validate: validatePlanRecord });
export const createPlan = planStore.create;
export const getPlan = planStore.get;
export const listPlans = planStore.list;
export function updatePlan(options = {}) {
  return planStore.update({ ...options, id: options.id ?? options.planId });
}
export const planPath = planStore.pathFor;
