#!/usr/bin/env tsx
/**
 * Admin-only account creation. There's no public signup for this platform -
 * accounts are created by whoever runs this script.
 *
 * Usage:
 *   npm run create-user -- --email you@example.com --name "Your Name"
 *   (prompts for a password; or pass --password to script it non-interactively)
 */

import * as readline from "readline";
import { initDatabase } from "../src/db/client.js";
import { migrate } from "../src/db/migrate.js";
import { createUser } from "../src/auth/users.js";
import { log } from "../src/lib/logging.js";

function parseArgs(): { email?: string; name?: string; password?: string } {
  const args = process.argv.slice(2);
  const result: { email?: string; name?: string; password?: string } = {};
  for (let i = 0; i < args.length; i++) {
    const value = args[i + 1];
    if (args[i] === "--email") result.email = value;
    if (args[i] === "--name") result.name = value;
    if (args[i] === "--password") result.password = value;
  }
  return result;
}

function promptHidden(question: string): Promise<string> {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function main() {
  const { email, name, password: passwordArg } = parseArgs();

  if (!email) {
    log.error('Usage: npm run create-user -- --email you@example.com [--name "Your Name"]');
    process.exit(1);
  }

  const password = passwordArg ?? (await promptHidden(`Password for ${email}: `));
  if (!password || password.length < 8) {
    log.error("Password must be at least 8 characters.");
    process.exit(1);
  }

  await initDatabase();
  migrate();

  const user = createUser(email, password, name);
  log.success(`Created user #${user.id} (${user.email})`);
}

main().catch((err) => {
  log.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
