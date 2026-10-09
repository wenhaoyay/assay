# Design rules

Assay is a bench instrument that writes a lab report. The body is calm and exact: figures in
monospace, one signal colour (teal), colour otherwise only where it means something. The verdicts
read like the headline of a report. The needle is the one signature.

These rules keep every screen in one voice. They are enforced by review, not by a linter.

## Help, never subtitles

A heading carries its title, a circled **?**, and its controls. Nothing else.

- What a section shows, how to use it and any caveat go in the **?** (`<Help>`, or the `help` /
  `subtitle` prop of `Card`, `PageHeader` and `Stat`). Grey subtitles beside headings read as
  clutter; do not add them.
- Help text is plain sentences: what it shows; how to use it (drag, click, keys); a caveat (small
  sample, heuristic judge, synthetic data). Use `<p>` per paragraph.
- What stays visible: legends (the key to the colours), sample sizes (`<SampleSize n={58} />`),
  figures, and readouts that change as you interact.
- `Card` is a section (a heading over a rule). Use `boxed` only when the content needs a panel:
  forms, cards in a grid, side panels.

## Type: one face per job

| Role | Face | Size · weight | Class |
|---|---|---|---|
| Page title | Instrument Serif | 36 · 400 | `t-title` (via `PageHeader`) |
| Verdict | Instrument Serif | 26 · 400 | `t-verdict` |
| Section heading | Geist | 18 · 600 | `text-h font-semibold` (via `Card`) |
| Readout | Geist | 16 · 500 | `t-readout` |
| Lead (questions, answers) | Geist | 16 · 400 | `text-lead` |
| Body | Geist | 14 · 400 | `text-base` (default) |
| Secondary (meta, table cells) | Geist | 13 · 400 | `text-sm` |
| Small (chips, small buttons, legends) | Geist | 12 · 500 | `text-xs` |
| Label (above figures, columns, axes) | Geist | 11 · 500 · caps | `t-label` / `text-label` |
| Big figure | Geist Mono | 40 · 500 | `t-fig-xl` |
| Figure | Geist Mono | 24 · 500 | `t-fig` |
| Inline figure / ID | Geist Mono | inherits | `font-mono` |
| Receipt | Geist Mono | 13 | `.receipt` (the one mono-prose exception) |

- Serif appears at most twice per page: the title and the verdict.
- Mono is for numbers and identifiers only (figures, case IDs, run numbers, codes, key caps),
  never sentences.
- Three weights: 400, 500, 600. Nothing under 11px. Never `text-[NNpx]`.
- Three text colours: `ink` (headings, figures), `ink-2` (body, meta), `ink-3` (labels, axes).
- Chart text: `c-name` / `c-row` / `c-note` (13px sans) and `c-num` (11px mono); plain `<text>` is
  11px sans ink-3.

## Colour

- OKLCH tokens in `index.css`; hairlines are tinted teal. Never write a hex in a component.
- Six fixed states: pass (green), fail (red), flaky (amber), not tested (grey), error (violet),
  heuristic (hatched). Baseline / candidate are series 1 (blue) / 2 (orange).
- Good news is coloured too. When everything passes the screen is calm; colour marks what needs
  attention.
- A change shows direction with the arrow and goodness with the colour (`<Delta>`): latency going
  up is an up arrow in red.

## Motion

- Motion marks change or liveness: the needle sweeps up once and settles; it trembles while a run
  is live; a passed gate stamps; figures roll (`<Odometer>`); receipts reprint changed lines.
- 120–250 ms for UI, springs for layout, nothing loops at rest except particles on the run flow
  diagram and a live run.
- Every animation respects reduced motion (`useMotionOn()`, `:root[data-motion="reduced"]`).

## Data honesty

- Every chart says what it rests on (`<SampleSize>`), and flags small samples.
- Every mark opens what is behind it; hovering anything with `data-case` lights that question
  everywhere on the page.
- Heuristic (word-overlap) scores are hatched wherever they appear.
- A run that asked another chatbot's questions (`off_topic`) is flagged and never headlines a
  home card or a trend.
- Sparse data is designed, not drawn as broken: one run is a "first reading" with a dotted ghost
  line; an unreported figure is one quiet line saying how to turn it on, not a 28px "n/a".

## Layout and components

- **Page rhythm**: a page is `PageHeader`, then sections spaced `space-y-12`; inside a section
  `space-y-6`. Nothing else sets the gap between sections.
- **Heading row** (one component for every section heading): title (18/600), `?`, an optional
  count/sample chip, then actions on the right. On a narrow screen the actions wrap below; the
  title never truncates. No captions beside the title ("vs #4" goes in the `?` or the content).
- **Tables**: headers are `.t-label`; a header sits over its content's alignment (figures and
  their headers right-aligned); stacked tables on one page share column widths; a change is
  always `<Delta>` (`+23.6 pp`, `−120 ms`), never a bare arrow and number.
- **States** have one look each, via `Badge` / `Chip`: pass, fail, flaky, unscored, not measured,
  error, heuristic (hatched), cancelled. A failed run and a failed gate use the same fail style.
  Pass-rate colour scales (heatmap, by category) snap to pass / flaky / fail bands and carry a
  legend.
- **Use the shared pieces**: `Button`, `Input`, `Select`, `Checkbox`, `FileInput`, `Segmented`,
  `Table`, `Card` (boxed for panels), `Help` / `LabelHelp`, `Empty`, `Loading`, `Dialog`, `Menu`.
  No hand-rolled versions.
- **Empty states**: a plain title without a full stop ("No datasets yet"), one sentence (the
  gauge line can live here), one action.
- **Narrow screens (390 px)**: heroes stack (gauge, stamp and receipt go below the title); wide
  tables scroll inside their section with a visible edge; chip rows wrap; no horizontal page
  scroll.
- At most two serif lines per page: the page title and the verdict.

## Words

One name per thing, on screen and in every message the server writes:

| Say | Not |
|---|---|
| chatbot (headings, labels), bot (sentences) | assistant, agent, target |
| connection | target, connector |
| dataset (the object), questions (its contents) | question set, golden set, suite, test cases |
| question | case (except the ID column) |
| try | trial |
| check | evaluator, metric (for a grading rule) |
| grading model | judge (only in the glossary and one Settings explanation), grader |
| run, run setup | experiment |
| release gate | regression gate |
| this computer | this PC, this machine |
| per answer | per question, / answer |

- Sentence case everywhere; "pass" / "fail" in lower case in sentences (capitals only on the gate
  stamp).
- Address the reader as "you"; no "me" / "my" / "I" in titles or buttons.
- Verbs: "New X" opens a form, "Save X" submits, "Add X" adds to a list, "Delete X" deletes,
  "Stop run" stops, "Cancel" only closes a dialog, "Test X" is a health check, "Apply gate"
  runs a gate, "Re-grade" re-scores.
- Real plurals (`plural(n, 'source')`), never "source(s)".
- "…" not "...", curly quotes and apostrophes in copy, no em dashes, units spaced ("1.2 s",
  "340 ms", "+3.1 pp"), one path separator: "Settings > Models & keys".
- UK spelling (colour, labelled, organisation).
- Server errors are sentences for the screen: no field names, no exception class names.
