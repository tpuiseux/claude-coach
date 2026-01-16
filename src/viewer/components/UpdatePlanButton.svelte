<script lang="ts">
  import { planData } from "../stores/plan";
  import {
    updatePlanAndRegenerate,
    getChangesFromLocalStorage,
    hasPendingChanges,
    type UpdateResult,
  } from "../lib/UpdatePlan";

  let isUpdating = $state(false);
  let result = $state<UpdateResult | null>(null);
  let showResult = $state(false);

  let hasChanges = $derived(hasPendingChanges(planData.meta.id));

  async function handleUpdatePlan() {
    isUpdating = true;
    result = null;

    try {
      const { changes, completed } = getChangesFromLocalStorage(planData.meta.id);
      result = updatePlanAndRegenerate(planData, changes, completed);
      showResult = true;

      if (result.success) {
        setTimeout(() => {
          showResult = false;
        }, 5000);
      }
    } catch (error) {
      result = {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
      showResult = true;
    } finally {
      isUpdating = false;
    }
  }
</script>

<button class="data-btn export" onclick={handleUpdatePlan} disabled={!hasChanges || isUpdating}>
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
    <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
    <polyline points="7 10 12 15 17 10" />
    <line x1="12" y1="15" x2="12" y2="3" />
  </svg>
  Export
</button>

{#if showResult && result}
  <!-- svelte-ignore a11y_click_events_have_key_events -->
  <!-- svelte-ignore a11y_no_static_element_interactions -->
  <div class="result-modal" onclick={() => (showResult = false)}>
    <!-- svelte-ignore a11y_click_events_have_key_events -->
    <!-- svelte-ignore a11y_no_static_element_interactions -->
    <div class="result-content" onclick={(e) => e.stopPropagation()}>
      {#if result.success}
        <div class="success">
          <svg
            width="48"
            height="48"
            viewBox="0 0 48 48"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <circle cx="24" cy="24" r="22" stroke="#10b981" stroke-width="3" />
            <path
              d="M14 24L20 30L34 16"
              stroke="#10b981"
              stroke-width="3"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>

          <h3>Plan Updated Successfully! ✨</h3>

          <p class="files-downloaded">1 file downloaded:</p>
          <ul>
            <li>📄 <code>{result.planFilename}</code></li>
          </ul>

          {#if result.changesSummary}
            <div class="summary">
              <p class="summary-title">Changes applied:</p>
              <div class="summary-grid">
                {#if result.changesSummary.moved > 0}
                  <div class="summary-item">
                    <span class="summary-count">{result.changesSummary.moved}</span>
                    <span class="summary-label">moved</span>
                  </div>
                {/if}
                {#if result.changesSummary.edited > 0}
                  <div class="summary-item">
                    <span class="summary-count">{result.changesSummary.edited}</span>
                    <span class="summary-label">edited</span>
                  </div>
                {/if}
                {#if result.changesSummary.deleted > 0}
                  <div class="summary-item">
                    <span class="summary-count">{result.changesSummary.deleted}</span>
                    <span class="summary-label">deleted</span>
                  </div>
                {/if}
                {#if result.changesSummary.added > 0}
                  <div class="summary-item">
                    <span class="summary-count">{result.changesSummary.added}</span>
                    <span class="summary-label">added</span>
                  </div>
                {/if}
                {#if result.changesSummary.completed > 0}
                  <div class="summary-item">
                    <span class="summary-count">{result.changesSummary.completed}</span>
                    <span class="summary-label">completed</span>
                  </div>
                {/if}
              </div>
            </div>
          {/if}

          <p class="next-steps">
            Use <code>claude-coach render {result.planFilename} -o updated.html</code> to generate the
            HTML viewer.
          </p>
        </div>
      {:else}
        <div class="error">
          <svg
            width="48"
            height="48"
            viewBox="0 0 48 48"
            fill="none"
            xmlns="http://www.w3.org/2000/svg"
          >
            <circle cx="24" cy="24" r="22" stroke="#ef4444" stroke-width="3" />
            <path
              d="M16 16L32 32M32 16L16 32"
              stroke="#ef4444"
              stroke-width="3"
              stroke-linecap="round"
            />
          </svg>

          <h3>Update Failed</h3>
          <p class="error-message">{result.error}</p>
        </div>
      {/if}

      <button class="close-button" onclick={() => (showResult = false)}> Close </button>
    </div>
  </div>
{/if}

<style>
  /* Button styles (same as SettingsModal) */
  .data-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.6rem 1rem;
    border-radius: 8px;
    border: 1px solid var(--border-medium);
    background: var(--bg-secondary);
    color: var(--text-primary);
    font-size: 0.85rem;
    font-weight: 500;
    transition: all var(--transition-fast);
    flex-shrink: 0;
    cursor: pointer;
  }

  .data-btn svg {
    width: 16px;
    height: 16px;
  }

  .data-btn:hover {
    background: var(--bg-elevated);
    border-color: var(--border-medium);
    color: var(--text-primary);
  }

  .data-btn.export:hover {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--bg-primary);
  }

  .data-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  /* Modal styles only */
  .result-modal {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.5);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    animation: fadeIn 0.2s ease;
  }

  @keyframes fadeIn {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }

  .result-content {
    background: white;
    border-radius: 16px;
    padding: 32px;
    max-width: 500px;
    width: 90%;
    max-height: 90vh;
    overflow-y: auto;
    box-shadow: 0 20px 60px rgba(0, 0, 0, 0.3);
    animation: slideUp 0.3s ease;
  }

  @keyframes slideUp {
    from {
      transform: translateY(20px);
      opacity: 0;
    }
    to {
      transform: translateY(0);
      opacity: 1;
    }
  }

  .success,
  .error {
    text-align: center;
  }

  .success svg,
  .error svg {
    margin: 0 auto 20px;
  }

  h3 {
    font-size: 24px;
    font-weight: 600;
    margin: 0 0 16px;
    color: #1f2937;
  }

  .files-downloaded {
    font-size: 14px;
    color: #6b7280;
    margin: 16px 0 8px;
  }

  ul {
    list-style: none;
    padding: 0;
    margin: 0 0 24px;
    text-align: left;
  }

  li {
    padding: 8px 12px;
    background: #f3f4f6;
    border-radius: 6px;
    margin-bottom: 8px;
    font-size: 14px;
    color: #374151;
  }

  code {
    font-family: "SF Mono", Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
    font-size: 13px;
    color: #667eea;
  }

  .summary {
    background: #f9fafb;
    border-radius: 8px;
    padding: 16px;
    margin: 16px 0;
  }

  .summary-title {
    font-size: 13px;
    font-weight: 500;
    color: #6b7280;
    margin: 0 0 12px;
    text-align: left;
  }

  .summary-grid {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(80px, 1fr));
    gap: 12px;
  }

  .summary-item {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 4px;
  }

  .summary-count {
    font-size: 24px;
    font-weight: 700;
    color: #667eea;
  }

  .summary-label {
    font-size: 12px;
    color: #6b7280;
  }

  .next-steps {
    font-size: 14px;
    color: #6b7280;
    margin: 16px 0 0;
  }

  .error-message {
    color: #ef4444;
    font-size: 14px;
    background: #fef2f2;
    padding: 12px;
    border-radius: 6px;
    margin: 16px 0;
  }

  .close-button {
    width: 100%;
    padding: 12px;
    background: #f3f4f6;
    border: none;
    border-radius: 8px;
    font-size: 14px;
    font-weight: 500;
    color: #374151;
    cursor: pointer;
    transition: background 0.2s;
  }

  .close-button:hover {
    background: #e5e7eb;
  }
</style>
