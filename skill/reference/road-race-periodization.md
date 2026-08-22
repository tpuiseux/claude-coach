# Road Race Periodization: 5K / 10K / Half Marathon / Marathon

Source: adapted from ColinEberhardt/claude-running-coach (MIT). This file complements
`periodization.md` (which covers generic multisport phase structure) with **road-race-specific**
depth: pace zones defined by physiology, distance-specific emphases, and ready-to-use weekly
templates. Use this file when the athlete's goal race is a road 5K, 10K, half marathon, or
marathon. For triathlon/multisport athletes, `periodization.md` remains the primary reference.

**Trail note:** for trail races, treat "Threshold" and "VO2max" targets as effort/HR-based
rather than pace-based (terrain and vert make pace unreliable), and give the long run extra
priority for vertical gain and time-on-feet over distance. See `workouts.md` for
trail-specific adaptations.

**Zone system note:** the letter codes below (E, LR, S, T, I, R, RP) are one of three overlapping
ways this skill describes intensity. See the "Reconciling the Zone Systems" table in `zones.md`
for how they map onto the Friel HR zones and Daniels/VDOT pace zones used elsewhere.

---

## Training Zones (Pace-Based)

| Zone | Name                       | RPE                                          | Purpose                                                                                            |
| ---- | -------------------------- | -------------------------------------------- | -------------------------------------------------------------------------------------------------- |
| E    | Easy / Recovery            | 2-4/10, conversational                       | Aerobic development, recovery, bulk of volume (80-90% of weekly load)                              |
| LR   | Long Run                   | mostly E, sometimes with controlled segments | Durability, glycogen management; key specificity lever for HM/Marathon                             |
| S    | Steady / Aerobic Endurance | 4-5/10, controlled                           | Aerobic strength; use carefully with newer athletes (common error: "moderately hard all the time") |
| T    | Threshold / Tempo          | 6-7/10, short phrases only                   | Raise sustainable speed. Formats: continuous tempo 20-40min, cruise intervals 4-8x5min             |
| I    | VO2max / Interval          | 8-9/10, hard but repeatable                  | Aerobic power, speed endurance. Formats: 3-6min reps, hill reps, track intervals                   |
| R    | Repetition / Speed         | fast, crisp, generous recovery               | Neuromuscular power, economy. Formats: 100-400m, hill sprints, strides                             |
| RP   | Race Pace                  | goal-specific                                | Pacing rehearsal, mental familiarity                                                               |

Calculate paces for a given goal time with:

```bash
python3 scripts/calculate_paces.py --distance 42.195 --time 3:30:00 --per-km
```

## Weekly Architecture (Microcycle)

Frequency of hard sessions by level:

- **Novice / injury-prone:** 1 quality session + easy long run
- **Intermediate:** 2 quality days + long run
- **Advanced:** 2 quality + long run with quality segments; occasionally a 3rd stimulus day if robust

Never schedule true hard sessions back-to-back; separate with easy days.

## Distance-Specific Emphasis

**5K** — aerobic power, speed-endurance, economy. Threshold work still helps; add VO2max/5K-pace
intervals (6-12 x 400-1000m) in the specific phase. Long run present but not dominant.

**10K** — threshold strength is the primary driver. Cruise intervals (5-8min reps), 10K-pace reps
(1-2K repeats). Medium-long run becomes useful.

**Half Marathon** — threshold durability + aerobic volume. Long run becomes a major lever,
including HM-pace segments (2-3 x 15-20min at HM effort). Fueling practice begins.

**Marathon** — aerobic volume + marathon-pace durability + fueling. MP blocks inside long runs
(2 x 20-40min MP), medium-long runs with MP segments. Fueling/hydration is itself a "workout."
Threshold remains present but less frequent than for 10K/HM.

## Typical Plan Lengths

- **8 weeks** — short build, assumes existing base. Weeks 1-2 stabilize, 3-6 build, 7-8 sharpen/taper.
- **10-12 weeks** — standard 5K/10K, workable HM with existing base.
- **12-16 weeks** — standard HM, minimum practical marathon for experienced athletes.
- **16-20 weeks** — standard marathon, or a full HM rebuild from a low base.

## Common Design Errors to Avoid

1. Too much "gray zone" moderate running — enforce truly easy easy days.
2. Every long run becomes a test — alternate easy-long with quality-long; respect deload weeks.
3. Workouts don't match event demands — increase specificity as race approaches.
4. Intensity stacked without recovery — separate hard days, include deloads (~15-30% volume cut).
5. Taper too big or not real — reduce volume, maintain frequency and short intensity touches.
