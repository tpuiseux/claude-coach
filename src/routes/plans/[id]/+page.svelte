<script lang="ts">
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
  import SettingsModal from "$lib/components/SettingsModal.svelte";

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
  />

  <main class="main-content">
    {#if errorMessage}
      <div class="error-banner">{errorMessage}</div>
    {/if}
    <WeeksContainer
      plan={data.plan}
      {filters}
      onWorkoutClick={handleWorkoutClick}
      onWorkoutMove={handleWorkoutMove}
      onAddWorkout={handleAddWorkout}
    />
  </main>
</div>

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
  />
{/if}

{#if settingsOpen}
  <SettingsModal
    {settings}
    onClose={() => (settingsOpen = false)}
    onChange={handleSettingsChange}
    onExportPlan={handleExportPlan}
  />
{/if}

<style>
  .main-content {
    flex: 1;
    margin-left: var(--sidebar-width);
    padding: 2rem;
    max-width: 1400px;
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
