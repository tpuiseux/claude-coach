<script lang="ts">
  import { fatigueSignals, type LoadDay, type LoadSeries } from "../load.js";

  interface Props {
    load: LoadSeries;
    planStartDate: string;
    /** Opens the coach chat with a message about the signals. */
    onAskCoach: (text: string) => void;
  }

  let { load, planStartDate, onAskCoach }: Props = $props();

  const STORAGE_KEY = "coach.loadPanel.open";
  let open = $state(readOpen());

  function readOpen(): boolean {
    try {
      return localStorage.getItem(STORAGE_KEY) === "1";
    } catch {
      return false;
    }
  }

  function toggle() {
    open = !open;
    try {
      localStorage.setItem(STORAGE_KEY, open ? "1" : "0");
    } catch {
      // Remembering is a nicety.
    }
  }

  const days = $derived(load.days);
  const signals = $derived(fatigueSignals(days));

  /** The latest day with a value for each measure - today's may not be in yet. */
  function latest<K extends keyof LoadDay>(key: K): LoadDay | null {
    for (let i = days.length - 1; i >= 0; i--) if (days[i][key] !== null) return days[i];
    return null;
  }

  function shortDate(date: string): string {
    return new Date(`${date}T00:00:00Z`).toLocaleDateString("en-GB", {
      day: "numeric",
      month: "short",
      timeZone: "UTC",
    });
  }

  function titleCase(s: string): string {
    return s.charAt(0) + s.slice(1).toLowerCase().replace(/_/g, " ");
  }

  const tiles = $derived.by(() => {
    const t: { label: string; value: string; sub: string }[] = [];
    const a = latest("acwr");
    if (a?.acwr != null) {
      t.push({
        label: "ACWR",
        value: a.acwr.toFixed(2),
        sub: a.acwr > 1.5 ? "ramping fast" : a.acwr < 0.8 ? "below your usual" : "in range",
      });
    }
    const l = latest("acute");
    if (l?.acute != null) {
      t.push({
        label: "Load (7 days)",
        value: String(Math.round(l.acute)),
        sub: l.chronic != null ? `4-week ${Math.round(l.chronic)}` : "",
      });
    }
    const h = latest("hrv");
    if (h?.hrv != null) {
      t.push({
        label: "HRV",
        value: `${Math.round(h.hrv)} ms`,
        sub: h.hrvStatus ? titleCase(h.hrvStatus) : "",
      });
    }
    const s = latest("sleepScore");
    if (s?.sleepScore != null)
      t.push({ label: "Sleep", value: String(s.sleepScore), sub: shortDate(s.date) });
    const r = latest("readiness");
    if (r?.readiness != null)
      t.push({ label: "Readiness", value: String(r.readiness), sub: shortDate(r.date) });
    const rhr = latest("restingHr");
    if (rhr?.restingHr != null)
      t.push({ label: "Resting HR", value: `${rhr.restingHr} bpm`, sub: shortDate(rhr.date) });
    return t;
  });

  function askCoach() {
    onAskCoach(
      `My recovery data shows: ${signals.map((s) => s.text.toLowerCase()).join("; ")}. Should I change anything in the coming days?`
    );
  }

  // --- Charts ---------------------------------------------------------------

  interface Series {
    key: string;
    label: string;
    color: string;
    values: (number | null)[];
    kind: "line" | "dots" | "bars";
  }

  interface Panel {
    key: string;
    title: string;
    unit: string;
    series: Series[];
    /** Shaded band and dashed reference line, in data units. */
    band?: [number, number];
    reference?: number;
    domain: [number, number];
    format: (v: number) => string;
  }

  const PANEL_HEIGHT = 92;
  const M = { left: 36, right: 12, top: 8, bottom: 6 };
  let width = $state(0);
  const plotWidth = $derived(Math.max(0, width - M.left - M.right));
  const plotHeight = PANEL_HEIGHT - M.top - M.bottom;

  function domainOf(values: (number | null)[], pad = 0.08, floor?: number): [number, number] {
    const v = values.filter((x): x is number => x !== null);
    if (v.length === 0) return [0, 1];
    let lo = Math.min(...v);
    let hi = Math.max(...v);
    const span = hi - lo || Math.abs(hi) * 0.1 || 1;
    lo -= span * pad;
    hi += span * pad;
    if (floor !== undefined) lo = Math.max(floor, lo);
    return [lo, hi];
  }

  const panels = $derived.by((): Panel[] => {
    const out: Panel[] = [];
    const acute = days.map((d) => d.acute);
    const chronic = days.map((d) => d.chronic);
    if (acute.some((v) => v !== null)) {
      out.push({
        key: "load",
        title: "Training load",
        unit: load.loadSource === "garmin" ? "" : "(from activities)",
        series: [
          { key: "acute", label: "7 days", color: "var(--run)", values: acute, kind: "line" },
          {
            key: "chronic",
            label: "4 weeks",
            color: "var(--phase-base)",
            values: chronic,
            kind: "line",
          },
        ],
        domain: domainOf([...acute, ...chronic], 0.08, 0),
        format: (v) => String(Math.round(v)),
      });
    }
    const acwr = days.map((d) => d.acwr);
    if (acwr.some((v) => v !== null)) {
      const [lo, hi] = domainOf([...acwr, 0.8, 1.6]);
      out.push({
        key: "acwr",
        title: "ACWR",
        unit: "acute : chronic",
        series: [
          { key: "acwr", label: "ACWR", color: "var(--text-primary)", values: acwr, kind: "line" },
        ],
        band: [0.8, 1.3],
        reference: 1.5,
        domain: [lo, hi],
        format: (v) => v.toFixed(1),
      });
    }
    const hrv = days.map((d) => d.hrv);
    if (hrv.some((v) => v !== null)) {
      const weekly = days.map((d) => d.hrvWeekly);
      out.push({
        key: "hrv",
        title: "HRV",
        unit: "ms",
        series: [
          { key: "hrv", label: "Night", color: "var(--phase-build)", values: hrv, kind: "dots" },
          {
            key: "hrvWeekly",
            label: "7-day avg",
            color: "var(--phase-build)",
            values: weekly,
            kind: "line",
          },
        ],
        domain: domainOf([...hrv, ...weekly]),
        format: (v) => String(Math.round(v)),
      });
    }
    const sleep = days.map((d) => (d.sleepScore === null ? null : d.sleepScore));
    if (sleep.some((v) => v !== null)) {
      out.push({
        key: "sleep",
        title: "Sleep score",
        unit: "",
        series: [
          { key: "sleep", label: "Sleep", color: "var(--swim)", values: sleep, kind: "bars" },
        ],
        reference: 60,
        domain: [0, 100],
        format: (v) => String(Math.round(v)),
      });
    }
    return out;
  });

  const step = $derived(days.length > 1 ? plotWidth / (days.length - 1) : plotWidth);
  const x = (i: number) => M.left + i * step;
  const y = (p: Panel, v: number) =>
    M.top + plotHeight - ((v - p.domain[0]) / (p.domain[1] - p.domain[0])) * plotHeight;

  function linePath(p: Panel, values: (number | null)[]): string {
    let d = "";
    let pen = false;
    values.forEach((v, i) => {
      if (v === null) {
        pen = false;
        return;
      }
      d += `${pen ? "L" : "M"}${x(i).toFixed(1)},${y(p, v).toFixed(1)}`;
      pen = true;
    });
    return d;
  }

  function ticks(p: Panel): number[] {
    const [lo, hi] = p.domain;
    if (p.key === "acwr") return [1.0, 1.5].filter((t) => t > lo && t < hi);
    if (p.key === "sleep") return [50, 100];
    const raw = (hi - lo) / 2;
    const mag = 10 ** Math.floor(Math.log10(raw));
    const niceStep = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw) ?? raw;
    const out: number[] = [];
    for (let t = Math.ceil(lo / niceStep) * niceStep; t < hi; t += niceStep) out.push(t);
    return out;
  }

  // Month starts (and the plan's start) along the bottom.
  const xLabels = $derived(
    days
      .map((d, i) => ({ i, date: d.date }))
      .filter(({ date, i }) => date.endsWith("-01") || i === 0)
  );
  const planStartIndex = $derived(days.findIndex((d) => d.date === planStartDate));

  let hoverIndex = $state<number | null>(null);
  function onPointer(e: PointerEvent) {
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const i = Math.round((e.clientX - rect.left - M.left) / (step || 1));
    hoverIndex = Math.max(0, Math.min(days.length - 1, i));
  }

  const hover = $derived.by(() => {
    if (hoverIndex === null) return null;
    const d = days[hoverIndex];
    const rows: { label: string; color: string; value: string }[] = [];
    for (const p of panels) {
      for (const s of p.series) {
        const v = s.values[hoverIndex];
        rows.push({
          label: p.series.length > 1 ? `${p.title} · ${s.label}` : p.title,
          color: s.color,
          value: v === null ? "–" : `${p.format(v)}${p.unit && p.key === "hrv" ? " ms" : ""}`,
        });
      }
    }
    if (d.hrvStatus)
      rows.push({ label: "HRV status", color: "transparent", value: titleCase(d.hrvStatus) });
    if (d.readiness !== null)
      rows.push({ label: "Readiness", color: "transparent", value: String(d.readiness) });
    return { left: x(hoverIndex), date: d.date, rows };
  });
</script>

<section class="load-panel" aria-label="Load and recovery">
  <div class="head">
    <span class="title">Load &amp; recovery</span>
    <button class="toggle" onclick={toggle} aria-expanded={open}>
      {open ? "Hide charts" : "Show charts"}
    </button>
  </div>

  {#if tiles.length > 0}
    <div class="tiles">
      {#each tiles as tile (tile.label)}
        <div class="tile">
          <div class="tile-label">{tile.label}</div>
          <div class="tile-value">{tile.value}</div>
          {#if tile.sub}<div class="tile-sub">{tile.sub}</div>{/if}
        </div>
      {/each}
    </div>
  {/if}

  {#if signals.length > 0}
    <div class="signals" role="status">
      <ul>
        {#each signals as s (s.key)}
          <li>⚠ {s.text}</li>
        {/each}
      </ul>
      <button onclick={askCoach}>Ask the coach</button>
    </div>
  {/if}

  {#if open}
    <div class="charts" bind:clientWidth={width}>
      {#if width > 0 && panels.length > 0}
        {#each panels as p (p.key)}
          <div class="panel">
            <div class="panel-title">
              {p.title}
              {#if p.unit}<span class="unit">{p.unit}</span>{/if}
              {#if p.series.length > 1}
                {#each p.series as s (s.key)}
                  <span class="legend"
                    ><span class="swatch" class:dot={s.kind === "dots"} style:background={s.color}
                    ></span>{s.label}</span
                  >
                {/each}
              {/if}
            </div>
            <svg
              {width}
              height={PANEL_HEIGHT}
              role="img"
              aria-label="{p.title}, day by day"
              onpointermove={onPointer}
              onpointerdown={onPointer}
              onpointerleave={() => (hoverIndex = null)}
            >
              {#if p.band}
                {@const top = y(p, Math.min(p.band[1], p.domain[1]))}
                {@const bottom = y(p, Math.max(p.band[0], p.domain[0]))}
                <rect
                  class="band"
                  x={M.left}
                  y={top}
                  width={plotWidth}
                  height={Math.max(0, bottom - top)}
                />
              {/if}
              {#each ticks(p) as t (t)}
                <line class="grid" x1={M.left} x2={M.left + plotWidth} y1={y(p, t)} y2={y(p, t)} />
                <text class="axis" x={M.left - 6} y={y(p, t) + 3} text-anchor="end"
                  >{p.format(t)}</text
                >
              {/each}
              {#if p.reference !== undefined && p.reference > p.domain[0] && p.reference < p.domain[1]}
                <line
                  class="reference"
                  x1={M.left}
                  x2={M.left + plotWidth}
                  y1={y(p, p.reference)}
                  y2={y(p, p.reference)}
                />
              {/if}
              {#if planStartIndex > 0}
                <line
                  class="plan-start"
                  x1={x(planStartIndex)}
                  x2={x(planStartIndex)}
                  y1={M.top}
                  y2={M.top + plotHeight}
                />
              {/if}

              {#each p.series as s (s.key)}
                {#if s.kind === "line"}
                  <path class="line" d={linePath(p, s.values)} style:stroke={s.color} />
                {:else if s.kind === "dots"}
                  {#each s.values as v, i (i)}
                    {#if v !== null}
                      <circle class="dot" cx={x(i)} cy={y(p, v)} r="2" style:fill={s.color} />
                    {/if}
                  {/each}
                {:else}
                  {@const barWidth = Math.max(1, Math.min(8, step - 2))}
                  {#each s.values as v, i (i)}
                    {#if v !== null}
                      <rect
                        class="bar"
                        x={x(i) - barWidth / 2}
                        y={y(p, v)}
                        width={barWidth}
                        height={Math.max(0, M.top + plotHeight - y(p, v))}
                        style:fill={s.color}
                        rx="1"
                      />
                    {/if}
                  {/each}
                {/if}
              {/each}

              {#if hover}
                <line
                  class="crosshair"
                  x1={hover.left}
                  x2={hover.left}
                  y1={M.top}
                  y2={M.top + plotHeight}
                />
              {/if}
            </svg>
          </div>
        {/each}

        <svg class="x-axis" {width} height="16" aria-hidden="true">
          {#each xLabels as l (l.i)}
            <text class="axis" x={x(l.i)} y="11" text-anchor={l.i === 0 ? "start" : "middle"}
              >{shortDate(l.date)}</text
            >
          {/each}
          {#if planStartIndex > 0}
            <text class="axis plan-label" x={x(planStartIndex) + 3} y="11">plan starts</text>
          {/if}
        </svg>

        {#if hover}
          <div class="tooltip" class:flip={hover.left > width / 2} style:left="{hover.left}px">
            <div class="tooltip-heading">{shortDate(hover.date)}</div>
            {#each hover.rows as row (row.label)}
              <div class="tooltip-row">
                <span class="swatch" style:background={row.color}></span>
                <span class="tooltip-name">{row.label}</span>
                <span class="tooltip-value">{row.value}</span>
              </div>
            {/each}
          </div>
        {/if}

        <p class="note">
          ACWR shaded 0.8–1.3 (the usual safe range); above 1.5, load is rising faster than the body
          adapts. Sleep line at 60. Dashed vertical line: the plan's start.
        </p>
      {:else if panels.length === 0}
        <p class="note">No load or recovery data synced from Garmin yet.</p>
      {/if}
    </div>
  {/if}
</section>

<style>
  .load-panel {
    background: var(--bg-secondary);
    border: 1px solid var(--border-subtle);
    border-radius: 16px;
    padding: 0.9rem 1.25rem 1rem;
    margin-bottom: 1.5rem;
  }

  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
  }

  .toggle {
    padding: 0.3rem 0.7rem;
    border-radius: 999px;
    border: 1px solid var(--border-medium);
    background: transparent;
    color: var(--text-primary);
    font-size: 0.75rem;
  }

  .toggle:hover {
    background: var(--bg-tertiary);
  }

  .title {
    font-size: 0.75rem;
    text-transform: uppercase;
    letter-spacing: 0.05em;
    color: var(--text-muted);
  }

  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(110px, 1fr));
    gap: 0.5rem;
    margin-top: 0.6rem;
  }

  .tile {
    background: var(--bg-tertiary);
    border-radius: 10px;
    padding: 0.55rem 0.7rem;
  }

  .tile-label {
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--text-muted);
  }

  .tile-value {
    font-family: "JetBrains Mono", monospace;
    font-size: 1.05rem;
    font-weight: 600;
    margin-top: 0.1rem;
  }

  .tile-sub {
    font-size: 0.72rem;
    color: var(--text-secondary);
  }

  .signals {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: 0.5rem 1rem;
    margin-top: 0.75rem;
    padding: 0.6rem 0.8rem;
    border-radius: 10px;
    border: 1px solid var(--accent);
    background: var(--accent-glow);
    font-size: 0.82rem;
  }

  .signals ul {
    list-style: none;
    margin: 0;
    padding: 0;
  }

  .signals button {
    padding: 0.4rem 0.8rem;
    border-radius: 8px;
    border: none;
    background: var(--accent);
    color: var(--bg-primary);
    font-weight: 600;
    font-size: 0.8rem;
  }

  .charts {
    position: relative;
    margin-top: 0.9rem;
  }

  .panel-title {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.3rem 0.8rem;
    font-size: 0.75rem;
    color: var(--text-secondary);
    margin: 0.4rem 0 0.1rem;
  }

  .unit {
    color: var(--text-muted);
  }

  .legend {
    display: inline-flex;
    align-items: center;
    gap: 0.3rem;
    color: var(--text-muted);
  }

  .swatch {
    display: inline-block;
    width: 10px;
    height: 2px;
    border-radius: 1px;
  }

  .swatch.dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
  }

  svg {
    display: block;
    touch-action: pan-y;
  }

  .band {
    fill: var(--bike-glow);
  }

  .grid {
    stroke: var(--border-subtle);
  }

  .reference {
    stroke: var(--text-muted);
    stroke-dasharray: 4 4;
  }

  .plan-start {
    stroke: var(--border-medium);
    stroke-dasharray: 2 3;
  }

  .axis {
    fill: var(--text-muted);
    font-size: 10px;
  }

  .plan-label {
    fill: var(--text-muted);
  }

  .line {
    fill: none;
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  .crosshair {
    stroke: var(--text-muted);
    stroke-width: 1;
  }

  .tooltip {
    position: absolute;
    top: 1.5rem;
    transform: translateX(12px);
    background: var(--bg-elevated);
    border: 1px solid var(--border-medium);
    border-radius: 8px;
    padding: 0.4rem 0.6rem;
    font-size: 0.75rem;
    pointer-events: none;
    white-space: nowrap;
    box-shadow: 0 4px 16px rgba(0, 0, 0, 0.25);
    z-index: 2;
  }

  .tooltip.flip {
    transform: translateX(calc(-100% - 12px));
  }

  .tooltip-heading {
    color: var(--text-secondary);
    margin-bottom: 0.15rem;
  }

  .tooltip-row {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }

  .tooltip-row .swatch {
    width: 8px;
    height: 8px;
    border-radius: 2px;
  }

  .tooltip-name {
    color: var(--text-muted);
    flex: 1;
  }

  .tooltip-value {
    font-family: "JetBrains Mono", monospace;
    margin-left: 0.6rem;
  }

  .note {
    margin-top: 0.5rem;
    font-size: 0.72rem;
    color: var(--text-muted);
  }

  @media (max-width: 800px) {
    .load-panel {
      padding: 0.8rem 0.9rem;
      border-radius: 12px;
      margin-bottom: 1rem;
    }

    .toggle {
      min-height: 36px;
    }

    .tiles {
      grid-template-columns: repeat(3, 1fr);
      gap: 0.4rem;
    }

    .tile {
      padding: 0.45rem 0.55rem;
    }

    .tile-value {
      font-size: 0.95rem;
    }

    .signals button {
      min-height: 40px;
    }
  }
</style>
