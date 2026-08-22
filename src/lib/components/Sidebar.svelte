<script lang="ts">
  import type { TrainingPlan, Sport } from "../../schema/training-plan.js";
  import { formatEventDate, getDaysToEvent, getSportIcon } from "../utils.js";

  interface Props {
    plan: TrainingPlan;
    filters: { sport: string; status: string };
    onFilterChange: (filters: { sport: string; status: string }) => void;
    onSettingsClick: () => void;
  }

  let { plan, filters, onFilterChange, onSettingsClick }: Props = $props();

  const stats = $derived.by(() => {
    let totalWorkouts = 0;
    let completedCount = 0;
    let totalMinutes = 0;
    const sportHours: Record<string, number> = {
      swim: 0,
      bike: 0,
      run: 0,
      strength: 0,
      brick: 0,
      race: 0,
    };

    plan.weeks?.forEach((week) => {
      week.days?.forEach((day) => {
        day.workouts?.forEach((w) => {
          if (w.sport !== "rest") {
            totalWorkouts++;
            if (w.completed) completedCount++;
            if (w.durationMinutes) {
              totalMinutes += w.durationMinutes;
              if (sportHours[w.sport] !== undefined) {
                sportHours[w.sport] += w.durationMinutes / 60;
              }
            }
          }
        });
      });
    });

    return {
      totalWorkouts,
      completedCount,
      totalHours: Math.round(totalMinutes / 60),
      sportHours,
      progress: totalWorkouts > 0 ? Math.round((completedCount / totalWorkouts) * 100) : 0,
    };
  });

  const progressOffset = $derived(377 - (stats.progress / 100) * 377);
  const daysToEvent = $derived(getDaysToEvent(plan.meta?.eventDate ?? ""));

  const availableSports = $derived(
    Object.entries(stats.sportHours)
      .filter(([, h]) => h > 0)
      .map(([sport]) => sport)
  );

  function toggleSportFilter(sport: string) {
    onFilterChange({ ...filters, sport: filters.sport === sport ? "all" : sport });
  }
</script>

<aside class="sidebar">
  <div class="event-header">
    <h1 class="event-name">{plan.meta?.event ?? "Training Plan"}</h1>
    <div class="event-date">{formatEventDate(plan.meta?.eventDate ?? "")}</div>
    <div class="athlete-name">{plan.meta?.athlete ?? "Athlete"}</div>
  </div>

  <div class="progress-section">
    <div class="progress-ring-container">
      <svg class="progress-ring" width="140" height="140">
        <defs>
          <linearGradient id="progressGradient" x1="0%" y1="0%" x2="100%" y2="0%">
            <stop offset="0%" style="stop-color: var(--accent)" />
            <stop offset="100%" style="stop-color: var(--run)" />
          </linearGradient>
        </defs>
        <circle class="progress-ring-bg" cx="70" cy="70" r="60" />
        <circle
          class="progress-ring-fill"
          cx="70"
          cy="70"
          r="60"
          style="stroke-dashoffset: {progressOffset}"
        />
      </svg>
      <div class="progress-text">
        <div class="progress-percent">{stats.progress}%</div>
        <div class="progress-label">Complete</div>
      </div>
    </div>
  </div>

  <div class="stats-grid">
    <div class="stat-card">
      <div class="stat-value">{plan.meta?.totalWeeks ?? 0}</div>
      <div class="stat-label">Weeks</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{stats.totalHours}</div>
      <div class="stat-label">Hours</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{stats.totalWorkouts}</div>
      <div class="stat-label">Workouts</div>
    </div>
    <div class="stat-card">
      <div class="stat-value">{daysToEvent}</div>
      <div class="stat-label">Days Left</div>
    </div>
  </div>

  <button class="settings-btn" onclick={onSettingsClick}>
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
      <path
        d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"
      />
      <circle cx="12" cy="12" r="3" />
    </svg>
    Settings
  </button>

  <div class="sport-stats">
    <div class="sport-stats-header">
      <h3>Filter by Sport</h3>
      {#if filters.sport !== "all"}
        <button class="clear-filter" onclick={() => onFilterChange({ ...filters, sport: "all" })}>
          Clear
        </button>
      {/if}
    </div>
    {#each availableSports as sport (sport)}
      <button
        class="sport-stat {sport}"
        class:active={filters.sport === sport}
        onclick={() => toggleSportFilter(sport)}
      >
        <div class="sport-icon {sport}">{getSportIcon(sport as Sport)}</div>
        <div class="sport-info">
          <div class="sport-name">{sport.charAt(0).toUpperCase() + sport.slice(1)}</div>
          <div class="sport-hours">{stats.sportHours[sport].toFixed(1)} hours</div>
        </div>
        {#if filters.sport === sport}
          <div class="check-icon">✓</div>
        {/if}
      </button>
    {/each}
  </div>

  <div class="filters-section">
    <h3>Filter by Status</h3>
    <div class="filter-group">
      {#each [["all", "All"], ["pending", "Pending"], ["completed", "Completed"]] as [value, label] (value)}
        <button
          class="filter-chip"
          class:active={filters.status === value}
          onclick={() => onFilterChange({ ...filters, status: value })}
        >
          {label}
        </button>
      {/each}
    </div>
  </div>
</aside>

<style>
  .sidebar {
    width: var(--sidebar-width);
    background: var(--bg-secondary);
    border-right: 1px solid var(--border-subtle);
    padding: 2rem 1.5rem;
    display: flex;
    flex-direction: column;
    gap: 2rem;
    position: fixed;
    top: 0;
    left: 0;
    height: 100vh;
    overflow-y: auto;
  }

  .event-header {
    text-align: center;
    padding-bottom: 1.5rem;
    border-bottom: 1px solid var(--border-subtle);
  }

  .event-name {
    font-size: 1.5rem;
    font-weight: 700;
    letter-spacing: -0.02em;
    background: linear-gradient(135deg, var(--text-primary), var(--text-secondary));
    -webkit-background-clip: text;
    -webkit-text-fill-color: transparent;
    background-clip: text;
    margin-bottom: 0.5rem;
  }

  .event-date {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.85rem;
    color: var(--accent);
    font-weight: 500;
    letter-spacing: 0.05em;
  }

  .athlete-name {
    font-size: 0.9rem;
    color: var(--text-muted);
    margin-top: 0.5rem;
  }

  .progress-section {
    text-align: center;
  }

  .progress-ring-container {
    position: relative;
    width: 140px;
    height: 140px;
    margin: 0 auto;
  }

  .progress-ring {
    transform: rotate(-90deg);
  }

  .progress-ring-bg {
    fill: none;
    stroke: var(--bg-tertiary);
    stroke-width: 8;
  }

  .progress-ring-fill {
    fill: none;
    stroke: url(#progressGradient);
    stroke-width: 8;
    stroke-linecap: round;
    stroke-dasharray: 377;
    transition: stroke-dashoffset 1s ease-out;
  }

  .progress-text {
    position: absolute;
    top: 50%;
    left: 50%;
    transform: translate(-50%, -50%);
    text-align: center;
  }

  .progress-percent {
    font-size: 1.8rem;
    font-weight: 700;
  }

  .progress-label {
    font-size: 0.7rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
  }

  .stats-grid {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 0.75rem;
  }

  .stat-card {
    background: var(--bg-tertiary);
    border-radius: 10px;
    padding: 0.9rem;
    text-align: center;
  }

  .stat-value {
    font-size: 1.4rem;
    font-weight: 700;
  }

  .stat-label {
    font-size: 0.7rem;
    color: var(--text-muted);
    text-transform: uppercase;
    letter-spacing: 0.05em;
    margin-top: 0.2rem;
  }

  .settings-btn {
    display: flex;
    align-items: center;
    justify-content: center;
    gap: 0.6rem;
    padding: 0.7rem 1rem;
    border-radius: 10px;
    border: 1px solid var(--border-medium);
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.85rem;
    font-weight: 500;
  }

  .settings-btn svg {
    width: 16px;
    height: 16px;
  }

  .settings-btn:hover {
    background: var(--bg-tertiary);
    color: var(--text-primary);
  }

  .sport-stats h3,
  .filters-section h3 {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: 0.75rem;
  }

  .sport-stats-header {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .clear-filter {
    font-size: 0.7rem;
    color: var(--accent);
    background: none;
    border: none;
  }

  .sport-stat {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 0.6rem;
    border-radius: 8px;
    border: 1px solid transparent;
    background: transparent;
    margin-bottom: 0.3rem;
    text-align: left;
  }

  .sport-stat:hover {
    background: var(--bg-tertiary);
  }

  .sport-stat.active {
    background: var(--bg-tertiary);
    border-color: var(--border-medium);
  }

  .sport-icon {
    font-size: 1.1rem;
  }

  .sport-info {
    flex: 1;
  }

  .sport-name {
    font-size: 0.85rem;
    font-weight: 500;
  }

  .sport-hours {
    font-size: 0.75rem;
    color: var(--text-muted);
  }

  .check-icon {
    color: var(--accent);
  }

  .filter-group {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }

  .filter-chip {
    padding: 0.4rem 0.8rem;
    border-radius: 999px;
    border: 1px solid var(--border-medium);
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.8rem;
  }

  .filter-chip.active {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--bg-primary);
    font-weight: 600;
  }
</style>
