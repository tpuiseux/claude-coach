<script lang="ts">
  import { untrack } from "svelte";
  import { base } from "$app/paths";
  import type { Workout, TrainingDay, Sport, WorkoutType } from "../../schema/training-plan.js";
  import type { Settings } from "../settings.js";
  import {
    formatActivitySummary,
    formatDuration,
    formatDistance,
    formatDate,
    getZoneInfo,
  } from "../utils.js";
  import {
    FEELINGS,
    FEELING_LABELS,
    type Feeling,
    type RecordedActivity,
    type WorkoutFeedback,
  } from "../trainingLog.js";
  import { isGarminConnectSupported } from "../garminSports.js";
  import {
    exportWorkout,
    getAvailableFormats,
    isZwoSupported,
    isFitSupported,
    isErgSupported,
    type ExportFormat,
  } from "../export/index.js";

  type Mode = "view" | "edit" | "create";

  interface Props {
    workout: Workout | null; // null for create mode
    day: TrainingDay;
    settings: Settings;
    planId: string;
    mode?: Mode;
    onClose: () => void;
    onToggleComplete: (workoutId: string) => void;
    onSave: (updates: Partial<Workout>) => void;
    onDelete: (workoutId: string) => void;
    // Tap-friendly alternative to dragging a card onto another day, which
    // doesn't work on touch screens. Bounds limit the date picker to the plan.
    onMove: (workoutId: string, newDate: string) => void;
    planDateRange: { min: string; max: string };
    feedback?: WorkoutFeedback;
    /** Garmin activities matched to this workout (see matchDay). */
    recordedActivities: RecordedActivity[];
    /** Rejects with a user-facing message on failure. */
    onSaveFeedback: (workoutId: string, feedback: FeedbackDraft) => Promise<void>;
    onDeleteFeedback: (workoutId: string) => Promise<void>;
  }

  interface FeedbackDraft {
    rpe: number | null;
    feeling: Feeling | null;
    pain: boolean;
    painNotes: string | null;
    notes: string | null;
  }

  let {
    workout,
    day,
    settings,
    planId,
    mode = "view",
    onClose,
    onToggleComplete,
    onSave,
    onDelete,
    onMove,
    planDateRange,
    feedback,
    recordedActivities,
    onSaveFeedback,
    onDeleteFeedback,
  }: Props = $props();

  // How-did-it-go form (view mode). Starts closed; opened empty or prefilled.
  let editingFeedback = $state(false);
  let fbRpe = $state<number | null>(null);
  let fbFeeling = $state<Feeling | null>(null);
  let fbPain = $state(false);
  let fbPainNotes = $state("");
  let fbNotes = $state("");
  let fbSaving = $state(false);
  let fbError = $state<string | null>(null);

  function startFeedbackEdit() {
    fbRpe = feedback?.rpe ?? null;
    fbFeeling = feedback?.feeling ?? null;
    fbPain = feedback?.pain ?? false;
    fbPainNotes = feedback?.painNotes ?? "";
    fbNotes = feedback?.notes ?? "";
    fbError = null;
    editingFeedback = true;
  }

  const feedbackIsEmpty = $derived(
    fbRpe === null && fbFeeling === null && !fbPain && !fbNotes.trim()
  );

  async function saveFeedback() {
    if (!workout || fbSaving) return;
    fbSaving = true;
    fbError = null;
    try {
      await onSaveFeedback(workout.id, {
        rpe: fbRpe,
        feeling: fbFeeling,
        pain: fbPain,
        painNotes: fbPain ? fbPainNotes.trim() || null : null,
        notes: fbNotes.trim() || null,
      });
      editingFeedback = false;
    } catch (err) {
      fbError = err instanceof Error ? err.message : "Couldn't save.";
    } finally {
      fbSaving = false;
    }
  }

  async function removeFeedback() {
    if (!workout || fbSaving) return;
    fbSaving = true;
    fbError = null;
    try {
      await onDeleteFeedback(workout.id);
      editingFeedback = false;
    } catch (err) {
      fbError = err instanceof Error ? err.message : "Couldn't remove.";
    } finally {
      fbSaving = false;
    }
  }

  // Use untrack to explicitly capture initial values (these are intentional local copies)
  let currentMode = $state<Mode>(untrack(() => mode));
  let showDeleteConfirm = $state(false);
  let showMovePanel = $state(false);
  let moveDate = $state(untrack(() => day.date));
  let showExportMenu = $state(false);
  let exportStatus = $state<{ message: string; isError: boolean } | null>(null);

  // Editable fields - intentionally capture initial values only
  let editSport = $state<Sport>(untrack(() => workout?.sport || "run"));
  let editType = $state<WorkoutType>(untrack(() => workout?.type || "endurance"));
  let editName = $state(untrack(() => workout?.name || ""));
  let editDescription = $state(untrack(() => workout?.description || ""));
  let editDuration = $state(untrack(() => workout?.durationMinutes?.toString() || ""));
  let editDistance = $state(untrack(() => workout?.distanceMeters?.toString() || ""));
  let editZone = $state(untrack(() => workout?.primaryZone || ""));
  let editStructure = $state(untrack(() => workout?.humanReadable || ""));

  const sports: Sport[] = ["swim", "bike", "run", "strength", "brick", "race", "rest"];
  const workoutTypes: WorkoutType[] = [
    "rest",
    "recovery",
    "endurance",
    "tempo",
    "threshold",
    "intervals",
    "vo2max",
    "sprint",
    "race",
    "brick",
    "technique",
    "openwater",
    "hills",
    "long",
  ];

  function handleKeydown(e: KeyboardEvent) {
    if (e.key === "Escape") {
      if (showDeleteConfirm) {
        showDeleteConfirm = false;
      } else if (currentMode !== "view") {
        if (!workout) {
          onClose();
        } else {
          currentMode = "view";
        }
      } else {
        onClose();
      }
    }
  }

  function handleBackdropClick(e: MouseEvent) {
    if ((e.target as HTMLElement).classList.contains("modal-overlay")) {
      onClose();
    }
  }

  function startEdit() {
    editSport = workout?.sport || "run";
    editType = workout?.type || "endurance";
    editName = workout?.name || "";
    editDescription = workout?.description || "";
    editDuration = workout?.durationMinutes?.toString() || "";
    editDistance = workout?.distanceMeters?.toString() || "";
    editZone = workout?.primaryZone || "";
    editStructure = workout?.humanReadable || "";
    currentMode = "edit";
  }

  function cancelEdit() {
    if (mode === "create") {
      onClose();
    } else {
      currentMode = "view";
    }
  }

  function handleSave() {
    const updates: Partial<Workout> = {
      sport: editSport,
      type: editType,
      name: editName,
      description: editDescription,
      durationMinutes: editDuration ? parseInt(editDuration) : undefined,
      distanceMeters: editDistance ? parseInt(editDistance) : undefined,
      primaryZone: editZone || undefined,
      humanReadable: editStructure || undefined,
    };
    onSave(updates);
    if (mode !== "create") {
      currentMode = "view";
    }
  }

  function handleDelete() {
    if (workout) {
      onDelete(workout.id);
    }
  }

  async function handleExport(format: ExportFormat) {
    if (!workout) return;
    showExportMenu = false;
    exportStatus = { message: "Exporting...", isError: false };

    const result = await exportWorkout(workout, format, settings);

    if (result.success) {
      exportStatus = { message: `Downloaded ${result.filename}`, isError: false };
    } else {
      exportStatus = { message: result.error || "Export failed", isError: true };
    }

    setTimeout(() => {
      exportStatus = null;
    }, 3000);
  }

  const availableFormats = $derived(workout ? getAvailableFormats(workout.sport) : []);
  const canExport = $derived(availableFormats.length > 0);

  let garminSending = $state(false);

  async function handleSendToGarmin() {
    if (!workout || garminSending) return;
    garminSending = true;
    exportStatus = { message: "Sending to Garmin...", isError: false };

    try {
      const res = await fetch(`${base}/plans/${planId}/workouts/${workout.id}/garmin`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: day.date }),
      });
      const data = await res.json().catch(() => null);
      if (!res.ok) throw new Error(data?.message ?? `Envoi echoue (${res.status})`);
      exportStatus = { message: "Sent to Garmin Connect.", isError: false };
    } catch (err) {
      exportStatus = {
        message: err instanceof Error ? err.message : "Envoi Garmin echoue.",
        isError: true,
      };
    } finally {
      garminSending = false;
      setTimeout(() => {
        exportStatus = null;
      }, 4000);
    }
  }

  // Derive displayed workout (for view mode)
  const displayWorkout = $derived(
    workout ||
      ({
        id: "",
        sport: editSport,
        type: editType,
        name: editName,
        description: editDescription,
        durationMinutes: editDuration ? parseInt(editDuration) : undefined,
        distanceMeters: editDistance ? parseInt(editDistance) : undefined,
        primaryZone: editZone,
        humanReadable: editStructure,
        completed: false,
      } as Workout)
  );
</script>

<svelte:window on:keydown={handleKeydown} />

<div
  class="modal-overlay active"
  onclick={handleBackdropClick}
  onkeydown={handleKeydown}
  role="dialog"
  aria-modal="true"
  tabindex="-1"
>
  <div class="modal">
    <div class="modal-header">
      {#if currentMode === "view"}
        <div>
          <div class="modal-sport-badge {displayWorkout.sport}">
            {displayWorkout.sport.toUpperCase()}
          </div>
          <h2 class="modal-title">{displayWorkout.name}</h2>
          <div class="modal-date">{formatDate(day.date)}</div>
        </div>
      {:else}
        <div>
          <h2 class="modal-title">{currentMode === "create" ? "New Workout" : "Edit Workout"}</h2>
          <div class="modal-date">{formatDate(day.date)}</div>
        </div>
      {/if}
      <button class="modal-close" onclick={onClose}>×</button>
    </div>

    <div class="modal-body">
      {#if currentMode === "view"}
        <div class="modal-stats">
          {#if displayWorkout.durationMinutes}
            <div class="modal-stat">
              <div class="modal-stat-value">{formatDuration(displayWorkout.durationMinutes)}</div>
              <div class="modal-stat-label">Duration</div>
            </div>
          {/if}
          {#if displayWorkout.distanceMeters}
            <div class="modal-stat">
              <div class="modal-stat-value">
                {formatDistance(displayWorkout.distanceMeters, displayWorkout.sport, settings)}
              </div>
              <div class="modal-stat-label">Distance</div>
            </div>
          {/if}
          {#if displayWorkout.primaryZone}
            <div class="modal-stat zone">
              <div class="modal-stat-value">
                {getZoneInfo(displayWorkout.sport, displayWorkout.primaryZone, settings)}
              </div>
              <div class="modal-stat-label">Target Zone</div>
            </div>
          {/if}
        </div>

        {#if displayWorkout.description}
          <div class="modal-section">
            <h4 class="modal-section-title">Description</h4>
            <p class="modal-description">{displayWorkout.description}</p>
          </div>
        {/if}

        {#if displayWorkout.humanReadable}
          <div class="modal-section">
            <h4 class="modal-section-title">Workout Structure</h4>
            <pre class="workout-structure">{displayWorkout.humanReadable.replace(
                /\\n/g,
                "\n"
              )}</pre>
          </div>
        {/if}

        {#if recordedActivities.length > 0}
          <div class="modal-section">
            <h4 class="modal-section-title">Recorded on Garmin</h4>
            {#each recordedActivities as activity (activity.id)}
              <div class="recorded-row">
                <span class="recorded-row-name">{activity.name ?? activity.sportType}</span>
                <span class="recorded-row-summary">{formatActivitySummary(activity, settings)}</span
                >
              </div>
            {/each}
          </div>
        {/if}

        {#if workout}
          <div class="modal-section feedback-section">
            <h4 class="modal-section-title">How did it go?</h4>

            {#if editingFeedback}
              <div class="fb-field">
                <span class="fb-label">Effort (RPE)</span>
                <div class="rpe-scale" role="radiogroup" aria-label="Perceived effort, 1 to 10">
                  {#each [1, 2, 3, 4, 5, 6, 7, 8, 9, 10] as value (value)}
                    <button
                      type="button"
                      class="rpe-btn"
                      class:selected={fbRpe === value}
                      role="radio"
                      aria-checked={fbRpe === value}
                      onclick={() => (fbRpe = fbRpe === value ? null : value)}>{value}</button
                    >
                  {/each}
                </div>
                <div class="rpe-hint"><span>Very easy</span><span>All-out</span></div>
              </div>

              <div class="fb-field">
                <span class="fb-label">How did you feel?</span>
                <div class="feeling-chips">
                  {#each FEELINGS as value (value)}
                    <button
                      type="button"
                      class="feeling-chip"
                      class:selected={fbFeeling === value}
                      aria-pressed={fbFeeling === value}
                      onclick={() => (fbFeeling = fbFeeling === value ? null : value)}
                    >
                      {FEELING_LABELS[value]}
                    </button>
                  {/each}
                </div>
              </div>

              <label class="fb-pain">
                <input type="checkbox" bind:checked={fbPain} />
                Pain or niggle
              </label>
              {#if fbPain}
                <input
                  type="text"
                  class="form-input"
                  maxlength="500"
                  placeholder="Where, and how bad? e.g. left calf, mild"
                  bind:value={fbPainNotes}
                />
              {/if}

              <textarea
                class="form-textarea"
                rows="3"
                maxlength="2000"
                placeholder="Notes - sleep, weather, legs, anything worth knowing"
                bind:value={fbNotes}
              ></textarea>

              {#if fbError}
                <p class="fb-error">{fbError}</p>
              {/if}

              <div class="fb-actions">
                {#if feedback}
                  <button class="fb-remove" onclick={removeFeedback} disabled={fbSaving}>
                    Remove
                  </button>
                {/if}
                <button class="cancel-btn" onclick={() => (editingFeedback = false)}>Cancel</button>
                <button
                  class="save-btn"
                  onclick={saveFeedback}
                  disabled={fbSaving || feedbackIsEmpty}
                >
                  {fbSaving ? "Saving…" : "Save"}
                </button>
              </div>
              {#if !displayWorkout.completed}
                <p class="fb-hint">Saving also marks this workout as done.</p>
              {/if}
            {:else if feedback}
              <div class="fb-summary">
                {#if feedback.rpe}
                  <span class="fb-pill">RPE {feedback.rpe}/10</span>
                {/if}
                {#if feedback.feeling}
                  <span class="fb-pill">{FEELING_LABELS[feedback.feeling]}</span>
                {/if}
                {#if feedback.pain}
                  <span class="fb-pill pain"
                    >Pain{feedback.painNotes ? `: ${feedback.painNotes}` : ""}</span
                  >
                {/if}
              </div>
              {#if feedback.notes}
                <p class="modal-description fb-notes">{feedback.notes}</p>
              {/if}
              <button class="fb-edit" onclick={startFeedbackEdit}>Edit</button>
            {:else}
              <button class="fb-start" onclick={startFeedbackEdit}>+ Log how it went</button>
            {/if}
          </div>
        {/if}
      {:else}
        <div class="form-grid">
          <div class="form-row">
            <label class="form-label" for="edit-sport">Sport</label>
            <select id="edit-sport" class="form-select" bind:value={editSport}>
              {#each sports as s (s)}
                <option value={s}>{s.charAt(0).toUpperCase() + s.slice(1)}</option>
              {/each}
            </select>
          </div>

          <div class="form-row">
            <label class="form-label" for="edit-type">Type</label>
            <select id="edit-type" class="form-select" bind:value={editType}>
              {#each workoutTypes as t (t)}
                <option value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>
              {/each}
            </select>
          </div>
        </div>

        <div class="form-row full">
          <label class="form-label" for="edit-name">Name</label>
          <input
            id="edit-name"
            type="text"
            class="form-input"
            bind:value={editName}
            placeholder="Easy Run"
          />
        </div>

        <div class="form-row full">
          <label class="form-label" for="edit-description">Description</label>
          <textarea
            id="edit-description"
            class="form-textarea"
            bind:value={editDescription}
            placeholder="Conversational pace, focus on form"
            rows="2"
          ></textarea>
        </div>

        <div class="form-grid">
          <div class="form-row">
            <label class="form-label" for="edit-duration">Duration (minutes)</label>
            <input
              id="edit-duration"
              type="number"
              class="form-input"
              bind:value={editDuration}
              placeholder="60"
            />
          </div>

          <div class="form-row">
            <label class="form-label" for="edit-distance">Distance (meters)</label>
            <input
              id="edit-distance"
              type="number"
              class="form-input"
              bind:value={editDistance}
              placeholder="10000"
            />
          </div>
        </div>

        <div class="form-row full">
          <label class="form-label" for="edit-zone">Target Zone</label>
          <input
            id="edit-zone"
            type="text"
            class="form-input"
            bind:value={editZone}
            placeholder="Zone 2"
          />
        </div>

        <div class="form-row full">
          <label class="form-label" for="edit-structure">Workout Structure</label>
          <textarea
            id="edit-structure"
            class="form-textarea mono"
            bind:value={editStructure}
            placeholder="Warm-up: 10min easy&#10;Main: 4x1km @ threshold&#10;Cool-down: 10min easy"
            rows="5"
          ></textarea>
        </div>
      {/if}
    </div>

    {#if currentMode === "view" && showMovePanel}
      <div class="move-panel">
        <label class="form-label" for="move-date">Move to</label>
        <input
          id="move-date"
          type="date"
          class="form-input"
          min={planDateRange.min}
          max={planDateRange.max}
          bind:value={moveDate}
        />
        <button
          class="save-btn"
          disabled={!moveDate || moveDate === day.date}
          onclick={() => onMove(displayWorkout.id, moveDate)}
        >
          Move
        </button>
      </div>
    {/if}

    <div class="modal-footer">
      {#if currentMode === "view"}
        <div class="footer-left">
          <button class="icon-btn edit" onclick={startEdit} title="Edit">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7" />
              <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z" />
            </svg>
          </button>
          <button
            class="icon-btn move"
            class:active={showMovePanel}
            onclick={() => (showMovePanel = !showMovePanel)}
            title="Move to another day"
          >
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <rect x="3" y="4" width="18" height="18" rx="2" />
              <path d="M16 2v4M8 2v4M3 10h18M10 16h6M13 13l3 3-3 3" />
            </svg>
          </button>
          <button class="icon-btn delete" onclick={() => (showDeleteConfirm = true)} title="Delete">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path
                d="M3 6h18M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"
              />
            </svg>
          </button>
          {#if workout && isGarminConnectSupported(displayWorkout.sport)}
            <button
              class="icon-btn garmin"
              onclick={handleSendToGarmin}
              disabled={garminSending}
              title="Send to Garmin"
            >
              <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                <path d="M12 2v20M2 12h20" />
                <circle cx="12" cy="12" r="9" />
              </svg>
            </button>
          {/if}
          {#if canExport}
            <div class="export-dropdown">
              <button
                class="icon-btn export"
                onclick={() => (showExportMenu = !showExportMenu)}
                title="Export"
              >
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                  <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" />
                  <polyline points="7 10 12 15 17 10" />
                  <line x1="12" y1="15" x2="12" y2="3" />
                </svg>
              </button>
              {#if showExportMenu}
                <div class="export-menu">
                  {#if isZwoSupported(displayWorkout.sport)}
                    <button class="export-option" onclick={() => handleExport("zwo")}>
                      <span class="export-icon">Z</span>
                      <div class="export-info">
                        <div class="export-name">Zwift (.zwo)</div>
                        <div class="export-desc">For Zwift indoor training</div>
                      </div>
                    </button>
                  {/if}
                  {#if isFitSupported(displayWorkout.sport)}
                    <button class="export-option" onclick={() => handleExport("fit")}>
                      <span class="export-icon">G</span>
                      <div class="export-info">
                        <div class="export-name">Garmin (.fit)</div>
                        <div class="export-desc">For Garmin Connect</div>
                      </div>
                    </button>
                  {/if}
                  {#if isErgSupported(displayWorkout.sport)}
                    <button class="export-option" onclick={() => handleExport("mrc")}>
                      <span class="export-icon">E</span>
                      <div class="export-info">
                        <div class="export-name">ERG/MRC (.mrc)</div>
                        <div class="export-desc">For TrainerRoad, etc.</div>
                      </div>
                    </button>
                  {/if}
                </div>
              {/if}
            </div>
          {/if}
        </div>
        <div class="footer-right">
          {#if exportStatus}
            <div class="export-status" class:error={exportStatus.isError}>
              {exportStatus.message}
            </div>
          {/if}
          <button
            class="complete-btn"
            class:mark={!displayWorkout.completed}
            class:unmark={displayWorkout.completed}
            onclick={() => onToggleComplete(displayWorkout.id)}
          >
            {#if displayWorkout.completed}
              <span>↩</span> Mark Incomplete
            {:else}
              <span>✓</span> Mark Complete
            {/if}
          </button>
        </div>
      {:else}
        <button class="cancel-btn" onclick={cancelEdit}>Cancel</button>
        <button class="save-btn" onclick={handleSave} disabled={!editName}>
          {currentMode === "create" ? "Add Workout" : "Save Changes"}
        </button>
      {/if}
    </div>

    {#if showDeleteConfirm}
      <div class="confirm-overlay">
        <div class="confirm-dialog">
          <p>Delete this workout?</p>
          <div class="confirm-actions">
            <button class="cancel-btn" onclick={() => (showDeleteConfirm = false)}>Cancel</button>
            <button class="delete-btn" onclick={handleDelete}>Delete</button>
          </div>
        </div>
      </div>
    {/if}
  </div>
</div>

<style>
  .modal-overlay {
    position: fixed;
    inset: 0;
    background: rgba(0, 0, 0, 0.8);
    backdrop-filter: blur(8px);
    z-index: 1000;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    opacity: 0;
    visibility: hidden;
    transition: all var(--transition-normal);
  }

  .modal-overlay.active {
    opacity: 1;
    visibility: visible;
  }

  .modal {
    background: var(--bg-secondary);
    border-radius: 20px;
    max-width: 600px;
    width: 100%;
    max-height: 85vh;
    overflow: hidden;
    transform: scale(0.9) translateY(20px);
    transition: transform var(--transition-normal);
    border: 1px solid var(--border-medium);
    position: relative;
    display: flex;
    flex-direction: column;
  }

  .modal-overlay.active .modal {
    transform: scale(1) translateY(0);
  }

  .modal-header {
    padding: 1.5rem 2rem;
    border-bottom: 1px solid var(--border-subtle);
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    flex-shrink: 0;
  }

  .modal-sport-badge {
    display: inline-flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.4rem 0.8rem;
    border-radius: 20px;
    font-size: 0.75rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-bottom: 0.5rem;
  }

  .modal-sport-badge.swim {
    background: var(--swim-glow);
    color: var(--swim);
  }
  .modal-sport-badge.bike {
    background: var(--bike-glow);
    color: var(--bike);
  }
  .modal-sport-badge.run {
    background: var(--run-glow);
    color: var(--run);
  }
  .modal-sport-badge.strength {
    background: var(--strength-glow);
    color: var(--strength);
  }
  .modal-sport-badge.brick {
    background: var(--brick-glow);
    color: var(--brick);
  }
  .modal-sport-badge.race {
    background: var(--race-glow);
    color: var(--race);
  }
  .modal-sport-badge.rest {
    background: var(--rest-glow);
    color: var(--rest);
  }

  .modal-title {
    font-size: 1.4rem;
    font-weight: 600;
    color: var(--text-primary);
  }

  .modal-date {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.85rem;
    color: var(--text-muted);
    margin-top: 0.25rem;
  }

  .modal-close {
    width: 36px;
    height: 36px;
    border-radius: 50%;
    border: 1px solid var(--border-medium);
    background: transparent;
    color: var(--text-muted);
    font-size: 1.2rem;
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all var(--transition-fast);
    flex-shrink: 0;
  }

  .modal-close:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .modal-body {
    padding: 1.5rem 2rem;
    overflow-y: auto;
    flex: 1;
  }

  .modal-stats {
    display: flex;
    flex-wrap: wrap;
    gap: 1rem 1.5rem;
    margin-bottom: 1.5rem;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .modal-stat {
    text-align: center;
  }

  .modal-stat-value {
    font-family: "JetBrains Mono", monospace;
    font-size: 1.5rem;
    font-weight: 500;
    color: var(--text-primary);
  }

  /* Zones are often a phrase ("Zone 3 (RP), short touches (158-164 bpm)"),
   * not a number: give it its own line at reading size. */
  .modal-stat.zone {
    flex: 1 1 100%;
  }

  .modal-stat.zone .modal-stat-value {
    font-size: 1rem;
    line-height: 1.4;
  }

  .modal-stat-label {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  .modal-section {
    margin-bottom: 1.5rem;
  }

  .modal-section-title {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.1em;
    color: var(--text-muted);
    margin-bottom: 0.75rem;
  }

  .modal-description {
    font-size: 0.95rem;
    color: var(--text-secondary);
    line-height: 1.7;
  }

  .workout-structure {
    background: var(--bg-tertiary);
    border-radius: 12px;
    padding: 1rem;
    font-family: "JetBrains Mono", monospace;
    font-size: 0.85rem;
    line-height: 1.8;
    color: var(--text-secondary);
    white-space: pre-wrap;
    margin: 0;
  }

  .form-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
    margin-bottom: 1rem;
  }

  .form-row {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
  }

  .form-row.full {
    margin-bottom: 1rem;
  }

  .form-label {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  .form-input,
  .form-select,
  .form-textarea {
    background: var(--bg-tertiary);
    border: 1px solid var(--border-medium);
    border-radius: 8px;
    padding: 0.75rem 1rem;
    color: var(--text-primary);
    font-size: 0.9rem;
    transition: border-color var(--transition-fast);
  }

  .form-input:focus,
  .form-select:focus,
  .form-textarea:focus {
    outline: none;
    border-color: var(--accent);
  }

  .form-textarea {
    resize: vertical;
    min-height: 60px;
  }

  .form-textarea.mono {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.85rem;
    line-height: 1.6;
  }

  .modal-footer {
    padding: 1rem 2rem;
    border-top: 1px solid var(--border-subtle);
    display: flex;
    justify-content: space-between;
    align-items: center;
    flex-shrink: 0;
  }

  .footer-left {
    display: flex;
    gap: 0.5rem;
  }

  .icon-btn {
    width: 40px;
    height: 40px;
    border-radius: 10px;
    border: 1px solid var(--border-medium);
    background: transparent;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all var(--transition-fast);
  }

  .icon-btn svg {
    width: 18px;
    height: 18px;
  }

  .icon-btn:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .icon-btn.delete:hover {
    background: rgba(239, 68, 68, 0.1);
    border-color: #ef4444;
    color: #ef4444;
  }

  .icon-btn.edit:hover {
    background: var(--bg-elevated);
    border-color: var(--border-medium);
    color: var(--text-primary);
  }

  .icon-btn.garmin:hover:not(:disabled) {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--bg-primary);
  }

  .icon-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .complete-btn {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    padding: 0.75rem 1.5rem;
    border-radius: 10px;
    font-size: 0.9rem;
    font-weight: 500;
    transition: all var(--transition-fast);
    border: none;
  }

  .complete-btn.mark {
    background: var(--accent);
    color: var(--bg-primary);
  }

  .complete-btn.mark:hover {
    background: #fbbf24;
    transform: translateY(-2px);
  }

  .complete-btn.unmark {
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    border: 1px solid var(--border-medium);
  }

  .complete-btn.unmark:hover {
    background: var(--bg-elevated);
  }

  .cancel-btn {
    padding: 0.75rem 1.5rem;
    border-radius: 10px;
    font-size: 0.9rem;
    font-weight: 500;
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    border: 1px solid var(--border-medium);
    transition: all var(--transition-fast);
  }

  .cancel-btn:hover {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }

  .save-btn {
    padding: 0.75rem 1.5rem;
    border-radius: 10px;
    font-size: 0.9rem;
    font-weight: 500;
    background: var(--accent);
    color: var(--bg-primary);
    border: none;
    transition: all var(--transition-fast);
  }

  .save-btn:hover:not(:disabled) {
    background: #fbbf24;
    transform: translateY(-2px);
  }

  .save-btn:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .confirm-overlay {
    position: absolute;
    inset: 0;
    background: rgba(0, 0, 0, 0.7);
    display: flex;
    align-items: center;
    justify-content: center;
    border-radius: 20px;
  }

  .confirm-dialog {
    background: var(--bg-secondary);
    border: 1px solid var(--border-medium);
    border-radius: 12px;
    padding: 1.5rem;
    text-align: center;
  }

  .confirm-dialog p {
    font-size: 1rem;
    color: var(--text-primary);
    margin-bottom: 1rem;
  }

  .confirm-actions {
    display: flex;
    gap: 0.75rem;
    justify-content: center;
  }

  .delete-btn {
    padding: 0.75rem 1.5rem;
    border-radius: 10px;
    font-size: 0.9rem;
    font-weight: 500;
    background: #ef4444;
    color: white;
    border: none;
    transition: all var(--transition-fast);
  }

  .delete-btn:hover {
    background: #dc2626;
  }

  .footer-right {
    display: flex;
    align-items: center;
    gap: 0.75rem;
  }

  .recorded-row {
    display: flex;
    flex-wrap: wrap;
    justify-content: space-between;
    gap: 0.25rem 1rem;
    padding: 0.5rem 0;
    border-bottom: 1px solid var(--border-subtle);
    font-size: 0.9rem;
  }

  .recorded-row:last-child {
    border-bottom: none;
  }

  .recorded-row-summary {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.8rem;
    color: var(--text-muted);
  }

  .feedback-section {
    display: flex;
    flex-direction: column;
    gap: 0.9rem;
  }

  .feedback-section .modal-section-title {
    margin-bottom: 0;
  }

  .fb-field {
    display: flex;
    flex-direction: column;
    gap: 0.45rem;
  }

  .fb-label {
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .rpe-scale {
    display: grid;
    grid-template-columns: repeat(10, 1fr);
    gap: 4px;
  }

  .rpe-btn {
    min-height: 40px;
    padding: 0;
    border-radius: 8px;
    border: 1px solid var(--border-medium);
    background: var(--bg-tertiary);
    color: var(--text-secondary);
    font-family: "JetBrains Mono", monospace;
    font-size: 0.9rem;
  }

  .rpe-btn.selected {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--bg-primary);
    font-weight: 700;
  }

  .rpe-hint {
    display: flex;
    justify-content: space-between;
    font-size: 0.7rem;
    color: var(--text-muted);
  }

  .feeling-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .feeling-chip {
    padding: 0.5rem 0.9rem;
    border-radius: 999px;
    border: 1px solid var(--border-medium);
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.85rem;
  }

  .feeling-chip.selected {
    border-color: var(--accent);
    background: var(--accent-glow);
    color: var(--text-primary);
    font-weight: 600;
  }

  .fb-pain {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.9rem;
    color: var(--text-primary);
  }

  .fb-pain input {
    width: 18px;
    height: 18px;
    accent-color: var(--accent);
  }

  .fb-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.6rem;
  }

  .fb-remove {
    margin-right: auto;
    padding: 0.75rem 0.5rem;
    border: none;
    background: transparent;
    color: #f87171;
    font-size: 0.85rem;
  }

  .fb-error {
    font-size: 0.85rem;
    color: #f87171;
  }

  .fb-hint {
    font-size: 0.75rem;
    color: var(--text-muted);
    text-align: right;
  }

  .fb-summary {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .fb-pill {
    padding: 0.3rem 0.7rem;
    border-radius: 999px;
    background: var(--bg-tertiary);
    font-size: 0.85rem;
    color: var(--text-primary);
  }

  .fb-pill.pain {
    background: rgba(239, 68, 68, 0.12);
    color: #f87171;
  }

  .fb-notes {
    margin: 0;
    white-space: pre-wrap;
  }

  .fb-start,
  .fb-edit {
    align-self: flex-start;
    padding: 0.6rem 1rem;
    border-radius: 10px;
    border: 1px dashed var(--border-medium);
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.9rem;
  }

  .fb-edit {
    border-style: solid;
  }

  .move-panel {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 1rem 2rem;
    border-top: 1px solid var(--border-subtle);
    flex-shrink: 0;
  }

  .move-panel .form-input {
    flex: 1;
    min-width: 0;
    color-scheme: dark;
  }

  :global([data-theme="light"]) .move-panel .form-input {
    color-scheme: light;
  }

  .icon-btn.move.active,
  .icon-btn.move:hover {
    background: var(--bg-elevated);
    color: var(--text-primary);
  }

  /* Phone: full-screen sheet, roomier touch targets, footer wraps. */
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

    .modal-header,
    .modal-body {
      padding: 1rem 1.25rem;
    }

    .modal-close {
      width: 44px;
      height: 44px;
      flex-shrink: 0;
    }

    .modal-footer {
      flex-wrap: wrap;
      gap: 0.75rem;
      padding: 0.75rem 1.25rem;
    }

    .footer-left {
      flex-wrap: wrap;
    }

    .footer-right {
      flex: 1 1 100%;
      flex-wrap: wrap;
    }

    .complete-btn,
    .cancel-btn,
    .save-btn {
      flex: 1;
      justify-content: center;
    }

    .icon-btn {
      width: 44px;
      height: 44px;
    }

    .move-panel {
      flex-wrap: wrap;
      padding: 0.75rem 1.25rem;
    }

    .move-panel .form-label {
      flex-basis: 100%;
    }
  }

  .export-dropdown {
    position: relative;
  }

  .icon-btn.export:hover {
    background: var(--bg-elevated);
    border-color: var(--border-medium);
    color: var(--text-primary);
  }

  .export-menu {
    position: absolute;
    bottom: calc(100% + 8px);
    left: 0;
    background: var(--bg-secondary);
    border: 1px solid var(--border-medium);
    border-radius: 12px;
    padding: 0.5rem;
    min-width: 200px;
    z-index: 10;
    box-shadow: 0 4px 20px rgba(0, 0, 0, 0.3);
  }

  .export-option {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.75rem;
    border: none;
    background: transparent;
    color: var(--text-primary);
    border-radius: 8px;
    cursor: pointer;
    transition: background var(--transition-fast);
  }

  .export-option:hover {
    background: var(--bg-tertiary);
  }

  .export-icon {
    width: 32px;
    height: 32px;
    border-radius: 6px;
    background: var(--bg-tertiary);
    display: flex;
    align-items: center;
    justify-content: center;
    font-weight: 600;
    font-size: 0.85rem;
    color: var(--accent);
  }

  .export-info {
    text-align: left;
  }

  .export-name {
    font-size: 0.9rem;
    font-weight: 500;
  }

  .export-desc {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .export-status {
    font-size: 0.8rem;
    color: var(--accent);
    padding: 0.4rem 0.8rem;
    background: var(--accent-glow);
    border-radius: 6px;
  }

  .export-status.error {
    color: #ef4444;
    background: rgba(239, 68, 68, 0.1);
  }
</style>
