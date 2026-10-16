<script lang="ts">
  import type { Estimate, RacePrediction } from "../racePrediction.js";
  import type { Settings } from "../settings.js";
  import { formatClock, formatSpeed, speedDisplay } from "../activityAnalysis.js";

  interface Props {
    prediction: RacePrediction;
    settings: Settings;
  }

  let { prediction, settings }: Props = $props();

  const display = $derived(speedDisplay("run", settings));
  const seconds = $derived(prediction.current.seconds);
  const goal = $derived(prediction.target.goalSeconds);
  const distance = $derived(prediction.target.distanceMeters);

  function shortDate(date: string): string {
    return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  }

  /** "2:20" for a gap in seconds, without its sign. */
  function gap(s: number): string {
    return formatClock(Math.abs(s));
  }

  // The change over the last four weeks (or since the first point, if newer).
  const trend = $derived.by(() => {
    const h = prediction.history;
    if (seconds === null || h.length < 2) return null;
    const cutoff = new Date(Date.parse(`${prediction.current.date}T00:00:00Z`) - 28 * 86_400_000)
      .toISOString()
      .slice(0, 10);
    const from = [...h].reverse().find((p) => p.date <= cutoff) ?? h[0];
    if (from.date === prediction.current.date) return null;
    return { change: seconds - from.seconds, since: from.date };
  });

  const ESTIMATE_LABELS: Record<Estimate["kind"], string> = {
    effort: "Best recent effort",
    heartRate: "Pace at race heart rate",
    volume: "Training volume",
    vo2max: "Garmin VO2max",
  };

  function estimateDetail(e: Estimate): string {
    switch (e.kind) {
      case "effort":
        return `${(e.effort.distanceMeters / 1000).toFixed(1)} km in ${formatClock(e.effort.seconds)} · ${shortDate(e.effort.date)}`;
      case "heartRate":
        return `${formatSpeed(e.speed, display)} at ${Math.round(e.hr)} bpm · ${e.splits} km of recent runs`;
      case "volume":
        return `${Math.round(e.kmPerWeek)} km/week at ${formatSpeed(1000 / e.paceSecondsPerKm, display)} on average`;
      case "vo2max":
        return `${e.vo2max.toFixed(1)} on ${shortDate(e.date)}`;
    }
  }

  // Sparkline geometry. Faster times plot higher, like a rising form curve.
  const W = 272;
  const H = 72;
  const PAD = 6;
  const chart = $derived.by(() => {
    const h = prediction.history;
    if (h.length < 2) return null;
    const values = h.map((p) => p.seconds);
    if (goal !== null) values.push(goal);
    let lo = Math.min(...values);
    let hi = Math.max(...values);
    // At least two minutes of range, so noise doesn't look like a cliff.
    const span = Math.max(hi - lo, 120);
    const mid = (hi + lo) / 2;
    lo = mid - span / 2;
    hi = mid + span / 2;
    const x = (i: number) => PAD + (i / (h.length - 1)) * (W - 2 * PAD);
    const y = (s: number) => PAD + ((s - lo) / (hi - lo)) * (H - 2 * PAD);
    const points = h.map((p, i) => ({ ...p, x: x(i), y: y(p.seconds) }));
    return {
      points,
      path: points.map((p, i) => `${i ? "L" : "M"}${p.x.toFixed(1)},${p.y.toFixed(1)}`).join(""),
      goalY: goal !== null ? y(goal) : null,
    };
  });

  let hovered = $state<number | null>(null);
</script>

<section class="prediction" aria-label="Race prediction">
  <h3>Race prediction</h3>

  {#if seconds === null}
    <p class="empty">
      Not enough recent running yet. It appears once a few runs are synced from Garmin.
    </p>
  {:else}
    <div class="time">{formatClock(seconds)}</div>
    <div class="sub">
      {formatSpeed(distance / seconds, display)}
      {#if goal !== null}
        · goal {formatClock(goal)}
        {#if Math.abs(seconds - goal) < 30}
          · on target
        {:else}
          · {gap(seconds - goal)} {seconds > goal ? "slower" : "faster"}
        {/if}
      {/if}
    </div>

    {#if chart}
      <div class="chart">
        <svg
          viewBox="0 0 {W} {H}"
          width="100%"
          role="img"
          aria-label="Predicted time each week"
          onmouseleave={() => (hovered = null)}
        >
          {#if chart.goalY !== null}
            <line class="goal" x1="0" x2={W} y1={chart.goalY} y2={chart.goalY} />
          {/if}
          <path class="line" d={chart.path} />
          {#each chart.points as p, i (p.date)}
            {#if i === chart.points.length - 1 || hovered === i}
              <circle class="dot" cx={p.x} cy={p.y} r="4" />
            {/if}
            <!-- svelte-ignore a11y_no_static_element_interactions -->
            <rect
              class="hit"
              x={p.x - W / chart.points.length / 2}
              y="0"
              width={W / chart.points.length}
              height={H}
              onmouseenter={() => (hovered = i)}
            />
          {/each}
        </svg>
        <div class="chart-caption">
          {#if hovered !== null}
            {shortDate(chart.points[hovered].date)} · {formatClock(chart.points[hovered].seconds)}
          {:else if trend}
            {#if Math.abs(trend.change) < 15}
              Steady since {shortDate(trend.since)}
            {:else}
              {trend.change < 0 ? "−" : "+"}{gap(trend.change)} since {shortDate(trend.since)}
            {/if}
          {/if}
          {#if goal !== null && hovered === null}
            <span class="legend"><span class="goal-swatch"></span>goal</span>
          {/if}
        </div>
      </div>
    {/if}

    <details>
      <summary>How it's estimated</summary>
      <ul>
        {#each prediction.current.estimates as e (e.kind)}
          <li>
            <div class="row">
              <span>{ESTIMATE_LABELS[e.kind]}</span>
              <span class="value">{formatClock(e.seconds)}</span>
            </div>
            <div class="detail">{estimateDetail(e)}</div>
          </li>
        {/each}
      </ul>
      <p class="note">
        The prediction is the average of these. Efforts and volume look back 8 weeks, heart rate 4
        weeks. It updates after each Garmin sync.
      </p>
    </details>
  {/if}
</section>

<style>
  .prediction {
    background: var(--bg-tertiary);
    border-radius: 10px;
    padding: 1rem;
  }

  h3 {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
    margin-bottom: 0.5rem;
  }

  .empty {
    font-size: 0.8rem;
    color: var(--text-secondary);
  }

  .time {
    font-family: "JetBrains Mono", monospace;
    font-size: 1.8rem;
    font-weight: 700;
    letter-spacing: -0.02em;
  }

  .sub {
    font-size: 0.8rem;
    color: var(--text-secondary);
    margin-top: 0.15rem;
  }

  .chart {
    margin-top: 0.75rem;
  }

  svg {
    display: block;
    overflow: visible;
  }

  .line {
    fill: none;
    stroke: var(--accent);
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  .goal {
    stroke: var(--text-muted);
    stroke-width: 1;
    stroke-dasharray: 4 4;
  }

  .dot {
    fill: var(--accent);
    stroke: var(--bg-tertiary);
    stroke-width: 2;
  }

  .hit {
    fill: transparent;
  }

  .chart-caption {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
    min-height: 1.2em;
    margin-top: 0.3rem;
    font-size: 0.75rem;
    color: var(--text-secondary);
  }

  .legend {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    margin-left: auto;
    color: var(--text-muted);
  }

  .goal-swatch {
    width: 14px;
    border-top: 1px dashed var(--text-muted);
  }

  details {
    margin-top: 0.75rem;
    font-size: 0.8rem;
  }

  summary {
    cursor: pointer;
    color: var(--text-secondary);
  }

  ul {
    list-style: none;
    margin: 0.6rem 0 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.55rem;
  }

  .row {
    display: flex;
    justify-content: space-between;
    gap: 0.5rem;
  }

  .value {
    font-family: "JetBrains Mono", monospace;
  }

  .detail,
  .note {
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  .note {
    margin-top: 0.6rem;
  }
</style>
