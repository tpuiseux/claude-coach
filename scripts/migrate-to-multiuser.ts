#!/usr/bin/env tsx
/**
 * One-off migration: run once, after `npm run create-user`, to attach all
 * pre-multi-user data in ~/.claude-coach/coach.db to that account, and
 * import an existing plan JSON file as that user's first plan.
 *
 * Usage:
 *   npm run migrate-to-multiuser -- --email you@example.com --plan /path/to/plan.json
 *
 * Safe to re-run: the activities/athlete/goals/sync_log backfill only
 * touches rows where user_id IS NULL, and the plan import uses
 * INSERT OR REPLACE keyed on the plan's own id.
 */

import { readFileSync } from "fs";
import { initDatabase, run } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { findUserByEmail } from "../src/auth/users.js";
import { log } from "../src/lib/logging.js";
import type { TrainingPlan } from "../src/schema/training-plan.js";

function parseArgs(): { email?: string; plan?: string } {
  const args = process.argv.slice(2);
  const result: { email?: string; plan?: string } = {};
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--email") result.email = args[i + 1];
    if (args[i] === "--plan") result.plan = args[i + 1];
  }
  return result;
}

async function main() {
  const { email, plan: planPath } = parseArgs();

  if (!email) {
    log.error(
      "Usage: npm run migrate-to-multiuser -- --email you@example.com [--plan /path/to/plan.json]"
    );
    process.exit(1);
  }

  await initDatabase();
  migrate();

  const user = findUserByEmail(email);
  if (!user) {
    log.error(`No user with email ${email} - run "npm run create-user" first.`);
    process.exit(1);
  }

  for (const table of ["activities", "athlete", "goals", "sync_log"]) {
    const result = run(`UPDATE ${table} SET user_id = ? WHERE user_id IS NULL`, [user.id]);
    log.info(`${table}: backfilled ${result.changes} row(s) to user #${user.id}`);
  }

  if (planPath) {
    const raw = readFileSync(planPath, "utf-8");
    const plan = JSON.parse(raw) as TrainingPlan;

    if (!plan?.meta?.id) {
      log.error(`${planPath} doesn't look like a TrainingPlan (missing meta.id)`);
      process.exit(1);
    }

    run(
      `INSERT INTO plans (id, user_id, event, event_date, data, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         user_id = excluded.user_id,
         event = excluded.event,
         event_date = excluded.event_date,
         data = excluded.data,
         updated_at = excluded.updated_at`,
      [
        plan.meta.id,
        user.id,
        plan.meta.event,
        plan.meta.eventDate,
        raw,
        plan.meta.createdAt,
        plan.meta.updatedAt,
      ]
    );
    log.success(`Imported plan "${plan.meta.event}" (${plan.meta.id}) for user #${user.id}`);
  }

  log.success("Migration complete.");
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
