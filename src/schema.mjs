import { RUN_STATES } from "./run-manager.mjs";
import { JOB_STATES } from "./job-queue.mjs";

export function validateManifest(manifest) {
  const errors = [];
  if (!manifest || typeof manifest !== "object") {
    return { valid: false, errors: ["Manifest must be a non-null object"] };
  }
  if (!manifest.schemaVersion) errors.push("Missing schemaVersion");
  if (!manifest.runId || typeof manifest.runId !== "string") errors.push("Missing or invalid runId");
  if (!manifest.state) {
    errors.push("Missing state");
  } else if (!Object.values(RUN_STATES).includes(manifest.state)) {
    errors.push(`Invalid manifest state: ${manifest.state}`);
  }
  if (!manifest.project?.id) errors.push("Missing project.id");
  if (!manifest.project?.repository) errors.push("Missing project.repository");
  if (!manifest.task?.path) errors.push("Missing task.path");
  if (manifest.history !== undefined && !Array.isArray(manifest.history)) {
    errors.push("history must be an array");
  }
  return { valid: errors.length === 0, errors };
}

export function validateJob(job) {
  const errors = [];
  if (!job || typeof job !== "object") {
    return { valid: false, errors: ["Job must be a non-null object"] };
  }
  if (!job.schemaVersion) errors.push("Missing schemaVersion");
  if (!job.jobId || typeof job.jobId !== "string") errors.push("Missing or invalid jobId");
  if (!job.projectId || typeof job.projectId !== "string") errors.push("Missing or invalid projectId");
  if (!job.taskId || typeof job.taskId !== "string") errors.push("Missing or invalid taskId");
  if (!job.state) {
    errors.push("Missing state");
  } else if (!Object.values(JOB_STATES).includes(job.state)) {
    errors.push(`Invalid job state: ${job.state}`);
  }
  return { valid: errors.length === 0, errors };
}
