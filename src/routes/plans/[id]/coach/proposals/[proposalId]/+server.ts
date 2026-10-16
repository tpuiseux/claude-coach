import { error, json } from "@sveltejs/kit";
import type { RequestHandler } from "./$types";
import { loadPlanForUser, savePlanForUser } from "$lib/server/plans.js";
import { applyPlanChanges } from "$lib/server/coach/changes.js";
import { getProposal, setProposalStatus } from "$lib/server/coach/store.js";
import { readJsonBody } from "$lib/server/validation.js";
import type { TrainingPlan } from "../../../../../../schema/training-plan.js";

/**
 * The athlete's answer to a proposal: apply it, reject it, or undo it once
 * applied. Undo puts back the plan exactly as it was before applying - so
 * only while nothing else changed it since, or those changes would be lost.
 */
export const POST: RequestHandler = async ({ params, request, locals }) => {
  const userId = locals.user!.id;
  const id = Number(params.proposalId);
  const found = Number.isInteger(id) ? getProposal(userId, params.id, id) : null;
  if (!found) throw error(404, "Proposal not found");
  const plan = loadPlanForUser(params.id, userId);
  if (!plan) throw error(404, "Plan not found");

  const body = (await readJsonBody(request).catch(() => null)) as { action?: unknown } | null;
  const { status } = found.proposal;

  switch (body?.action) {
    case "apply": {
      if (status !== "pending") throw error(409, "This proposal was already answered.");
      const before = JSON.stringify(plan);
      try {
        applyPlanChanges(plan, found.changes);
      } catch (err) {
        if (err instanceof Error) {
          throw error(409, `The plan changed since this was proposed: ${err.message}`);
        }
        throw err;
      }
      savePlanForUser(params.id, userId, plan);
      setProposalStatus(id, "applied", { planBefore: before, version: plan.meta.updatedAt });
      break;
    }
    case "reject":
      if (status !== "pending") throw error(409, "This proposal was already answered.");
      setProposalStatus(id, "rejected");
      break;
    case "undo": {
      if (status !== "applied" || !found.planBefore) throw error(409, "Nothing to undo.");
      if (plan.meta.updatedAt !== found.appliedVersion) {
        throw error(
          409,
          "The plan changed after this was applied - undoing it would lose those changes."
        );
      }
      const previous = JSON.parse(found.planBefore) as TrainingPlan;
      previous.meta.updatedAt = new Date().toISOString();
      savePlanForUser(params.id, userId, previous);
      setProposalStatus(id, "undone");
      break;
    }
    default:
      throw error(400, "action must be apply, reject or undo");
  }

  return json({ ok: true, proposal: getProposal(userId, params.id, id)!.proposal });
};
