<script lang="ts">
  import { afterNavigate } from "$app/navigation";
  import type { TrainingPlan, TrainingDay, Workout } from "../../schema/training-plan.js";
  import WeekCard from "./WeekCard.svelte";
  import { getTodayISO } from "../utils.js";

  interface Props {
    plan: TrainingPlan;
    filters: { sport: string; status: string };
    onWorkoutClick: (workout: Workout, day: TrainingDay) => void;
    onWorkoutMove: (workoutId: string, newDate: string) => void;
    onAddWorkout: (day: TrainingDay) => void;
  }

  let { plan, filters, onWorkoutClick, onWorkoutMove, onAddWorkout }: Props = $props();

  const today = getTodayISO();

  // Open on today rather than week 1 - mid-plan, today is what you came
  // for, and on a phone week 1 can be dozens of screens away. afterNavigate,
  // not onMount: SvelteKit resets the scroll to the top once navigation
  // finishes, which would undo a scroll done any earlier. Instant, not smooth
  // (global.css sets scroll-behavior: smooth): nobody wants to watch the plan
  // scroll past on every load. Only on entering the page - not after the
  // invalidateAll() that follows each edit, which would yank the view away.
  afterNavigate(({ type }) => {
    if (type === "enter" || type === "link" || type === "goto") {
      document
        .getElementById("today-column")
        ?.scrollIntoView({ block: "start", behavior: "instant" });
    }
  });

  function filterWorkout(workout: Workout): boolean {
    if (filters.sport !== "all" && workout.sport !== filters.sport) {
      return false;
    }
    if (filters.status === "completed" && !workout.completed) {
      return false;
    }
    if (filters.status === "pending" && workout.completed) {
      return false;
    }
    return true;
  }
</script>

<div class="phase-timeline">
  {#each plan.phases ?? [] as phase}
    {@const weeks = phase.endWeek - phase.startWeek + 1}
    {@const phaseName = phase.name.toLowerCase()}
    <button
      class="phase-segment {phaseName}"
      style="flex: {weeks}"
      onclick={() => {
        const weekCard = document.querySelector(`[data-week="${phase.startWeek}"]`);
        weekCard?.scrollIntoView({ behavior: "smooth", block: "start" });
      }}
    >
      <span class="phase-label">{phase.name}</span>
    </button>
  {/each}
</div>

<div class="weeks-container">
  {#each plan.weeks ?? [] as week, index (week.weekNumber)}
    <div data-week={week.weekNumber}>
      <WeekCard
        {week}
        {today}
        {filterWorkout}
        {onWorkoutClick}
        onDrop={onWorkoutMove}
        {onAddWorkout}
        animationDelay={index * 0.05}
      />
    </div>
  {/each}
</div>

<style>
  .phase-timeline {
    display: flex;
    gap: 4px;
    margin-bottom: 1.5rem;
    padding: 0 1rem;
  }

  .phase-segment {
    flex: 1;
    height: 28px;
    border-radius: 6px;
    border: none;
    cursor: pointer;
    transition: all var(--transition-fast);
    display: flex;
    align-items: center;
    justify-content: center;
    position: relative;
    overflow: hidden;
    background: linear-gradient(135deg, #64748b, #475569); /* fallback */
  }

  @media (hover: hover) {
    .phase-segment:hover {
      filter: brightness(1.2);
    }
  }

  .phase-segment:active {
    transform: scale(0.98);
  }

  .phase-label {
    padding: 0 4px;
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    font-size: 0.65rem;
    font-weight: 600;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: rgba(255, 255, 255, 0.9);
    text-shadow: 0 1px 2px rgba(0, 0, 0, 0.3);
  }

  .phase-segment.base {
    background: linear-gradient(135deg, #3b82f6, #2563eb);
  }
  .phase-segment.build {
    background: linear-gradient(135deg, #8b5cf6, #7c3aed);
  }
  .phase-segment.peak {
    background: linear-gradient(135deg, #ec4899, #db2777);
  }
  .phase-segment.taper {
    background: linear-gradient(135deg, #14b8a6, #0d9488);
  }
  .phase-segment.recovery {
    background: linear-gradient(135deg, #6b7280, #4b5563);
  }
  .phase-segment.rebuild {
    background: linear-gradient(135deg, #f97316, #ea580c);
  }
  .phase-segment.survival {
    background: linear-gradient(135deg, #f59e0b, #d97706);
  }
  .phase-segment.bank {
    background: linear-gradient(135deg, #10b981, #059669);
  }

  .weeks-container {
    display: flex;
    flex-direction: column;
    gap: 1.5rem;
  }

  @media (max-width: 800px) {
    .phase-timeline {
      padding: 0;
      margin-bottom: 1rem;
    }

    .weeks-container {
      gap: 1rem;
    }
  }
</style>
