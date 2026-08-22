// See https://svelte.dev/docs/kit/types#app.d.ts

declare global {
  namespace App {
    interface Locals {
      // Never the full auth/users.ts `User` row - password_hash has no
      // business being reachable from route code or accidentally logged.
      user: { id: number; email: string; name: string | null } | null;
    }
  }
}

export {};
