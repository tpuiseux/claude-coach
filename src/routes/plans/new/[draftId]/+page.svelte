<script lang="ts">
  import { onDestroy, untrack } from "svelte";
  import { goto } from "$app/navigation";
  import { base } from "$app/paths";
  import type { DraftView } from "$lib/planDraft.js";
  import { renderMarkdown } from "$lib/markdown.js";
  import { formatDuration } from "$lib/utils.js";
  import type { PageData } from "./$types";

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let draft = $state<DraftView>(untrack(() => data.draft));
  let feedback = $state("");
  let busy = $state(false);
  let errorText = $state<string | null>(null);

  const url = $derived(`${base}/plans/new/${draft.id}`);
  const working = $derived(draft.status === "assessing" || draft.status === "generating");

  // While the coach works, check on it every few seconds.
  let timer: ReturnType<typeof setTimeout> | null = null;
  async function poll() {
    try {
      const res = await fetch(url);
      if (res.ok) draft = await res.json();
    } catch {
      // Try again next tick.
    }
    schedule();
  }
  function schedule() {
    if (timer) clearTimeout(timer);
    timer = working ? setTimeout(poll, 3000) : null;
  }
  $effect(() => {
    if (working) schedule();
  });
  onDestroy(() => timer && clearTimeout(timer));

  async function act(action: string, text?: string) {
    busy = true;
    errorText = null;
    try {
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ action, text }),
      });
      const body = await res.json().catch(() => null);
      if (!res.ok) throw new Error(body?.message ?? `Request failed (${res.status})`);
      if (action === "adopt") {
        await goto(`${base}/plans/${body.planId}`);
        return;
      }
      draft = body;
      feedback = "";
      schedule();
    } catch (err) {
      errorText = err instanceof Error ? err.message : "Something went wrong.";
    } finally {
      busy = false;
    }
  }

  function shortDate(date: string): string {
    return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  }

  const progress = $derived(
    draft.totalWeeks ? Math.round((draft.weeks.length / draft.totalWeeks) * 100) : 0
  );
</script>

<svelte:head>
  <title>{draft.form.raceName} — new plan</title>
</svelte:head>

<main>
  <a class="back" href="{base}/">← All plans</a>
  <h1>{draft.form.raceName}</h1>
  <p class="sub">
    {shortDate(draft.form.raceDate)} · {draft.totalWeeks} weeks from {shortDate(
      draft.form.startDate
    )}
  </p>

  {#if draft.status === "assessing"}
    <div class="working" role="status">
      <span class="spinner"></span>
      The coach is looking at your answers{draft.assessment ? " and your changes" : ""}… usually
      under a minute.
    </div>
  {/if}

  {#if draft.assessment && (draft.status === "awaiting_confirmation" || draft.status === "assessing")}
    <section class="card" class:dim={draft.status === "assessing"}>
      <h2>The coach's assessment</h2>
      <div class="markdown">{@html renderMarkdown(draft.assessment.message)}</div>
      <div class="outline">
        <div><span>Goal</span><strong>{draft.assessment.goalTime}</strong></div>
        {#each draft.assessment.phases as p (p.name + p.startWeek)}
          <div>
            <span
              >{p.startWeek === p.endWeek
                ? `Week ${p.startWeek}`
                : `Weeks ${p.startWeek}–${p.endWeek}`}</span
            ><strong>{p.name}</strong>
            <em>{p.focus}</em>
          </div>
        {/each}
      </div>
      {#if draft.status === "awaiting_confirmation"}
        <div class="answer">
          <textarea
            bind:value={feedback}
            rows="3"
            placeholder="Something to change? e.g. I can only do 3 runs a week, aim for 3:20…"
          ></textarea>
          <div class="buttons">
            <button disabled={busy || !feedback.trim()} onclick={() => act("feedback", feedback)}>
              Ask for changes
            </button>
            <button class="primary" disabled={busy} onclick={() => act("confirm")}>
              Looks good - write my plan
            </button>
          </div>
        </div>
      {/if}
    </section>
  {/if}

  {#if draft.status === "generating"}
    <section class="card">
      <h2>Writing your plan</h2>
      <div
        class="bar"
        role="progressbar"
        aria-valuenow={progress}
        aria-valuemin="0"
        aria-valuemax="100"
      >
        <div style:width="{Math.max(progress, 3)}%"></div>
      </div>
      <p class="muted">
        Week {Math.min(draft.weeks.length + 1, draft.totalWeeks)} of {draft.totalWeeks}… You can
        leave this page: the coach carries on, and the plan will be here when you come back.
      </p>
    </section>
  {/if}

  {#if draft.status === "failed"}
    <section class="card">
      <p class="error">{draft.error ?? "Something went wrong."}</p>
      <button class="primary" disabled={busy} onclick={() => act("retry")}>Retry</button>
    </section>
  {/if}

  {#if draft.status === "ready"}
    <section class="card">
      <h2>Your plan is ready</h2>
      <p class="muted">
        Look it over below, then adopt it. You can still change it afterwards, by hand or with the
        coach.
      </p>
      <button class="primary" disabled={busy} onclick={() => act("adopt")}>Adopt this plan</button>
    </section>
  {/if}

  {#if draft.status === "adopted" && draft.planId}
    <section class="card">
      <p>This plan was adopted.</p>
      <a class="primary link" href="{base}/plans/{draft.planId}">Open it</a>
    </section>
  {/if}

  {#if errorText}<p class="error" role="alert">{errorText}</p>{/if}

  {#if draft.weeks.length > 0}
    <section class="weeks">
      {#each draft.weeks as week (week.weekNumber)}
        <div class="week">
          <div class="week-head">
            <span class="num">W{week.weekNumber}</span>
            <span class="phase">{week.phase}</span>
            <span class="focus">{week.focus}</span>
            <span class="hours">{week.summary.totalHours} h</span>
          </div>
          <ul>
            {#each week.days as day (day.date)}
              {#each day.workouts.filter((w) => w.sport !== "rest") as w (w.id)}
                <li>
                  <span class="day">{day.dayOfWeek.slice(0, 3)}</span>
                  <span class="name sport-{w.sport}">{w.name}</span>
                  {#if w.durationMinutes}<span class="dur">{formatDuration(w.durationMinutes)}</span
                    >{/if}
                </li>
              {/each}
            {/each}
          </ul>
        </div>
      {/each}
    </section>
  {/if}
</main>

<style>
  main {
    max-width: 760px;
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
    margin: 1rem 0 0.25rem;
  }

  .sub {
    color: var(--text-secondary);
    font-size: 0.9rem;
    margin-bottom: 1.25rem;
  }

  h2 {
    font-size: 1rem;
    margin-bottom: 0.75rem;
  }

  .card {
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 12px;
    padding: 1.1rem 1.25rem;
    margin-bottom: 1.25rem;
  }

  .card.dim {
    opacity: 0.6;
  }

  .working {
    display: flex;
    align-items: center;
    gap: 0.7rem;
    color: var(--text-secondary);
    font-size: 0.9rem;
    margin-bottom: 1.25rem;
  }

  .spinner {
    width: 16px;
    height: 16px;
    border-radius: 50%;
    border: 2px solid var(--border-medium);
    border-top-color: var(--accent);
    animation: spin 0.9s linear infinite;
  }

  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }

  .markdown {
    font-size: 0.9rem;
    line-height: 1.55;
  }

  .markdown :global(p),
  .markdown :global(ul),
  .markdown :global(ol) {
    margin: 0 0 0.6rem;
  }

  .markdown :global(ul),
  .markdown :global(ol) {
    padding-left: 1.2rem;
  }

  .outline {
    display: flex;
    flex-direction: column;
    gap: 0.35rem;
    margin-top: 0.75rem;
    padding-top: 0.75rem;
    border-top: 1px solid var(--border-subtle);
    font-size: 0.85rem;
  }

  .outline div {
    display: flex;
    flex-wrap: wrap;
    gap: 0.2rem 0.7rem;
  }

  .outline span {
    color: var(--text-muted);
    min-width: 6.5rem;
  }

  .outline em {
    color: var(--text-secondary);
    font-style: normal;
    flex-basis: 100%;
    padding-left: 7.2rem;
  }

  .answer {
    margin-top: 1rem;
  }

  textarea {
    width: 100%;
    padding: 0.6rem 0.75rem;
    border-radius: 8px;
    border: 1px solid var(--border-medium);
    background: var(--bg-primary);
    color: var(--text-primary);
    font: inherit;
    font-size: 0.9rem;
    resize: vertical;
  }

  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 0.6rem;
    justify-content: flex-end;
  }

  button,
  .link {
    padding: 0.6rem 1rem;
    border-radius: 8px;
    border: 1px solid var(--border-medium);
    background: transparent;
    color: var(--text-primary);
    font-size: 0.88rem;
    text-decoration: none;
    display: inline-block;
  }

  .primary {
    background: var(--accent);
    border-color: var(--accent);
    color: var(--bg-primary);
    font-weight: 700;
  }

  button:disabled {
    opacity: 0.5;
    cursor: not-allowed;
  }

  .bar {
    height: 8px;
    border-radius: 4px;
    background: var(--bg-tertiary);
    overflow: hidden;
  }

  .bar div {
    height: 100%;
    background: var(--accent);
    transition: width var(--transition-slow);
  }

  .muted {
    color: var(--text-secondary);
    font-size: 0.85rem;
    margin: 0.6rem 0;
  }

  .error {
    padding: 0.6rem 0.8rem;
    border-radius: 8px;
    background: #3a1414;
    color: #f87171;
    font-size: 0.85rem;
    margin-bottom: 0.75rem;
  }

  .weeks {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }

  .week {
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 12px;
    padding: 0.8rem 1rem;
  }

  .week-head {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 0.3rem 0.8rem;
    font-size: 0.82rem;
    margin-bottom: 0.5rem;
  }

  .num {
    font-family: "JetBrains Mono", monospace;
    color: var(--text-muted);
  }

  .phase {
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: 0.75rem;
  }

  .focus {
    color: var(--text-secondary);
    flex: 1;
  }

  .hours {
    font-family: "JetBrains Mono", monospace;
    color: var(--text-secondary);
  }

  ul {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.2rem;
    font-size: 0.85rem;
  }

  li {
    display: flex;
    gap: 0.7rem;
  }

  .day {
    width: 2.5rem;
    color: var(--text-muted);
  }

  .name {
    flex: 1;
  }

  .sport-run,
  .sport-race {
    color: var(--run);
  }

  .sport-strength {
    color: var(--strength);
  }

  .dur {
    color: var(--text-secondary);
    font-family: "JetBrains Mono", monospace;
    font-size: 0.8rem;
  }

  @media (max-width: 600px) {
    main {
      margin-top: 1rem;
      padding: 0 1rem;
    }

    .outline em {
      padding-left: 0;
    }

    textarea {
      font-size: 16px;
    }

    .buttons button {
      flex: 1;
      min-height: 44px;
    }
  }
</style>
