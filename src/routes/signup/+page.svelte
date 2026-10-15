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
  <title>Create an account — Claude Coach</title>
</svelte:head>

<main>
  <form method="POST" use:enhance>
    <h1>Create an account</h1>

    {#if form?.error}
      <p class="error">{form.error}</p>
    {/if}

    <label>
      Invite code
      <input type="text" name="inviteCode" autocomplete="off" required />
    </label>

    <label>
      Email
      <input type="email" name="email" value={form?.email ?? ""} autocomplete="email" required />
    </label>

    <label>
      Name <span class="optional">(optional)</span>
      <input type="text" name="name" value={form?.name ?? ""} autocomplete="name" maxlength="100" />
    </label>

    <label>
      Password
      <input
        type="password"
        name="password"
        autocomplete="new-password"
        minlength={data.minPasswordLength}
        required
      />
      <span class="hint">At least {data.minPasswordLength} characters.</span>
    </label>

    <label>
      Confirm password
      <input
        type="password"
        name="confirmPassword"
        autocomplete="new-password"
        minlength={data.minPasswordLength}
        required
      />
    </label>

    <button type="submit">Create account</button>

    <p class="switch">Already have an account? <a href="{base}/login">Log in</a></p>
  </form>
</main>

<style>
  main {
    min-height: 100vh;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 1rem;
    box-sizing: border-box;
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
    width: 100%;
    max-width: 320px;
    padding: 2rem;
    box-sizing: border-box;
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

  .optional,
  .hint {
    font-size: 0.75rem;
    color: #71717a;
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
