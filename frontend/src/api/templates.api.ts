/**
 * Task-templates domain API module.
 *
 * Wraps the backend "Task-templates module" (CRUD + generate) with typed
 * functions calling `client.ts`.
 *
 * Response-envelope assumptions (design "REST API Design"):
 *   GET    /family/task-templates          -> { templates: TaskTemplate[] } (-> array)
 *   POST   /family/task-templates          -> 201 { template }              (-> template)
 *   PATCH  /task-templates/:id             -> { template }                  (-> template)
 *   DELETE /task-templates/:id             -> 204 (deactivate)              (-> void)
 *   POST   /family/task-templates/generate -> { weekStart, created }        (whole)
 */

import { get, post, patch, del } from './client';
import type {
  TaskTemplate,
  TemplateCreate,
  TemplateUpdate,
  GenerateRecurring,
  GenerateRecurringResult,
} from './types';

interface TemplatesEnvelope {
  templates: TaskTemplate[];
}

interface TemplateEnvelope {
  template: TaskTemplate;
}

/** `GET /family/task-templates` — all templates. Unwraps `{ templates }`. */
export async function list(signal?: AbortSignal): Promise<TaskTemplate[]> {
  const res = await get<TemplatesEnvelope>(
    '/family/task-templates',
    undefined,
    signal,
  );
  return res.templates;
}

/** `POST /family/task-templates` — create. Unwraps `{ template }`. */
export async function create(
  body: TemplateCreate,
  signal?: AbortSignal,
): Promise<TaskTemplate> {
  const res = await post<TemplateEnvelope>(
    '/family/task-templates',
    body,
    signal,
  );
  return res.template;
}

/** `PATCH /task-templates/:id` — update. Unwraps `{ template }`. */
export async function update(
  id: string,
  body: TemplateUpdate,
  signal?: AbortSignal,
): Promise<TaskTemplate> {
  const res = await patch<TemplateEnvelope>(
    `/task-templates/${id}`,
    body,
    signal,
  );
  return res.template;
}

/** `DELETE /task-templates/:id` — deactivate. Backend answers 204 → void. */
export function remove(id: string, signal?: AbortSignal): Promise<void> {
  return del<void>(`/task-templates/${id}`, signal);
}

/**
 * `POST /family/task-templates/generate` — materialize recurring tasks for the
 * given (Monday) `weekStart`. Returns the full `{ weekStart, created }` result.
 */
export function generate(
  body: GenerateRecurring,
  signal?: AbortSignal,
): Promise<GenerateRecurringResult> {
  return post<GenerateRecurringResult>(
    '/family/task-templates/generate',
    body,
    signal,
  );
}

export const templates = {
  list,
  create,
  update,
  remove,
  generate,
};
