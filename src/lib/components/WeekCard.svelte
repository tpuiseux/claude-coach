<script lang="ts">
  import type { TrainingWeek, TrainingDay, Workout } from "../../schema/training-plan.js";
  import WorkoutCard from "./WorkoutCard.svelte";
  import { parseDate } from "../utils.js";

  interface Props {
    week: TrainingWeek;
    today: string;
    filterWorkout: (workout: Workout) => boolean;
    onWorkoutClick: (workout: Workout, day: TrainingDay) => void;
    onDrop: (workoutId: string, newDate: string) => void;
    onAddWorkout: (day: TrainingDay) => void;
    animationDelay: number;
  }

  let { week, today, filterWorkout, onWorkoutClick, onDrop, onAddWorkout, animationDelay }: Props =
    $props();

  let dragOverDate = $state<string | null>(null);

  const phaseName = $derived((week.phase ?? "base").toLowerCase());

  function handleDragOver(e: DragEvent, date: string) {
    e.preventDefault();
    dragOverDate = date;
  }

  function handleDragLeave() {
    dragOverDate = null;
  }

  function handleDrop(e: DragEvent, date: string) {
    e.preventDefault();
    dragOverDate = null;
    const workoutId = e.dataTransfer?.getData("text/plain");
    if (workoutId) {
      onDrop(workoutId, date);
    }
  }
</script>

<div class="week-card" style="animation-delay: {animationDelay}s">
  <div class="week-header">
    <div class="week-title">
      <span class="week-number">W{week.weekNumber}</span>
      <span class="week-phase {phaseName}">{week.phase ?? "Base"}</span>
      <span class="week-focus">{week.focus ?? ""}</span>
    </div>
    <div class="week-hours"><span>{week.targetHours ?? 0}</span> hrs</div>
  </div>

  <div class="days-grid">
    {#each week.days ?? [] as day (day.date)}
      {@const isToday = day.date === today}
      {@const filteredWorkouts = (day.workouts ?? []).filter(filterWorkout)}
      {@const isDragOver = dragOverDate === day.date}

      <div
        class="day-column"
        id={isToday ? "today-column" : undefined}
        class:today={isToday}
        class:drag-over={isDragOver}
        ondragover={(e) => handleDragOver(e, day.date)}
        ondragleave={handleDragLeave}
        ondrop={(e) => handleDrop(e, day.date)}
        role="listbox"
        tabindex="0"
      >
        <div class="day-header">
          <span class="day-name-group">
            <span class="day-name">{day.dayOfWeek.slice(0, 3)}</span>
            {#if isToday}
              <span class="today-badge">Today</span>
            {/if}
          </span>
          <span class="day-date">{parseDate(day.date).getDate()}</span>
        </div>

        <div class="day-content">
          {#if filteredWorkouts.length > 0}
            {#each filteredWorkouts as workout (workout.id)}
              <WorkoutCard
                {workout}
                isCompleted={!!workout.completed}
                onClick={() => onWorkoutClick(workout, day)}
              />
            {/each}
          {:else if (day.workouts ?? []).length === 0}
            <div class="empty-day">Rest</div>
          {/if}

          <button class="add-workout-btn" onclick={() => onAddWorkout(day)} title="Add workout">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M12 5v14M5 12h14" />
            </svg>
          </button>
        </div>
      </div>
    {/each}
  </div>
</div>

<style>
  .week-card {
    background: var(--bg-secondary);
    border-radius: 16px;
    border: 1px solid var(--border-subtle);
    overflow: hidden;
    opacity: 0;
    transform: translateY(20px);
    animation: slideUp 0.5s ease forwards;
  }

  @keyframes slideUp {
    to {
      opacity: 1;
      transform: translateY(0);
    }
  }

  .week-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    padding: 1rem 1.5rem;
    background: var(--bg-tertiary);
    border-bottom: 1px solid var(--border-subtle);
  }

  .week-title {
    display: flex;
    align-items: center;
    gap: 1rem;
  }

  .week-number {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.75rem;
    font-weight: 500;
    padding: 0.3rem 0.6rem;
    border-radius: 6px;
    background: var(--bg-primary);
    color: var(--text-secondary);
  }

  .week-phase {
    font-size: 0.8rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .week-phase.base {
    color: var(--phase-base);
  }
  .week-phase.build {
    color: var(--phase-build);
  }
  .week-phase.peak {
    color: var(--phase-peak);
  }
  .week-phase.taper {
    color: var(--phase-taper);
  }
  .week-phase.survival {
    color: var(--text-muted);
  }
  .week-phase.bank {
    color: var(--phase-base);
  }

  .week-focus {
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .week-hours {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.9rem;
    color: var(--text-secondary);
  }

  .week-hours span {
    color: var(--text-primary);
    font-weight: 500;
  }

  .days-grid {
    display: grid;
    grid-template-columns: repeat(7, 1fr);
    gap: 1px;
    background: var(--border-subtle);
  }

  .day-column {
    background: var(--bg-secondary);
    min-height: 160px;
    padding: 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    transition: background-color 0.15s ease;
  }

  .day-column.today {
    background: var(--bg-tertiary);
    /* When the page opens on today: keep the week's header in view on
     * desktop, and clear the sticky top bar on mobile. */
    scroll-margin-top: 4.5rem;
  }

  .day-column.today .day-name {
    color: var(--accent);
  }

  .day-column.today .day-date {
    color: var(--accent);
    font-weight: 700;
  }

  .day-name-group {
    display: flex;
    align-items: center;
    gap: 0.35rem;
  }

  .today-badge {
    font-size: 0.6rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--bg-primary);
    background: var(--accent);
    padding: 0.1rem 0.35rem;
    border-radius: 4px;
  }

  .day-column.drag-over {
    background: var(--accent-glow);
    outline: 2px dashed var(--accent);
    outline-offset: -2px;
  }

  .day-content {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    min-width: 0;
  }

  .day-header {
    display: flex;
    justify-content: space-between;
    align-items: baseline;
    margin-bottom: 0.5rem;
    padding-bottom: 0.5rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .day-name {
    font-size: 0.7rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  .day-date {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .empty-day {
    flex: 1;
    display: flex;
    align-items: center;
    justify-content: center;
    color: var(--text-muted);
    font-size: 0.8rem;
    font-style: italic;
  }

  .add-workout-btn {
    margin-top: auto;
    padding: 0.5rem;
    border: 1px dashed var(--border-medium);
    border-radius: 8px;
    background: transparent;
    color: var(--text-muted);
    display: flex;
    align-items: center;
    justify-content: center;
    transition: all var(--transition-fast);
    opacity: 0;
  }

  @media (hover: hover) {
    .day-column:hover .add-workout-btn {
      opacity: 1;
    }

    .add-workout-btn:hover {
      background: var(--bg-elevated);
      border-color: var(--border-medium);
      color: var(--text-primary);
    }
  }

  /* No hover on touch screens: the add button would be unreachable. */
  @media (hover: none) {
    .add-workout-btn {
      opacity: 1;
    }
  }

  .add-workout-btn svg {
    width: 16px;
    height: 16px;
  }

  @media (max-width: 1200px) {
    .days-grid {
      grid-template-columns: repeat(4, 1fr);
    }
  }

  @media (max-width: 900px) {
    .days-grid {
      grid-template-columns: repeat(2, 1fr);
    }
  }

  @media (max-width: 700px) {
    .days-grid {
      grid-template-columns: 1fr;
    }
  }

  /* Phone: one day per row, compact. Day label on the left, workouts on the
   * right, so a whole week fits on a screen or two instead of seven tall
   * cards. */
  @media (max-width: 800px) {
    .week-card {
      border-radius: 12px;
    }

    .week-header {
      flex-wrap: wrap;
      gap: 0.25rem 0.75rem;
      padding: 0.75rem 1rem;
    }

    .week-title {
      flex-wrap: wrap;
      gap: 0.25rem 0.6rem;
      min-width: 0;
    }

    .week-focus {
      flex-basis: 100%;
      font-size: 0.8rem;
      line-height: 1.4;
    }

    .days-grid {
      grid-template-columns: 1fr;
    }

    .day-column {
      flex-direction: row;
      align-items: flex-start;
      gap: 0.75rem;
      min-height: 0;
      padding: 0.75rem 0.75rem 0.75rem 1rem;
    }

    .day-header {
      flex: 0 0 3.25rem;
      flex-direction: column;
      align-items: flex-start;
      gap: 0.1rem;
      margin: 0;
      padding: 0.35rem 0 0;
      border-bottom: none;
    }

    .day-name-group {
      flex-direction: column;
      align-items: flex-start;
      gap: 0.2rem;
    }

    .day-date {
      font-size: 1rem;
      font-weight: 600;
      color: var(--text-secondary);
    }

    .today-badge {
      order: 2;
    }

    .empty-day {
      justify-content: flex-start;
      min-height: 2rem;
    }

    /* A full-width "+" under every day would double the list's height:
     * tuck it under the date, in the otherwise empty left column. */
    .day-column {
      position: relative;
      min-height: 6.75rem;
    }

    .day-column.today {
      min-height: 8.25rem; /* room for the TODAY badge above the "+" */
    }

    .add-workout-btn {
      position: absolute;
      left: 0.75rem;
      bottom: 0.75rem;
      width: 2.5rem;
      height: 2rem;
      margin: 0;
      padding: 0;
    }
  }
</style>
