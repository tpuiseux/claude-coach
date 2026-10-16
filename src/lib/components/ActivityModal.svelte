<script lang="ts">
  import type { Settings } from "../settings.js";
  import type { RecordedActivity } from "../trainingLog.js";
  import { formatActivitySummary, formatDate } from "../utils.js";
  import ActivityAnalysis from "./ActivityAnalysis.svelte";

  /** A recorded activity that matched nothing in the plan, in detail. */
  interface Props {
    activity: RecordedActivity;
    settings: Settings;
    onClose: () => void;
  }

  let { activity, settings, onClose }: Props = $props();

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") onClose();
  }

  function handleBackdropClick(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains("modal-overlay")) onClose();
  }
</script>

<svelte:window on:keydown={handleKeydown} />

<div
  class="modal-overlay"
  onclick={handleBackdropClick}
  onkeydown={handleKeydown}
  role="dialog"
  aria-modal="true"
  tabindex="-1"
>
  <div class="modal">
    <div class="modal-header">
      <div>
        <div class="modal-badge">Not in plan</div>
        <h2 class="modal-title">{activity.name ?? activity.sportType}</h2>
        <div class="modal-date">
          {formatDate(activity.startLocal.slice(0, 10))} · {formatActivitySummary(
            activity,
            settings
          )}
        </div>
      </div>
      <button class="modal-close" onclick={onClose} aria-label="Close">×</button>
    </div>
    <div class="modal-body">
      <ActivityAnalysis {activity} {settings} />
    </div>
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    backdrop-filter: blur(4px);
    display: flex;
    align-items: center;
    justify-content: center;
    z-index: 1000;
    padding: 2rem;
  }

  .modal {
    background: var(--bg-secondary);
    border-radius: 20px;
    max-width: 760px;
    width: 100%;
    max-height: 85vh;
    overflow: hidden;
    border: 1px solid var(--border-medium);
    display: flex;
    flex-direction: column;
  }

  .modal-header {
    padding: 1.5rem 2rem 0.5rem;
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 1rem;
  }

  .modal-badge {
    display: inline-block;
    font-size: 0.65rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--accent);
    margin-bottom: 0.35rem;
  }

  .modal-title {
    font-size: 1.4rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .modal-date {
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .modal-close {
    background: none;
    border: none;
    color: var(--text-muted);
    font-size: 1.75rem;
    line-height: 1;
    cursor: pointer;
  }

  .modal-close:hover {
    color: var(--text-primary);
  }

  .modal-body {
    padding: 0.5rem 2rem 1.5rem;
    overflow-y: auto;
  }

  @media (max-width: 800px) {
    .modal-overlay {
      padding: 0;
    }

    .modal {
      max-width: none;
      height: 100dvh;
      max-height: 100dvh;
      border-radius: 0;
      border: none;
    }

    .modal-header {
      padding: 1rem 1rem 0.25rem;
    }

    .modal-body {
      padding: 0.5rem 1rem 1rem;
    }
  }
</style>
