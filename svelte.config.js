import adapter from "@sveltejs/adapter-node";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// SvelteKit bakes paths.base into the build - it can't be changed at
// runtime. Locally this stays "" (app lives at /) for easy dev; the
// Docker build passes BASE_PATH=/training-plan so the production image
// matches the nginx location it's actually deployed under. Every
// hardcoded root-relative path in this app's own code (redirects, hrefs,
// fetch URLs) still needs to import `base` from $app/paths and prepend it
// by hand - SvelteKit only auto-prefixes its own generated asset tags.
const base = process.env.BASE_PATH ?? "";

export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter(),
    paths: {
      base,
    },
  },
};
