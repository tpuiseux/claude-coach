<script lang="ts">
  import type { TrainingPlan } from "../../schema/training-plan.js";
  import type { PlanChanges } from "../lib/UpdatePlan.js";
  import type { PlanBridgeConfig } from "../stores/planBridge.js";
  import { checkPlanBridgeHealth, saveToPlanBridge } from "../lib/planBridge.js";

  interface Props {
    plan: TrainingPlan;
    changes: PlanChanges;
    completed: Record<string, boolean>;
    planBridgeConfig: PlanBridgeConfig;
    hasPendingChanges: boolean;
    onOpenSettings: () => void;
  }

  let { plan, changes, completed, planBridgeConfig, hasPendingChanges, onOpenSettings }: Props =
    $props();

  const configured = $derived(!!planBridgeConfig.url);
  let busy = $state(false);
  let statusMessage = $state<string | null>(null);
  let statusIsError = $state(false);
  let lastSavedAt = $state<string | null>(null);

  // Re-check reachability whenever the bridge gets (re)configured, not just
  // once at mount — the URL/token can change while this component stays
  // mounted, since they're edited in a sibling Settings modal.
  $effect(() => {
    if (!configured) return;
    checkPlanBridgeHealth().then((result) => {
      if (!result.ok) {
        statusMessage = result.message;
        statusIsError = true;
      }
    });
  });

  function flashStatus(message: string, isError: boolean, ms = 4000) {
    statusMessage = message;
    statusIsError = isError;
    setTimeout(() => {
      if (statusMessage === message) statusMessage = null;
    }, ms);
  }

  async function doSave() {
    if (busy) return;
    busy = true;
    const result = await saveToPlanBridge(plan, changes, completed);
    busy = false;
    if (result.ok) {
      lastSavedAt = result.savedAt ?? new Date().toISOString();
      flashStatus(result.message, false, 3000);
    } else {
      flashStatus(result.message, true);
    }
  }

  // Auto-save shortly after each local edit, once the bridge is configured.
  let saveTimer: ReturnType<typeof setTimeout> | undefined;
  $effect(() => {
    void changes;
    void completed;
    if (!configured || !hasPendingChanges) return;
    clearTimeout(saveTimer);
    saveTimer = setTimeout(doSave, 1500);
    return () => clearTimeout(saveTimer);
  });

  const lastSavedLabel = $derived(
    lastSavedAt
      ? new Date(lastSavedAt).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" })
      : null
  );
</script>

<div class="bridge-save">
  {#if configured}
    <button class="bridge-save-btn" onclick={doSave} disabled={busy}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path d="M19 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11l5 5v11a2 2 0 0 1-2 2Z" />
        <polyline points="17 21 17 13 7 13 7 21" />
        <polyline points="7 3 7 8 15 8" />
      </svg>
      {busy ? "Enregistrement…" : "Enregistrer sur le serveur"}
    </button>
    {#if lastSavedLabel}
      <div class="bridge-save-hint">Dernière sauvegarde à {lastSavedLabel}</div>
    {/if}
  {:else}
    <button class="bridge-save-btn" onclick={onOpenSettings}>
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
        <path
          d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
        />
        <circle cx="12" cy="12" r="3" />
      </svg>
      Configurer la sauvegarde serveur
    </button>
  {/if}
  {#if statusMessage}
    <div class="bridge-save-status" class:error={statusIsError}>{statusMessage}</div>
  {/if}
</div>

<style>
  .bridge-save {
    display: flex;
    flex-direction: column;
    gap: 0.4rem;
  }

  .bridge-save-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.5rem;
    width: 100%;
    padding: 0.7rem 1rem;
    border-radius: 8px;
    border: 1px solid var(--border-medium);
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 0.85rem;
    font-weight: 500;
    cursor: pointer;
    transition: all var(--transition-fast);
  }

  .bridge-save-btn svg {
    width: 16px;
    height: 16px;
    flex-shrink: 0;
  }

  .bridge-save-btn:hover:not(:disabled) {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--bg-primary);
  }

  .bridge-save-btn:disabled {
    opacity: 0.6;
    cursor: not-allowed;
  }

  .bridge-save-hint,
  .bridge-save-status {
    font-size: 0.75rem;
    color: var(--text-muted);
    text-align: center;
  }

  .bridge-save-status {
    color: var(--accent);
  }

  .bridge-save-status.error {
    color: var(--danger, #dc2626);
  }
</style>
