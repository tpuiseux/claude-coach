import { readFileSync } from "fs";
import { sveltekit } from "@sveltejs/kit/vite";
import { defineConfig } from "vite";

// The SvelteKit web app. Distinct from vite.config.viewer.ts, which still
// builds the legacy single-file plan viewer (retired once the multi-user
// rewrite is deployed - see the SaaS migration plan).

// Read here (this file runs in Node, not the browser) rather than importing
// package.json from a .svelte component - Vite's dev server refuses to
// serve files outside its fs allow-list, and package.json at the repo root
// falls outside it given this project's nested folder layout.
const { version } = JSON.parse(readFileSync(new URL("./package.json", import.meta.url), "utf-8"));

export default defineConfig({
  plugins: [sveltekit()],
  define: {
    __APP_VERSION__: JSON.stringify(version),
  },
});
