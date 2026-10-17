<script lang="ts">
  import { untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import { RACE_DISTANCES, WEEKDAYS, type PlanForm, type Weekday } from "$lib/planDraft.js";
  import type { PageData } from "./$types";

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  const DAY_LABELS: Record<Weekday, string> = {
    monday: "Mon",
    tuesday: "Tue",
    wednesday: "Wed",
    thursday: "Thu",
    friday: "Fri",
    saturday: "Sat",
    sunday: "Sun",
  };

  const browserFrench = typeof navigator !== "undefined" && navigator.language?.startsWith("fr");

  let form = $state<PlanForm>({
    raceName: "",
    raceDate: "",
    distance: "marathon",
    distanceKm: null,
    terrain: "road",
    elevationGainM: null,
    goalTime: "",
    startDate: untrack(() => data.startDate),
    availableDays: ["tuesday", "thursday", "saturday", "sunday"],
    longRunDay: "sunday",
    runsPerWeek: 4,
    currentWeeklyKm: 30,
    longestRecentRunKm: 12,
    yearsRunning: 2,
    recentRaces: "",
    maxHr: null,
    restingHr: null,
    injuries: "",
    otherSports: "",
    strength: true,
    units: "kilometers",
    language: browserFrench ? "fr" : "en",
    notes: "",
  });

  let submitting = $state(false);
  let errorText = $state<string | null>(null);

  const weeks = $derived.by(() => {
    if (!form.raceDate || !form.startDate || form.raceDate <= form.startDate) return null;
    const days = (Date.parse(form.raceDate) - Date.parse(form.startDate)) / 86_400_000;
    return Math.floor(days / 7) + 1;
  });

  function toggleDay(day: Weekday) {
    form.availableDays = form.availableDays.includes(day)
      ? form.availableDays.filter((d) => d !== day)
      : WEEKDAYS.filter((d) => d === day || form.availableDays.includes(d));
  }

  async function submit(e: SubmitEvent) {
    e.preventDefault();
    submitting = true;
    errorText = null;
    try {
      const res = await fetch(`${base}/plans/new`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(form),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `Couldn't start the plan (${res.status})`);
      await goto(`${base}/plans/new/${body.draftId}`);
    } catch (err) {
      errorText = err instanceof Error ? err.message : "Couldn't start the plan.";
      submitting = false;
    }
  }
</script>

<svelte:head>
  <title>Create a plan — Claude Coach</title>
</svelte:head>

<main>
  <a class="back" href="{base}/">← All plans</a>
  <h1>Create a training plan</h1>
  <p class="intro">
    Tell the coach about your race and your running. It will assess where you stand and suggest an
    outline for you to confirm, then write the plan week by week - a few minutes.
  </p>

  {#if !data.configured}
    <p class="error">The coach isn't set up on this server yet (no Anthropic API key).</p>
  {/if}

  <form onsubmit={submit}>
    <fieldset>
      <legend>The race</legend>
      <label class="wide"
        >Name <input
          bind:value={form.raceName}
          required
          placeholder="Marathon de Toulouse"
        /></label
      >
      <label>Date <input type="date" bind:value={form.raceDate} required min={data.today} /></label>
      <label>
        Distance
        <select bind:value={form.distance}>
          {#each Object.entries(RACE_DISTANCES) as [key, d] (key)}
            <option value={key}>{d.label}</option>
          {/each}
          <option value="other">Other</option>
        </select>
      </label>
      {#if form.distance === "other"}
        <label
          >Distance (km) <input
            type="number"
            min="1"
            step="0.1"
            bind:value={form.distanceKm}
            required
          /></label
        >
      {/if}
      <label>
        Terrain
        <select bind:value={form.terrain}>
          <option value="road">Road</option>
          <option value="trail">Trail</option>
        </select>
      </label>
      {#if form.terrain === "trail"}
        <label
          >Elevation gain (m) <input
            type="number"
            min="0"
            bind:value={form.elevationGainM}
          /></label
        >
      {/if}
      <label>Goal time <input bind:value={form.goalTime} placeholder="3:15:00 (optional)" /></label>
    </fieldset>

    <fieldset>
      <legend>Your week</legend>
      <label>
        Plan starts (Monday)
        <input type="date" bind:value={form.startDate} required />
      </label>
      {#if weeks}<p class="hint">{weeks} weeks to race day.</p>{/if}
      <div class="wide">
        <span class="label">Days you can train</span>
        <div class="days">
          {#each WEEKDAYS as day (day)}
            <button
              type="button"
              class="day"
              class:on={form.availableDays.includes(day)}
              aria-pressed={form.availableDays.includes(day)}
              onclick={() => toggleDay(day)}>{DAY_LABELS[day]}</button
            >
          {/each}
        </div>
      </div>
      <label>
        Long run on
        <select bind:value={form.longRunDay}>
          {#each WEEKDAYS as day (day)}
            <option value={day}>{DAY_LABELS[day]}</option>
          {/each}
        </select>
      </label>
      <label
        >Runs per week <input
          type="number"
          min="2"
          max="7"
          bind:value={form.runsPerWeek}
          required
        /></label
      >
      <label class="check"
        ><input type="checkbox" bind:checked={form.strength} /> Include strength sessions</label
      >
    </fieldset>

    <fieldset>
      <legend>Your running</legend>
      <label
        >Km per week lately <input
          type="number"
          min="0"
          bind:value={form.currentWeeklyKm}
          required
        /></label
      >
      <label
        >Longest recent run (km) <input
          type="number"
          min="0"
          bind:value={form.longestRecentRunKm}
          required
        /></label
      >
      <label
        >Years running <input
          type="number"
          min="0"
          bind:value={form.yearsRunning}
          required
        /></label
      >
      <label
        >Max heart rate <input
          type="number"
          bind:value={form.maxHr}
          placeholder="optional"
        /></label
      >
      <label
        >Resting heart rate <input
          type="number"
          bind:value={form.restingHr}
          placeholder="optional"
        /></label
      >
      <label class="wide">
        Recent races and times
        <textarea
          bind:value={form.recentRaces}
          rows="2"
          placeholder="10K 43:03 (Nov 2024), half 1:31:52 (Nov 2025)"
        ></textarea>
      </label>
      <label class="wide">
        Injuries, health
        <textarea
          bind:value={form.injuries}
          rows="2"
          placeholder="Hamstring niggle, sees a physio twice a week"
        ></textarea>
      </label>
      <label class="wide">
        Other sports
        <textarea
          bind:value={form.otherSports}
          rows="2"
          placeholder="Badminton once or twice a week"
        ></textarea>
      </label>
      <label class="wide">
        Anything else
        <textarea
          bind:value={form.notes}
          rows="2"
          placeholder="Travel, a race on the way, how you like to train…"
        ></textarea>
      </label>
    </fieldset>

    <fieldset>
      <legend>Preferences</legend>
      <label>
        Units
        <select bind:value={form.units}>
          <option value="kilometers">Kilometres</option>
          <option value="miles">Miles</option>
        </select>
      </label>
      <label>
        Plan language
        <select bind:value={form.language}>
          <option value="en">English</option>
          <option value="fr">Français</option>
        </select>
      </label>
    </fieldset>

    {#if errorText}<p class="error" role="alert">{errorText}</p>{/if}
    <button class="primary" type="submit" disabled={submitting || !data.configured}>
      {submitting ? "Starting…" : "Ask the coach"}
    </button>
  </form>
</main>

<style>
  main {
    max-width: 720px;
    margin: 2rem auto 4rem;
    padding: 0 1.5rem;
  }

  .back {
    font-size: 0.85rem;
    color: var(--text-muted);
    text-decoration: none;
  }

  h1 {
    font-size: 1.5rem;
    margin: 1rem 0 0.5rem;
  }

  .intro {
    color: var(--text-secondary);
    font-size: 0.9rem;
    line-height: 1.5;
    margin-bottom: 1.5rem;
  }

  fieldset {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 0.9rem 1rem;
    border: 1px solid var(--border-subtle);
    border-radius: 12px;
    padding: 1rem 1.1rem 1.2rem;
    margin: 0 0 1.25rem;
    background: var(--bg-secondary);
  }

  legend {
    padding: 0 0.4rem;
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }

  label,
  .label {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .wide {
    grid-column: 1 / -1;
  }

  .check {
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
    align-self: end;
  }

  input,
  select,
  textarea {
    padding: 0.55rem 0.7rem;
    border-radius: 8px;
    border: 1px solid var(--border-medium);
    background: var(--bg-primary);
    color: var(--text-primary);
    font: inherit;
    font-size: 0.9rem;
  }

  input[type="checkbox"] {
    width: 18px;
    height: 18px;
  }

  textarea {
    resize: vertical;
  }

  .hint {
    align-self: end;
    font-size: 0.8rem;
    color: var(--text-muted);
    margin: 0 0 0.6rem;
  }

  .days {
    display: flex;
    flex-wrap: wrap;
    gap: 0.4rem;
  }

  .day {
    min-width: 3.2rem;
    padding: 0.45rem 0.6rem;
    border-radius: 999px;
    border: 1px solid var(--border-medium);
    background: transparent;
    color: var(--text-secondary);
    font-size: 0.82rem;
  }

  .day.on {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--bg-primary);
    font-weight: 600;
  }

  .primary {
    padding: 0.75rem 1.4rem;
    border-radius: 10px;
    border: none;
    background: var(--accent);
    color: var(--bg-primary);
    font-weight: 700;
    font-size: 0.95rem;
  }

  .primary:disabled {
    opacity: 0.6;
  }

  .error {
    padding: 0.6rem 0.8rem;
    border-radius: 8px;
    background: #3a1414;
    color: #f87171;
    font-size: 0.85rem;
    margin-bottom: 1rem;
  }

  @media (max-width: 600px) {
    main {
      margin-top: 1rem;
      padding: 0 1rem;
    }

    input,
    select,
    textarea {
      font-size: 16px;
    }

    .day {
      min-height: 40px;
    }
  }
</style>
