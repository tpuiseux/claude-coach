import { get, run } from "../../db/client.js";
import type { TrainingPlan } from "../../schema/training-plan.js";

interface PlanRow {
  data: string;
}

/**
 * Loads a plan scoped to its owner - the WHERE user_id=? here (not just id)
 * is the actual multi-tenant boundary. Returns null rather than throwing so
 * callers can 404 without leaking whether the id exists for someone else.
 */
export function loadPlanForUser(planId: string, userId: number): TrainingPlan | null {
  const row = get<PlanRow>("SELECT data FROM plans WHERE id = ? AND user_id = ?", [planId, userId]);
  if (!row) return null;
  return JSON.parse(row.data) as TrainingPlan;
}

export function savePlanForUser(planId: string, userId: number, plan: TrainingPlan): void {
  const result = run(
    `UPDATE plans SET data = ?, event = ?, event_date = ?, updated_at = ?
     WHERE id = ? AND user_id = ?`,
    [
      JSON.stringify(plan),
      plan.meta.event,
      plan.meta.eventDate,
      plan.meta.updatedAt,
      planId,
      userId,
    ]
  );
  if (result.changes === 0) {
    throw new Error(`Plan ${planId} not found for this user`);
  }
}

export class PlanOwnershipError extends Error {
  constructor(planId: string) {
    super(`Plan ${planId} belongs to a different account - refusing to overwrite it`);
  }
}

/**
 * Import (create or overwrite) a plan from an uploaded JSON file - the
 * "Import Plan" button on the dashboard. Upserts on `id` (== plan.meta.id):
 * if the id already exists for THIS user, the whole row is replaced
 * (matches how re-running `/coach` on the same plan is expected to behave);
 * if it exists for a DIFFERENT user, refuse rather than silently stealing
 * their plan id.
 */
export function importPlanForUser(userId: number, plan: TrainingPlan): void {
  const planId = plan.meta.id;
  const existing = get<{ user_id: number }>("SELECT user_id FROM plans WHERE id = ?", [planId]);

  if (existing && existing.user_id !== userId) {
    throw new PlanOwnershipError(planId);
  }

  run(
    `INSERT INTO plans (id, user_id, event, event_date, data, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(id) DO UPDATE SET
       event = excluded.event,
       event_date = excluded.event_date,
       data = excluded.data,
       updated_at = excluded.updated_at`,
    [
      planId,
      userId,
      plan.meta.event,
      plan.meta.eventDate,
      JSON.stringify(plan),
      plan.meta.createdAt,
      plan.meta.updatedAt,
    ]
  );
}
