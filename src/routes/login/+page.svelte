<script lang="ts">
  import { enhance } from "$app/forms";
  import { base } from "$app/paths";
  import type { ActionData, PageData } from "./$types";

  interface Props {
    data: PageData;
    form: ActionData;
  }

  let { data, form }: Props = $props();
</script>

<svelte:head>
  <title>Log in — Claude Coach</title>
</svelte:head>

<main>
  <form method="POST" use:enhance>
    <h1>Claude Coach</h1>

    {#if form?.error}
      <p class="error">{form.error}</p>
    {/if}

    <label>
      Email
      <input type="email" name="email" value={form?.email ?? ""} required />
    </label>

    <label>
      Password
      <input type="password" name="password" required />
    </label>

    <button type="submit">Log in</button>

    {#if data.signupOpen}
      <p class="switch">No account yet? <a href="{base}/signup">Create one</a></p>
    {/if}
  </form>
</main>

<style>
  main {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    background: #0a0a0b;
    color: #fafafa;
    font-family:
      system-ui,
      -apple-system,
      sans-serif;
  }

  form {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    width: 320px;
    padding: 2rem;
    border: 1px solid #232327;
    border-radius: 12px;
    background: #141416;
  }

  h1 {
    font-size: 1.4rem;
    margin: 0 0 0.5rem;
    text-align: center;
  }

  label {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    font-size: 0.85rem;
    color: #a1a1aa;
  }

  input {
    padding: 0.6rem 0.75rem;
    border-radius: 8px;
    border: 1px solid #232327;
    background: #1c1c1f;
    color: #fafafa;
    font-size: 0.95rem;
  }

  button {
    margin-top: 0.5rem;
    padding: 0.7rem;
    border-radius: 8px;
    border: none;
    background: #eab308;
    color: #0a0a0b;
    font-weight: 600;
    cursor: pointer;
  }

  .switch {
    margin: 0;
    text-align: center;
    font-size: 0.85rem;
    color: #a1a1aa;
  }

  .switch a {
    color: #eab308;
  }

  .error {
    margin: 0;
    padding: 0.6rem 0.75rem;
    border-radius: 8px;
    background: #3a1414;
    color: #f87171;
    font-size: 0.85rem;
  }
</style>
