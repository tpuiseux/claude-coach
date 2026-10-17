<script lang="ts">
  import { invalidateAll } from "$app/navigation";
  import { base } from "$app/paths";
  import type { PageData } from "./$types";

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let fileInput = $state<HTMLInputElement | null>(null);
  let importing = $state(false);
  let importStatus = $state<{ message: string; isError: boolean } | null>(null);

  function handleImportClick() {
    fileInput?.click();
  }

  async function handleFileSelect(e: Event) {
    const input = e.target as HTMLInputElement;
    const file = input.files?.[0];
    if (!file) return;

    importing = true;
    importStatus = null;
    try {
      const body = new FormData();
      body.append("plan", file);
      const res = await fetch(`${base}/plans`, { method: "POST", body });
      const result = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(result?.message ?? `Import failed (${res.status})`);
      }
      importStatus = { message: `Imported ${result.planId}.`, isError: false };
      await invalidateAll();
    } catch (err) {
      importStatus = {
        message: err instanceof Error ? err.message : "Import failed.",
        isError: true,
      };
    } finally {
      importing = false;
      input.value = "";
    }
  }
</script>

<svelte:head>
  <title>Claude Coach</title>
</svelte:head>

<main>
  <header>
    <h1>Your plans</h1>
    <div class="header-actions">
      <a class="create" href="{base}/plans/new">Create a plan</a>
      <button onclick={handleImportClick} disabled={importing}>
        {importing ? "Importing…" : "Import plan"}
      </button>
      <input
        type="file"
        accept=".json,application/json"
        bind:this={fileInput}
        onchange={handleFileSelect}
        style="display: none"
      />
      <form method="POST" action="{base}/logout">
        <button type="submit">Log out ({data.user?.email})</button>
      </form>
    </div>
  </header>

  {#if importStatus}
    <p class="status" class:error={importStatus.isError}>{importStatus.message}</p>
  {/if}

  {#if data.plans.length === 0}
    <div class="empty">
      <p>No training plan yet.</p>
      <a class="create big" href="{base}/plans/new">Create my plan with the coach</a>
      <p class="hint">
        Or generate one with the <code>/coach</code> skill in Claude Code and import the JSON file.
      </p>
    </div>
  {:else}
    <ul>
      {#each data.plans as plan (plan.id)}
        <li>
          <a href="{base}/plans/{plan.id}">
            <strong>{plan.event}</strong>
            <span>{plan.event_date}</span>
          </a>
        </li>
      {/each}
    </ul>
  {/if}
</main>

<style>
  main {
    max-width: 640px;
    margin: 3rem auto;
    padding: 0 1.5rem;
    font-family:
      system-ui,
      -apple-system,
      sans-serif;
    color: #fafafa;
  }

  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    margin-bottom: 1.5rem;
    gap: 1rem;
  }

  .header-actions {
    display: flex;
    align-items: center;
    gap: 0.6rem;
  }

  h1 {
    font-size: 1.5rem;
    margin: 0;
  }

  button {
    padding: 0.5rem 0.9rem;
    border-radius: 8px;
    border: 1px solid #232327;
    background: #1c1c1f;
    color: #fafafa;
    cursor: pointer;
    font-size: 0.85rem;
  }

  button:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .create {
    padding: 0.5rem 0.9rem;
    border-radius: 8px;
    background: #eab308;
    color: #0a0a0b;
    font-weight: 600;
    font-size: 0.85rem;
    text-decoration: none;
    white-space: nowrap;
  }

  .create.big {
    display: inline-block;
    padding: 0.75rem 1.2rem;
    font-size: 0.95rem;
    margin: 0.5rem 0 1rem;
  }

  .empty .hint {
    color: #a1a1aa;
    font-size: 0.85rem;
  }

  .status {
    margin: 0 0 1.5rem;
    padding: 0.6rem 0.9rem;
    border-radius: 8px;
    background: rgba(234, 179, 8, 0.12);
    color: #eab308;
    font-size: 0.85rem;
  }

  .status.error {
    background: rgba(239, 68, 68, 0.1);
    color: #f87171;
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  li a {
    display: flex;
    justify-content: space-between;
    padding: 1rem 1.25rem;
    border: 1px solid #232327;
    border-radius: 10px;
    color: #fafafa;
    text-decoration: none;
    background: #141416;
  }

  li a span {
    color: #a1a1aa;
  }

  @media (max-width: 600px) {
    main {
      margin: 1.5rem auto;
      padding: 0 1rem;
    }

    header {
      flex-direction: column;
      align-items: stretch;
    }

    .header-actions {
      flex-wrap: wrap;
    }

    .header-actions > button,
    .header-actions > .create,
    .header-actions form,
    .header-actions form button {
      flex: 1;
    }

    .header-actions form {
      display: flex;
      min-width: 0;
    }

    .header-actions button {
      min-height: 44px;
      max-width: 100%;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }

    li a {
      gap: 1rem;
      padding: 1.1rem 1.25rem;
    }
  }
</style>
