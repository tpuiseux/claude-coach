<script lang="ts">
  import { onMount } from "svelte";
  import { invalidateAll } from "$app/navigation";
  import { page } from "$app/state";
  import { base } from "$app/paths";
  import type { PageData } from "./$types";
  import type { TrainingDay, Workout } from "../../../schema/training-plan.js";
  import {
    deriveSettingsFromPlan,
    buildZonesFromSettings,
    buildPreferencesFromSettings,
    type Settings,
  } from "$lib/settings.js";
  import Sidebar from "$lib/components/Sidebar.svelte";
  import WeeksContainer from "$lib/components/WeeksContainer.svelte";
  import WorkoutModal from "$lib/components/WorkoutModal.svelte";
  import ActivityModal from "$lib/components/ActivityModal.svelte";
  import SettingsModal from "$lib/components/SettingsModal.svelte";
  import { runSync } from "$lib/garminSyncClient.js";
  import { matchDay, type RecordedActivity } from "$lib/trainingLog.js";

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  // Theme isn't part of the plan schema, so it's not persisted server-side
  // yet (unlike units/zones below) - it just applies for this session.
  let theme = $state<"dark" | "light">("dark");
  const settings = $derived({ ...deriveSettingsFromPlan(data.plan), theme });
  $effect(() => {
    document.documentElement.setAttribute("data-theme", theme);
  });

  let filters = $state({ sport: "all", status: "all" });
  let errorMessage = $state<string | null>(null);
  let settingsOpen = $state(false);

  type ModalState =
    | { mode: "view" | "edit"; workout: Workout; day: TrainingDay }
    | { mode: "create"; day: TrainingDay }
    | null;

  let modalState = $state<ModalState>(null);
  // An activity that matched nothing in the plan, opened for its details.
  let openActivity = $state<RecordedActivity | null>(null);

  // Pull new Garmin activities/recovery data when the plan is opened. The
  // server skips this if the last sync is under 6h old or Garmin isn't
  // connected; otherwise it runs in the background and the page refreshes
  // once it's done.
  let garminSyncing = $state(false);
  onMount(() => {
    runSync(false, () => (garminSyncing = true))
      .then((state) => (state ? invalidateAll() : undefined))
      .catch(() => {
        // Best-effort: Settings -> Garmin shows the sync state and any error.
      })
      .finally(() => (garminSyncing = false));
  });

  async function feedbackRequest(workoutId: string, init: RequestInit) {
    const res = await fetch(`${workoutsUrl(workoutId)}/feedback`, init);
    if (!res.ok) {
      const body = await res.json().catch(() => null);
      throw new Error(body?.message ?? `Request failed (${res.status})`);
    }
    await invalidateAll();
  }

  async function handleSaveFeedback(workoutId: string, feedback: unknown) {
    await feedbackRequest(workoutId, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(feedback),
    });
    // The server marked it completed; reflect that in the open modal too.
    if (modalState && modalState.mode !== "create" && modalState.workout.id === workoutId) {
      modalState = { ...modalState, workout: { ...modalState.workout, completed: true } };
    }
  }

  async function handleDeleteFeedback(workoutId: string) {
    await feedbackRequest(workoutId, { method: "DELETE" });
  }

  const planDateRange = $derived.by(() => {
    const dates = (data.plan.weeks ?? []).flatMap((w) => (w.days ?? []).map((d) => d.date)).sort();
    return { min: dates[0] ?? "", max: dates[dates.length - 1] ?? "" };
  });

  async function request(path: string, init: RequestInit) {
    errorMessage = null;
    try {
      const res = await fetch(path, init);
      if (!res.ok) {
        const body = await res.json().catch(() => null);
        throw new Error(body?.message ?? `Request failed (${res.status})`);
      }
      await invalidateAll();
      return await res.json();
    } catch (err) {
      errorMessage = err instanceof Error ? err.message : "Something went wrong.";
      throw err;
    }
  }

  function workoutsUrl(workoutId?: string) {
    const path = `${base}/plans/${page.params.id}/workouts`;
    return workoutId ? `${path}/${workoutId}` : path;
  }

  function handleWorkoutClick(workout: Workout, day: TrainingDay) {
    modalState = { mode: "view", workout, day };
  }

  function handleAddWorkout(day: TrainingDay) {
    modalState = { mode: "create", day };
  }

  function handleWorkoutMove(workoutId: string, newDate: string) {
    request(workoutsUrl(workoutId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "move", newDate }),
    });
  }

  async function handleMoveFromModal(workoutId: string, newDate: string) {
    try {
      await request(workoutsUrl(workoutId), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "move", newDate }),
      });
    } catch {
      // request() already put the message in the error banner
    } finally {
      // Close even on failure: on a phone the modal is full-screen and would
      // hide the error banner behind it.
      modalState = null;
    }
  }

  async function handleToggleComplete(workoutId: string) {
    await request(workoutsUrl(workoutId), {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "toggle-complete" }),
    });
    // Reflect the toggle immediately in the open modal instead of closing it.
    if (modalState && modalState.mode === "view" && modalState.workout.id === workoutId) {
      modalState = {
        ...modalState,
        workout: { ...modalState.workout, completed: !modalState.workout.completed },
      };
    }
  }

  async function handleSave(updates: Partial<Workout>) {
    if (!modalState) return;

    if (modalState.mode === "create") {
      await request(workoutsUrl(), {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ date: modalState.day.date, workout: updates }),
      });
    } else {
      await request(workoutsUrl(modalState.workout.id), {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action: "edit", updates }),
      });
    }
    modalState = null;
  }

  async function handleDelete(workoutId: string) {
    await request(workoutsUrl(workoutId), { method: "DELETE" });
    modalState = null;
  }

  async function handleSettingsChange(newSettings: Settings) {
    theme = newSettings.theme;
    await request(`${base}/plans/${page.params.id}/settings`, {
      method: "PATCH",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        preferences: buildPreferencesFromSettings(newSettings),
        zones: buildZonesFromSettings(newSettings),
      }),
    });
  }

  function handleExportPlan() {
    const blob = new Blob([JSON.stringify(data.plan, null, 2)], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = `${data.plan.meta.id}.json`;
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);
  }
</script>

<svelte:head>
  <title>{data.plan.meta.event} — Claude Coach</title>
</svelte:head>

<div class="app">
  <Sidebar
    plan={data.plan}
    {filters}
    onFilterChange={(f) => (filters = f)}
    onSettingsClick={() => (settingsOpen = true)}
    prediction={data.prediction}
    {settings}
  />

  <main class="main-content">
    {#if errorMessage}
      <div class="error-banner">{errorMessage}</div>
    {/if}
    <WeeksContainer
      plan={data.plan}
      activitiesByDate={data.activitiesByDate}
      feedback={data.feedback}
      {settings}
      {filters}
      onWorkoutClick={handleWorkoutClick}
      onWorkoutMove={handleWorkoutMove}
      onAddWorkout={handleAddWorkout}
      onActivityClick={(activity) => (openActivity = activity)}
    />
  </main>
</div>

{#if garminSyncing}
  <div class="sync-pill" role="status">Syncing Garmin…</div>
{/if}

{#if modalState}
  <WorkoutModal
    workout={modalState.mode === "create" ? null : modalState.workout}
    day={modalState.day}
    mode={modalState.mode}
    planId={page.params.id ?? ""}
    {settings}
    onClose={() => (modalState = null)}
    onToggleComplete={handleToggleComplete}
    onSave={handleSave}
    onDelete={handleDelete}
    onMove={handleMoveFromModal}
    {planDateRange}
    feedback={modalState.mode === "create" ? undefined : data.feedback[modalState.workout.id]}
    recordedActivities={modalState.mode === "create"
      ? []
      : (matchDay(modalState.day.workouts ?? [], data.activitiesByDate[modalState.day.date] ?? [])
          .byWorkout[modalState.workout.id] ?? [])}
    onSaveFeedback={handleSaveFeedback}
    onDeleteFeedback={handleDeleteFeedback}
  />
{/if}

{#if openActivity}
  <ActivityModal activity={openActivity} {settings} onClose={() => (openActivity = null)} />
{/if}

{#if settingsOpen}
  <SettingsModal
    {settings}
    onClose={() => (settingsOpen = false)}
    onChange={handleSettingsChange}
    onExportPlan={handleExportPlan}
    onGarminSynced={() => invalidateAll()}
  />
{/if}

<style>
  .main-content {
    flex: 1;
    margin-left: var(--sidebar-width);
    padding: 2rem;
    max-width: 1400px;
  }

  @media (max-width: 800px) {
    .app {
      display: block;
    }

    .main-content {
      margin-left: 0;
      padding: 1rem 0.75rem 2rem;
    }
  }

  .sync-pill {
    position: fixed;
    right: 1rem;
    bottom: 1rem;
    z-index: 40;
    padding: 0.45rem 0.85rem;
    border-radius: 999px;
    background: var(--bg-elevated);
    border: 1px solid var(--border-medium);
    color: var(--text-secondary);
    font-size: 0.8rem;
    pointer-events: none;
  }

  .error-banner {
    padding: 0.75rem 1rem;
    margin-bottom: 1rem;
    border-radius: 8px;
    background: #3a1414;
    color: #f87171;
    font-size: 0.85rem;
  }
</style>
