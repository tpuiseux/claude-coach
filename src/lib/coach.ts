/**
 * The coach chat as the plan view sees it: messages reduced to what's shown
 * (text, plus a note of what the coach looked at), and plan changes the
 * coach proposed. Shared by the server (lib/server/coach/) and the chat
 * panel (lib/components/CoachPanel.svelte).
 */

import type { StructuredWorkout, Workout } from "../schema/training-plan.js";

/** Workout fields the coach may set - the same ones the app lets the athlete
 * edit (lib/server/validation.ts), plus the device-export structure. */
export type CoachWorkoutFields = Partial<
  Pick<
    Workout,
    | "sport"
    | "type"
    | "name"
    | "description"
    | "durationMinutes"
    | "distanceMeters"
    | "primaryZone"
    | "humanReadable"
    | "rpe"
    | "notes"
  >
> & { structure?: StructuredWorkout };

export type PlanChange =
  | { op: "move"; workoutId: string; date: string; reason: string }
  | { op: "edit"; workoutId: string; updates: CoachWorkoutFields; reason: string }
  | { op: "add"; date: string; workout: CoachWorkoutFields; reason: string }
  | { op: "delete"; workoutId: string; reason: string };

/** A workout as a proposal card shows it, before or after the change. */
export interface WorkoutSnapshot {
  date: string;
  name: string;
  sport: string;
  durationMinutes: number | null;
}

/** One change, ready to display: what the workout was and what it becomes. */
export interface ChangePreview {
  op: PlanChange["op"];
  before: WorkoutSnapshot | null;
  after: WorkoutSnapshot | null;
  /** Fields an edit touches, e.g. ["durationMinutes", "description"]. */
  fields: string[];
  reason: string;
}

export type ProposalStatus = "pending" | "applied" | "rejected" | "undone";

export interface CoachProposal {
  id: number;
  summary: string;
  changes: ChangePreview[];
  status: ProposalStatus;
  createdAt: string;
}

export interface CoachChatMessage {
  id: number;
  role: "user" | "assistant";
  text: string;
  /** What the coach looked up on the way, e.g. "Read week 7". */
  activity: string[];
  /** Proposals made in this message. */
  proposalIds: number[];
}

export interface CoachConversation {
  messages: CoachChatMessage[];
  proposals: CoachProposal[];
}

/** One line of the streamed reply (NDJSON) to a message sent to the coach. */
export type CoachEvent =
  | { type: "text"; delta: string }
  | { type: "activity"; label: string }
  | { type: "proposal"; proposal: CoachProposal }
  | { type: "done" }
  | { type: "error"; message: string };
