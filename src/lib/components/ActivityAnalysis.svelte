<script lang="ts">
  import { base } from "$app/paths";
  import type { HrZone, Settings } from "../settings.js";
  import { activitySport, type RecordedActivity } from "../trainingLog.js";
  import { formatDistance } from "../utils.js";
  import {
    aerobicDecoupling,
    downsampleIndices,
    formatClock,
    formatSpeed,
    formatSpeedValue,
    isPaceDisplay,
    movingSpeed,
    smoothByTime,
    speedDisplay,
    speedUnit,
    speedValue,
    timeInZones,
    type ActivityAnalysis,
  } from "../activityAnalysis.js";

  interface Props {
    activity: RecordedActivity;
    settings: Settings;
  }

  let { activity, settings }: Props = $props();

  let analysis = $state<ActivityAnalysis | null>(null);
  let loadError = $state<string | null>(null);

  $effect(() => {
    const id = activity.id;
    analysis = null;
    loadError = null;
    const controller = new AbortController();
    fetch(`${base}/activities/${id}/details`, { signal: controller.signal })
      .then(async (res) => {
        const data = await res.json().catch(() => null);
        if (!res.ok) throw new Error(data?.message ?? `Couldn't load the activity (${res.status})`);
        analysis = data as ActivityAnalysis;
      })
      .catch((err) => {
        if (controller.signal.aborted) return;
        loadError = err instanceof Error ? err.message : "Couldn't load the activity.";
      });
    return () => controller.abort();
  });

  const sport = $derived(activitySport(activity.sportType));
  const display = $derived(speedDisplay(sport, settings));
  const distanceUnit = $derived(sport === "bike" ? settings.units.bike : settings.units.run);
  const hrZones = $derived(sport === "bike" ? settings.bike.hrZones : settings.run.hrZones);

  // --- Derived series -------------------------------------------------------

  const KM_PER_MILE = 1.60934;
  const MAX_POINTS = 600;

  interface Prepared {
    /** x per point: distance (km/mi) or minutes. */
    x: number[];
    xLabel: "distance" | "time";
    time: (number | null)[];
    speed: (number | null)[]; // display units (s per unit, or km/h | mph)
    heartrate: (number | null)[];
    altitude: (number | null)[];
    power: (number | null)[];
    distance: (number | null)[]; // m
  }

  const prepared = $derived.by((): Prepared | null => {
    const s = analysis?.series;
    const time = s?.time;
    if (!s || !time || time.length < 2) return null;

    const lastDistance = [...(s.distance ?? [])].reverse().find((v) => v !== null) ?? 0;
    const byDistance = lastDistance > 200 && sport !== "swim" && sport !== "strength";
    const perUnit = distanceUnit === "miles" ? 1000 * KM_PER_MILE : 1000;

    const smoothedSpeed = s.speed
      ? smoothByTime(movingSpeed(s.speed, sport), time, sport === "bike" ? 20 : 30)
      : [];
    const smoothedPower = s.power ? smoothByTime(s.power, time, 30) : [];

    const keep = downsampleIndices(time.length, MAX_POINTS);
    const pick = <T,>(arr: T[] | undefined) => keep.map((i) => arr?.[i] ?? null);

    let lastX = 0;
    const x = keep.map((i) => {
      const raw = byDistance ? s.distance?.[i] : time[i];
      if (raw !== null && raw !== undefined) lastX = byDistance ? raw / perUnit : raw / 60;
      return lastX;
    });

    return {
      x,
      xLabel: byDistance ? "distance" : "time",
      time: pick(time),
      distance: pick(s.distance),
      speed: pick(smoothedSpeed).map((v) => (v !== null ? speedValue(v, display) : null)),
      heartrate: pick(s.heartrate),
      altitude: pick(s.altitude),
      power: pick(smoothedPower),
    };
  });

  const zoneSeconds = $derived(
    analysis?.series.time && analysis.series.heartrate
      ? timeInZones(analysis.series.time, analysis.series.heartrate, hrZones)
      : null
  );
  const zoneTotal = $derived(zoneSeconds?.reduce((a, b) => a + b, 0) ?? 0);

  const decoupling = $derived(
    analysis?.series.time && analysis.series.speed && analysis.series.heartrate && sport !== "swim"
      ? aerobicDecoupling(
          analysis.series.time,
          movingSpeed(analysis.series.speed, sport),
          analysis.series.heartrate
        )
      : null
  );

  // --- Chart geometry -------------------------------------------------------

  const M = { top: 8, right: 30, bottom: 4, left: 44 };
  const PANEL_HEIGHT = 120;
  let chartWidth = $state(0);
  const plotWidth = $derived(Math.max(0, chartWidth - M.left - M.right));
  const plotHeight = PANEL_HEIGHT - M.top - M.bottom;

  interface Panel {
    key: "speed" | "heartrate" | "power" | "altitude";
    title: string;
    unit: string;
    color: string;
    values: (number | null)[];
    domain: [number, number];
    /** Faster pace is a smaller number: draw it at the top. */
    inverted: boolean;
    ticks: number[];
    format: (v: number) => string;
    average: number | null;
    area: boolean;
  }

  function quantile(sorted: number[], q: number): number {
    const pos = (sorted.length - 1) * q;
    const lo = Math.floor(pos);
    const hi = Math.ceil(pos);
    return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo);
  }

  /** ~count ticks at round steps within [min, max]. */
  function niceTicks(min: number, max: number, count: number, steps: number[]): number[] {
    const span = max - min;
    if (!(span > 0)) return [min];
    const raw = span / count;
    const step = steps.find((s) => s >= raw) ?? steps[steps.length - 1];
    const ticks: number[] = [];
    for (let v = Math.ceil(min / step) * step; v <= max + 1e-9; v += step) ticks.push(v);
    return ticks;
  }

  const DECIMAL_STEPS = [0.1, 0.2, 0.25, 0.5, 1, 2, 2.5, 5, 10, 20, 25, 50, 100, 200, 250, 500];
  const PACE_STEPS = [5, 10, 15, 20, 30, 60, 120, 300, 600];

  function domainOf(
    values: (number | null)[],
    robust: boolean,
    minSpan: number
  ): [number, number] | null {
    const sorted = values.filter((v): v is number => v !== null).sort((a, b) => a - b);
    if (sorted.length < 2) return null;
    // Pace and power: ignore the few most extreme points (a GPS glitch, a
    // sprint to the crossing) so the range fits what was actually held.
    let lo = robust ? quantile(sorted, 0.02) : sorted[0];
    let hi = robust ? quantile(sorted, 0.98) : sorted[sorted.length - 1];
    if (hi - lo < minSpan) {
      const mid = (hi + lo) / 2;
      lo = mid - minSpan / 2;
      hi = mid + minSpan / 2;
    }
    const pad = (hi - lo) * 0.08;
    return [lo - pad, hi + pad];
  }

  const panels = $derived.by((): Panel[] => {
    if (!prepared || !analysis) return [];
    const out: Panel[] = [];
    const stats = analysis.stats;
    const sportColor = `var(--${sport ?? "run"})`;

    const speedDomain = domainOf(prepared.speed, true, isPaceDisplay(display) ? 20 : 2);
    if (speedDomain) {
      const pace = isPaceDisplay(display);
      out.push({
        key: "speed",
        title: pace ? "Pace" : "Speed",
        unit: speedUnit(display),
        color: sportColor,
        values: prepared.speed,
        domain: speedDomain,
        inverted: pace,
        ticks: niceTicks(speedDomain[0], speedDomain[1], 3, pace ? PACE_STEPS : DECIMAL_STEPS),
        format: (v) => formatSpeedValue(v, display),
        average: stats.averageSpeed ? speedValue(stats.averageSpeed, display) : null,
        area: false,
      });
    }

    const hrDomain = domainOf(prepared.heartrate, false, 20);
    if (hrDomain) {
      out.push({
        key: "heartrate",
        title: "Heart rate",
        unit: "bpm",
        color: "var(--hr)",
        values: prepared.heartrate,
        domain: hrDomain,
        inverted: false,
        ticks: niceTicks(hrDomain[0], hrDomain[1], 3, DECIMAL_STEPS),
        format: (v) => String(Math.round(v)),
        average: stats.averageHeartrate,
        area: false,
      });
    }

    const powerDomain = sport === "bike" ? domainOf(prepared.power, true, 40) : null;
    if (powerDomain) {
      out.push({
        key: "power",
        title: "Power",
        unit: "W",
        color: "var(--bike-dark)",
        values: prepared.power,
        domain: powerDomain,
        inverted: false,
        ticks: niceTicks(powerDomain[0], powerDomain[1], 3, DECIMAL_STEPS),
        format: (v) => String(Math.round(v)),
        average: stats.averagePower,
        area: false,
      });
    }

    // Altitude only when there's relief to speak of - a flat line is noise.
    const altDomain = domainOf(prepared.altitude, false, 30);
    const altValues = prepared.altitude.filter((v): v is number => v !== null);
    if (altDomain && Math.max(...altValues) - Math.min(...altValues) >= 15) {
      out.push({
        key: "altitude",
        title: "Elevation",
        unit: "m",
        color: "var(--text-muted)",
        values: prepared.altitude,
        domain: altDomain,
        inverted: false,
        ticks: niceTicks(altDomain[0], altDomain[1], 3, DECIMAL_STEPS),
        format: (v) => String(Math.round(v)),
        average: null,
        area: true,
      });
    }
    return out;
  });

  const xMax = $derived(prepared ? prepared.x[prepared.x.length - 1] || 1 : 1);
  const xTicks = $derived(
    prepared
      ? niceTicks(
          0,
          xMax,
          Math.max(2, Math.floor(plotWidth / 70)),
          prepared.xLabel === "time" ? [5, 10, 15, 20, 30, 60, 120] : DECIMAL_STEPS
        )
      : []
  );

  const xScale = (v: number) => M.left + (v / xMax) * plotWidth;
  function yScale(panel: Panel, v: number): number {
    const [lo, hi] = panel.domain;
    const clamped = Math.min(hi, Math.max(lo, v));
    const t = (clamped - lo) / (hi - lo);
    return M.top + (panel.inverted ? t : 1 - t) * plotHeight;
  }

  function linePath(panel: Panel): string {
    if (!prepared) return "";
    let d = "";
    let drawing = false;
    panel.values.forEach((v, i) => {
      if (v === null) {
        drawing = false;
        return;
      }
      d += `${drawing ? "L" : "M"}${xScale(prepared.x[i]).toFixed(1)},${yScale(panel, v).toFixed(1)}`;
      drawing = true;
    });
    return d;
  }

  function areaPath(panel: Panel): string {
    if (!prepared) return "";
    const pts = panel.values
      .map((v, i) => (v === null ? null : [xScale(prepared.x[i]), yScale(panel, v)]))
      .filter((p): p is number[] => p !== null);
    if (pts.length < 2) return "";
    const bottom = M.top + plotHeight;
    return (
      `M${pts[0][0].toFixed(1)},${bottom}` +
      pts.map(([x, y]) => `L${x.toFixed(1)},${y.toFixed(1)}`).join("") +
      `L${pts[pts.length - 1][0].toFixed(1)},${bottom}Z`
    );
  }

  function zoneLabel(zone: HrZone, i: number): string {
    return `Z${zone.label ?? (Number.isFinite(zone.zone) ? zone.zone : i + 1)}`;
  }

  /** HR zone bands visible in the heart-rate panel's range. */
  function zoneBands(panel: Panel) {
    const [lo, hi] = panel.domain;
    return hrZones
      .map((z, i) => ({
        index: i,
        label: zoneLabel(z, i),
        // From the previous zone's top, so bands meet even where the plan's
        // bounds leave a 1 bpm gap (142 / 143).
        low: Math.max(lo, i === 0 ? lo : hrZones[i - 1].high),
        high: Math.min(hi, i === hrZones.length - 1 ? hi : z.high),
      }))
      .filter((b) => b.high > b.low);
  }

  function formatX(v: number): string {
    if (!prepared) return "";
    if (prepared.xLabel === "time") return formatClock(v * 60);
    return `${v.toFixed(v >= 10 ? 0 : 1)}`;
  }
  const xUnit = $derived(prepared?.xLabel === "time" ? "" : distanceUnit === "miles" ? "mi" : "km");

  // --- Hover ----------------------------------------------------------------

  let hoverIndex = $state<number | null>(null);
  /** Pointer height within the charts block - the tooltip follows it. */
  let hoverY = $state(0);
  let chartsEl = $state<HTMLDivElement | null>(null);

  function handlePointer(e: PointerEvent) {
    if (!prepared) return;
    const rect = (e.currentTarget as SVGElement).getBoundingClientRect();
    const xValue = ((e.clientX - rect.left - M.left) / plotWidth) * xMax;
    // x is monotonic: binary search for the nearest point.
    const xs = prepared.x;
    let lo = 0;
    let hi = xs.length - 1;
    while (hi - lo > 1) {
      const mid = (lo + hi) >> 1;
      if (xs[mid] < xValue) lo = mid;
      else hi = mid;
    }
    hoverIndex = Math.abs(xs[lo] - xValue) <= Math.abs(xs[hi] - xValue) ? lo : hi;
    if (chartsEl) hoverY = e.clientY - chartsEl.getBoundingClientRect().top;
  }

  const hover = $derived.by(() => {
    if (hoverIndex === null || !prepared) return null;
    const i = hoverIndex;
    const time = prepared.time[i];
    const dist = prepared.distance[i];
    return {
      left: xScale(prepared.x[i]),
      heading: [
        dist !== null && sport ? formatDistance(dist, sport, settings) : "",
        time !== null ? formatClock(time) : "",
      ]
        .filter(Boolean)
        .join(" · "),
      rows: panels.map((p) => ({
        title: p.title,
        color: p.color,
        value:
          p.values[i] !== null ? `${p.format(p.values[i]!)} ${p.unit}`.replace(" /", "/") : "–",
      })),
    };
  });

  // --- Stats & laps ---------------------------------------------------------

  function trainingEffectText(label: string | null): string {
    if (!label) return "";
    return label
      .toLowerCase()
      .split("_")
      .map((w, i) => (i === 0 ? w[0].toUpperCase() + w.slice(1) : w))
      .join(" ");
  }

  const tiles = $derived.by(() => {
    if (!analysis) return [];
    const s = analysis.stats;
    const t: { label: string; value: string; sub?: string }[] = [];
    if (s.distanceMeters && sport)
      t.push({ label: "Distance", value: formatDistance(s.distanceMeters, sport, settings) });
    if (s.movingSeconds)
      t.push({
        label: "Moving time",
        value: formatClock(s.movingSeconds),
        sub:
          s.elapsedSeconds && s.elapsedSeconds - s.movingSeconds >= 60
            ? `${formatClock(s.elapsedSeconds)} elapsed`
            : undefined,
      });
    if (s.averageSpeed && sport !== "strength")
      t.push({
        label: isPaceDisplay(display) ? "Avg pace" : "Avg speed",
        value: formatSpeed(s.averageSpeed, display),
        sub: s.maxSpeed ? `best ${formatSpeed(s.maxSpeed, display)}` : undefined,
      });
    if (s.averageHeartrate)
      t.push({
        label: "Avg HR",
        value: `${Math.round(s.averageHeartrate)} bpm`,
        sub: s.maxHeartrate ? `max ${Math.round(s.maxHeartrate)}` : undefined,
      });
    if (s.elevationGain && s.elevationGain >= 1)
      t.push({ label: "Elevation", value: `+${Math.round(s.elevationGain)} m` });
    if (s.averageCadence)
      t.push({
        label: "Cadence",
        value: `${Math.round(s.averageCadence)} ${sport === "bike" ? "rpm" : "spm"}`,
      });
    if (s.averagePower)
      t.push({
        label: "Power",
        value: `${Math.round(s.averagePower)} W`,
        sub: s.normalizedPower ? `NP ${Math.round(s.normalizedPower)} W` : undefined,
      });
    if (s.aerobicEffect !== null)
      t.push({
        label: "Training effect",
        value: `${s.aerobicEffect.toFixed(1)} / ${(s.anaerobicEffect ?? 0).toFixed(1)}`,
        sub: ["aerobic / anaerobic", trainingEffectText(s.trainingEffectLabel)]
          .filter(Boolean)
          .join(" · "),
      });
    if (s.trainingLoad !== null)
      t.push({ label: "Load", value: String(Math.round(s.trainingLoad)) });
    if (decoupling !== null)
      t.push({
        label: "HR drift",
        value: `${decoupling >= 0 ? "+" : ""}${decoupling.toFixed(1)}%`,
        sub: decoupling < 5 ? "steady (< 5%)" : "heart worked harder late on",
      });
    return t;
  });

  const laps = $derived(analysis?.laps.filter((l) => (l.duration ?? 0) >= 5) ?? []);
  const lapSpeeds = $derived(
    // A lap's leftover metres at the end (52 m to the watch's stop) isn't a
    // contender for fastest: its pace is a few seconds' worth of noise.
    laps.map((l) =>
      l.averageSpeed && l.intensityType !== "REST" && (l.duration ?? 0) >= 60
        ? l.averageSpeed
        : null
    )
  );
  const fastestLap = $derived.by(() => {
    const valid = lapSpeeds.filter((v): v is number => v !== null);
    return valid.length > 1 ? Math.max(...valid) : null;
  });
  const showLapCadence = $derived(laps.some((l) => l.averageCadence));
  const showLapPower = $derived(sport === "bike" && laps.some((l) => l.averagePower));
</script>

<div class="analysis">
  {#if loadError}
    <p class="analysis-note error">{loadError}</p>
  {:else if !analysis}
    <p class="analysis-note">Loading the session's details…</p>
  {:else}
    <div class="tiles">
      {#each tiles as tile (tile.label)}
        <div class="tile">
          <div class="tile-label">{tile.label}</div>
          <div class="tile-value">{tile.value}</div>
          {#if tile.sub}<div class="tile-sub">{tile.sub}</div>{/if}
        </div>
      {/each}
    </div>

    {#if analysis.detailsError}
      <p class="analysis-note">Curves and laps unavailable: {analysis.detailsError}</p>
    {/if}

    {#if panels.length > 0 && prepared}
      <div class="charts" bind:clientWidth={chartWidth} bind:this={chartsEl}>
        {#if chartWidth > 0}
          {#each panels as panel (panel.key)}
            <div class="panel">
              <div class="panel-title">
                {panel.title} <span class="panel-unit">{panel.unit}</span>
              </div>
              <svg
                width={chartWidth}
                height={PANEL_HEIGHT}
                role="img"
                aria-label="{panel.title} over the session"
                onpointermove={handlePointer}
                onpointerdown={handlePointer}
                onpointerleave={() => (hoverIndex = null)}
              >
                {#if panel.key === "heartrate"}
                  {#each zoneBands(panel) as band (band.index)}
                    {@const y1 = yScale(panel, band.high)}
                    {@const y2 = yScale(panel, band.low)}
                    <rect
                      class="zone-band"
                      class:odd={band.index % 2 === 0}
                      x={M.left}
                      y={y1}
                      width={plotWidth}
                      height={Math.max(0, y2 - y1)}
                    />
                    {#if y2 - y1 >= 11}
                      <text class="zone-label" x={M.left + plotWidth + 4} y={(y1 + y2) / 2 + 3}
                        >{band.label}</text
                      >
                    {/if}
                  {/each}
                {/if}

                {#each panel.ticks as tick (tick)}
                  <line
                    class="grid"
                    x1={M.left}
                    x2={M.left + plotWidth}
                    y1={yScale(panel, tick)}
                    y2={yScale(panel, tick)}
                  />
                  <text
                    class="axis-label"
                    x={M.left - 6}
                    y={yScale(panel, tick) + 3}
                    text-anchor="end">{panel.format(tick)}</text
                  >
                {/each}

                {#if panel.area}
                  <path d={areaPath(panel)} class="area" />
                {:else}
                  <path d={linePath(panel)} class="line" style:stroke={panel.color} />
                {/if}

                {#if panel.average !== null && panel.average > panel.domain[0] && panel.average < panel.domain[1]}
                  <line
                    class="average"
                    x1={M.left}
                    x2={M.left + plotWidth}
                    y1={yScale(panel, panel.average)}
                    y2={yScale(panel, panel.average)}
                  />
                {/if}

                {#if hover}
                  {@const v = panel.values[hoverIndex!]}
                  <line
                    class="crosshair"
                    x1={hover.left}
                    x2={hover.left}
                    y1={M.top}
                    y2={M.top + plotHeight}
                  />
                  {#if v !== null}
                    <circle
                      class="hover-dot"
                      cx={hover.left}
                      cy={yScale(panel, v)}
                      r="4"
                      style:fill={panel.color}
                    />
                  {/if}
                {/if}
              </svg>
            </div>
          {/each}

          <svg class="x-axis" width={chartWidth} height="18" aria-hidden="true">
            {#each xTicks as tick (tick)}
              <text class="axis-label" x={xScale(tick)} y="12" text-anchor="middle"
                >{formatX(tick)}</text
              >
            {/each}
            <text class="axis-label" x={M.left + plotWidth + 4} y="12">{xUnit}</text>
          </svg>

          {#if hover}
            <div
              class="tooltip"
              class:flip={hover.left > chartWidth / 2}
              style:left="{hover.left}px"
              style:top="{Math.max(0, hoverY - 40)}px"
            >
              <div class="tooltip-heading">{hover.heading}</div>
              {#each hover.rows as row (row.title)}
                <div class="tooltip-row">
                  <span class="swatch" style:background={row.color}></span>
                  <span class="tooltip-name">{row.title}</span>
                  <span class="tooltip-value">{row.value}</span>
                </div>
              {/each}
            </div>
          {/if}
        {/if}
      </div>
      <p class="chart-note">
        {isPaceDisplay(display) ? "Pace" : "Speed"} smoothed over ~30 s · dashed line = session average
      </p>
    {/if}

    {#if zoneSeconds && zoneTotal > 0}
      <div class="subsection">
        <h5 class="subsection-title">Time in heart-rate zones</h5>
        <div class="zones">
          {#each hrZones as zone, i (i)}
            {@const pct = (zoneSeconds[i] / zoneTotal) * 100}
            <div class="zone-row">
              <span class="zone-name"
                >{zoneLabel(zone, i)} <span class="zone-sub">{zone.name}</span></span
              >
              <span class="zone-bar-track">
                <span
                  class="zone-bar"
                  style:width="{pct}%"
                  style:opacity={0.35 + (0.65 * i) / Math.max(1, hrZones.length - 1)}
                ></span>
              </span>
              <span class="zone-time">{formatClock(zoneSeconds[i])}</span>
              <span class="zone-pct">{Math.round(pct)}%</span>
            </div>
          {/each}
        </div>
        <p class="chart-note">
          Zones from the plan's settings ({sport === "bike" ? "bike" : "run"} HR zones)
        </p>
      </div>
    {/if}

    {#if laps.length > 1}
      <div class="subsection">
        <h5 class="subsection-title">Laps</h5>
        <div class="laps-scroll">
          <table class="laps">
            <thead>
              <tr>
                <th>#</th>
                <th>Dist</th>
                <th>Time</th>
                <th>{isPaceDisplay(display) ? "Pace" : "Speed"}</th>
                <th>HR</th>
                <th>Max</th>
                {#if showLapCadence}<th>Cad</th>{/if}
                {#if showLapPower}<th>W</th>{/if}
                <th>Elev</th>
              </tr>
            </thead>
            <tbody>
              {#each laps as lap, i (i)}
                <tr class:rest={lap.intensityType === "REST" || lap.intensityType === "RECOVERY"}>
                  <td class="muted">{i + 1}</td>
                  <td
                    >{lap.distance && sport
                      ? formatDistance(lap.distance, sport, settings)
                      : "–"}</td
                  >
                  <td>{lap.duration ? formatClock(lap.duration) : "–"}</td>
                  <td class:fastest={fastestLap !== null && lapSpeeds[i] === fastestLap}
                    >{formatSpeed(lap.averageSpeed, display)
                      .replace(speedUnit(display), "")
                      .trim()}</td
                  >
                  <td>{lap.averageHR ? Math.round(lap.averageHR) : "–"}</td>
                  <td class="muted">{lap.maxHR ? Math.round(lap.maxHR) : "–"}</td>
                  {#if showLapCadence}<td class="muted"
                      >{lap.averageCadence ? Math.round(lap.averageCadence) : "–"}</td
                    >{/if}
                  {#if showLapPower}<td>{lap.averagePower ? Math.round(lap.averagePower) : "–"}</td
                    >{/if}
                  <td class="muted"
                    >{lap.elevationGain !== undefined
                      ? `+${Math.round(lap.elevationGain)}`
                      : "–"}</td
                  >
                </tr>
              {/each}
            </tbody>
          </table>
        </div>
      </div>
    {/if}
  {/if}
</div>

<style>
  .analysis {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin-top: 0.75rem;
  }

  .analysis-note {
    font-size: 0.85rem;
    color: var(--text-muted);
  }

  .analysis-note.error {
    color: #ef4444;
  }

  .tiles {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(118px, 1fr));
    gap: 0.5rem;
  }

  .tile {
    background: var(--bg-tertiary);
    border-radius: 10px;
    padding: 0.55rem 0.7rem;
    min-width: 0;
  }

  .tile-label {
    font-size: 0.65rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
  }

  .tile-value {
    font-family: "JetBrains Mono", monospace;
    font-size: 1.05rem;
    color: var(--text-primary);
    white-space: nowrap;
  }

  .tile-sub {
    font-size: 0.7rem;
    color: var(--text-secondary);
    line-height: 1.3;
  }

  .charts {
    position: relative;
    width: 100%;
    touch-action: pan-y;
    user-select: none;
  }

  .panel + .panel {
    margin-top: 0.35rem;
  }

  .panel-title {
    font-size: 0.75rem;
    color: var(--text-secondary);
    padding-left: 44px;
  }

  .panel-unit {
    color: var(--text-muted);
  }

  svg {
    display: block;
    overflow: visible;
  }

  .grid {
    stroke: var(--border-subtle);
    stroke-width: 1;
  }

  .axis-label {
    font-family: "JetBrains Mono", monospace;
    font-size: 10px;
    fill: var(--text-muted);
  }

  .line {
    fill: none;
    stroke-width: 2;
    stroke-linejoin: round;
    stroke-linecap: round;
  }

  .area {
    fill: var(--text-muted);
    opacity: 0.25;
  }

  .average {
    stroke: var(--text-secondary);
    stroke-width: 1;
    stroke-dasharray: 4 4;
  }

  .zone-band {
    fill: var(--hr);
    opacity: 0.04;
  }

  .zone-band.odd {
    opacity: 0.09;
  }

  .zone-label {
    font-family: "JetBrains Mono", monospace;
    font-size: 9px;
    fill: var(--text-muted);
  }

  .crosshair {
    stroke: var(--text-secondary);
    stroke-width: 1;
  }

  .hover-dot {
    stroke: var(--bg-secondary);
    stroke-width: 2;
  }

  /* Beside the crosshair, on whichever side has room. */
  .tooltip {
    position: absolute;
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

  .swatch {
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
    color: var(--text-primary);
  }

  .chart-note {
    font-size: 0.7rem;
    color: var(--text-muted);
    margin-top: 0.25rem;
  }

  .subsection-title {
    font-size: 0.7rem;
    text-transform: uppercase;
    letter-spacing: 0.08em;
    color: var(--text-muted);
    font-weight: 500;
    margin-bottom: 0.5rem;
  }

  .zones {
    display: flex;
    flex-direction: column;
    gap: 0.3rem;
  }

  .zone-row {
    display: grid;
    grid-template-columns: minmax(80px, 9rem) 1fr 3.6rem 2.4rem;
    align-items: center;
    gap: 0.5rem;
    font-size: 0.8rem;
  }

  .zone-name {
    color: var(--text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
  }

  .zone-sub {
    color: var(--text-muted);
  }

  .zone-bar-track {
    height: 10px;
    background: var(--bg-tertiary);
    border-radius: 4px;
    overflow: hidden;
  }

  .zone-bar {
    display: block;
    height: 100%;
    background: var(--hr);
    border-radius: 0 4px 4px 0;
  }

  .zone-time,
  .zone-pct {
    font-family: "JetBrains Mono", monospace;
    font-size: 0.75rem;
    color: var(--text-secondary);
    text-align: right;
  }

  .laps-scroll {
    overflow-x: auto;
  }

  .laps {
    width: 100%;
    border-collapse: collapse;
    font-family: "JetBrains Mono", monospace;
    font-size: 0.78rem;
  }

  .laps th {
    font-family: "Outfit", sans-serif;
    font-weight: 500;
    font-size: 0.68rem;
    text-transform: uppercase;
    letter-spacing: 0.06em;
    color: var(--text-muted);
    text-align: right;
    padding: 0.3rem 0.4rem;
    border-bottom: 1px solid var(--border-medium);
  }

  .laps td {
    text-align: right;
    padding: 0.3rem 0.4rem;
    border-bottom: 1px solid var(--border-subtle);
    color: var(--text-primary);
    white-space: nowrap;
  }

  .laps th:first-child,
  .laps td:first-child {
    text-align: left;
  }

  .laps .muted {
    color: var(--text-muted);
  }

  .laps tr.rest td {
    color: var(--text-muted);
  }

  .laps td.fastest {
    color: var(--accent);
    font-weight: 600;
  }
</style>
