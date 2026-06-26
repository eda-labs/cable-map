# Front-panel stencils — end-to-end guide

How the cable-map front-panel rendering works, from raw vendor SVG to the cage that
highlights on the canvas. Read this before touching anything under `public/frontpanel/`,
`scripts/compose-*`, `scripts/*-frontpanel*`, `src/FrontPanel.tsx`, `src/SwitchNode.tsx`,
`src/stencil.ts`, or `src/frontpanel-meta.json`.

---

## 1. What a "stencil" is

A **stencil** is one SVG in `public/frontpanel/<platform>.svg` that draws a device's front
panel. It is the **single source of truth** for that platform's port map — there are no
separate `ports.json` / `rows.json` maps (removed).

Two things make an SVG a usable stencil:

1. **Each port cage `<path>` carries `data-port="N"`** — `N` is the bare port number on a
   fixed chassis (`"5"`), or `"<slot>-<port>"` on a slotted/modular chassis (`"1-5"`).
2. **A baked port-number `<text>` label sits at each cage's centre**, styled like every
   other panel (white NokiaPureText), reading the card's actual silkscreen (`c5` for
   connector-numbered cards, bare `5` otherwise).

The filename, the `frontpanel-meta.json` key, and the platform string a node resolves to
**must all be byte-identical**. A node renders a panel only if its resolved stencil name
equals a filename in `public/frontpanel/`.

---

## 2. The pipeline (E2E)

```
stencils/                         raw vendor SVG library (gitignored, source material)
  │
  │  derive  (fixed chassis)            compose (modular chassis)
  │  scripts/derive-frontpanel.mjs      scripts/compose-modular.mjs   (SR-2s / SR-2se)
  │                                     scripts/compose-sr1.mjs       (SR-1 / SR-1s)
  ▼                                     scripts/compose-sr1-all.mjs   (drivers)
public/frontpanel/<name>.svg      THE SOURCE OF TRUTH (committed)
  │   • <path data-port="N">  per cage
  │   • <text data-added>…</text>  baked label per cage
  │
  │  scripts/gen-frontpanel-meta.mjs   (walks every SVG's data-port cages)
  ▼
src/frontpanel-meta.json          { ports, rows, aspect, slotted, layout:[{p,x,y,w,h}] }
  │
  ├──► src/stencil.ts  stencilFor(platform, components) → a stencil name
  │
  ├──► src/FrontPanel.tsx   drawer view: inlines the SVG, fills path[data-port]
  │
  └──► src/SwitchNode.tsx   canvas view: draws cells from meta.layout (real-layout mode)
```

- **`stencils/`** is gitignored raw vendor material, not app assets. The committed assets
  are the derived/composed SVGs under `public/frontpanel/`.
- The build scripts (`compose-sr1*.mjs`, `derive-frontpanel.mjs`) are **dev-only and
  gitignored** — we ship the generated SVGs, not the generators.

---

## 3. The SVG contract

### data-port
- Fixed chassis: `data-port="5"` (bare port number).
- Slotted/modular: `data-port="1-5"` (`<slot>-<port>`). Each slot restarts its own port
  counter, so slot 1 and slot 2 can both have a port 5. This matches EDA's
  `ethernet-<slot>-<port>` interface naming.
- The frontend keys cages with `cageKey(label, slotted)` (`api.ts`): `"<slot>-<port>"` for
  slotted, bare port otherwise. `PortInfo.port` / `FpPort.p` are therefore **strings**.

### baked labels
Every cage gets a `<text>` label, format copied verbatim from the existing panels:

```xml
<text data-added="1" x="…" y="…" text-anchor="middle" dominant-baseline="central"
      fill="#ffffff" font-size="…" font-family="NokiaPureText" font-weight="normal"
      style="pointer-events:none">c5</text>
```

- `data-added="1"` marks it so the renderer can keep a *filled* cage **below** the labels
  (text stays readable over the fill) — see §6.
- Label text matches the **card's own silkscreen**: `cN` for connector-numbered cards,
  bare digit for the rest. Never hardcode `c`; read it per card (the compose script tracks
  `hasC` from the silkscreen).

### slotted flag
`gen-frontpanel-meta.mjs` flags a platform `slotted: true` if any cage id contains `-`.

---

## 4. Composing a modular chassis

Modular chassis (SR-1, SR-1s, SR-2s, SR-2se) are **chassis frame + one card per bay**,
each card nested in its own `<svg viewBox>` sized to the bay, ids namespaced per slot,
data-ports slot-prefixed. The result renders chassis + cards as one panel.

`scripts/compose-sr1.mjs` is the SR-1 / SR-1s engine; the drivers
`compose-sr1-all.mjs` / `compose-sr1s-all.mjs` fan out every ordered card pair (two bays →
`N×N` composites). `compose-modular.mjs` is the SR-2s/2se engine.

Get the card types from Appendix A of the following PDF: https://documentation.nokia.com/sr/25-7/7750-sr/pdf/SR-SIM_Installation_and_Setup_Guide_25.7.R1.pdf

### Finding bay geometry
A modular chassis is a flat (Inkscape/EMF) SVG. To find the bays, scan the chassis paths
for **card-sized rectangular regions** (bounding box ≈ the card's content bbox). e.g. the
SR-1s "6.0 Tbps HD Modular System" has two side-by-side bays at
`14.8,26.4,78,23.6` and `89.5,26.4,78,23.6` (the card bbox is 78×23.6, so it nests 1:1).
Pass them to the engine as `--slots "x,y,w,h;x,y,w,h"`.

### data-port assignment — the column algorithm (READ THIS)
`tagDataPorts()` decides which cage gets which port number. The naïve "nearest cN label"
approach is **wrong** and caused a real row-inversion bug:

- The silkscreen prints `cN` labels **mid-row** (between the two cage rows) or **below**
  the cages. So label-y does not reliably say which of a stacked column's two cages a label
  belongs to. Nearest-cage put odd ports on the bottom row → inverted panel.

The correct algorithm **ignores label-y entirely**:

1. `cages()` finds the cage faces (dominant fill-group whose count matches the label count).
2. Cluster cages into **columns by x** (stacked cages share an x).
3. Bucket each label into its nearest column **by x**.
4. Within each column, **zip ascending port number → top-to-bottom** (smaller cy first).

This encodes the universal Nokia convention **odd = top row, even = bottom row**, which
holds for every card we have (verified: 154 two-row slots, zero violations). It is robust
to mid-row *and* below-row label placement, and degrades correctly to single-row cards.

### labels
`cLabels()` parses the silkscreen: prefers `cN` labels; if a card has none it keeps the
**contiguous `1..N` run** of bare digits (so speed text like `10`/`40`/`100` can't pose as
a port number). It records `hasC` per label, which the bake step uses to emit `cN` vs bare.

---

## 5. frontpanel-meta.json

`scripts/gen-frontpanel-meta.mjs` walks every `public/frontpanel/*.svg`, reads the
`data-port` cage geometry, and writes per-platform:

```jsonc
"7750 SR-1 me16-…_me16-…": {
  "ports": 36, "rows": 2, "aspect": 14.26, "slotted": true,
  "layout": [ { "p": "1-1", "x": 0.021, "y": 0.786, "w": 0.042, "h": 0.427 }, … ]
}
```

- `layout` positions are **normalised 0..1** within the panel's aspect box; the canvas
  `SwitchNode` draws cells straight from these.
- `rows` = distinct y-bands of cages. `aspect` = panel width/height.
- Regenerate after **any** SVG change. It's a committed file (`src/frontpanel-meta.json`)
  and the FE imports it directly. (Note: label-only edits don't change meta — it's derived
  from cage geometry, not text.)

---

## 6. Rendering

### Drawer — `src/FrontPanel.tsx`
- Fetches `public/frontpanel/<platform>.svg`, inlines it via `innerHTML` (lenient HTML
  parsing — undeclared `sodipodi:`/`inkscape:` namespaces are harmless here), namespaces
  ids per inline (`isolateIds`, so multiple panels on one page don't collide on `url(#…)`).
- Styles `svg path[data-port]` directly: occupied → green, hovered → blue.
- A connector graphic can be painted **over** a cage; FrontPanel raises a filled cage above
  it but **below** the baked labels by inserting it before the first `text[data-added]`
  (so the white port number stays on top of the fill).
- Inkscape exports ship no `viewBox`; FrontPanel synthesises one from `getBBox()`.

### Canvas — `src/SwitchNode.tsx`
- `DetailedSwitchNode` real-layout mode reads `data.layout` (the meta layout) and
  absolutely-positions each cage cell. Labels use NokiaPureText to match the silkscreen.
- The node shows the **cage id** (`info.port`, e.g. `1-5`), not the silkscreen label.
- `SwitchData` carries `{ name, role, platform, portCount, rows, aspect, layout, ports,
  breakouts, … }`. `graph.ts` builds it; `panelDims(rows, aspect)` sizes the panel.
- **Node width is pinned to the panel width.** The meta `layout`/`aspect` are normalised to
  the *cage bounding box* (no chassis-body whitespace), so `panelDims().w` is exactly the
  furthest-ports span. `graph.ts`'s `swW` reserves `panel.W + STRIP_PAD*2` for the node, so
  `DetailedSwitchNode` pins its own width to that (`box-sizing: border-box`) and **truncates
  the header** (a long platform name can't widen the node past its ports). Without this,
  narrow panels (few ports) with a long platform string render wider than their port panel
  and overflow the slot `graph.ts` laid out. Grid-mode (no layout) nodes keep auto width.

---

## 7. The resolver — `src/stencil.ts`

`stencilFor(platform, components)` bridges an EDA node to a stencil filename.

- `TWO_BAY_CHASSIS = { '7750 SR-1', '7750 SR-1s' }` → `"<platform> <mda1>_<mda2>"`. A
  single MDA mirrors into both bays (`mdas[1] ?? mdas[0]`) so it still matches a composite.
- `SINGLE_MDA_CHASSIS = { '7750 SR-1se' }` → `"<platform> <mda>"`.
- `7750 SR-1` also falls back to integrated line-card variants (`SR1_LINECARD_STENCIL`).
- Otherwise the platform name is used as-is if it names a stencil.
- **`sanitise` flattens `/` and `+` to `-`** — see §8. The MDA `type` strings EDA reports
  must sanitise to the same token the composite filenames use.

`componentsOf(raw)` pulls `raw.spec.component` off the embedded TopoNode CR.

---

## 8. Gotchas (the expensive ones)

- **`+` and `/` in filenames break rendering.** `/` is a path separator; `+` is decoded to
  a space in the static server's URL path, so the fetch 404s and falls through to the SPA
  `index.html` (~600 bytes) — FrontPanel inlines that and renders **nothing** (a blank white
  bar). Fix: sanitise both to `-` in the filename **and** in `stencil.ts`'s `sanitise`. A
  632-byte "SVG" response is the tell.
- **`sodipodi:` / `inkscape:` namespaces are a red herring.** They make the file invalid
  strict-XML (xmllint complains), but `innerHTML` parses leniently and ignores them. They
  are present in *every* card and never the cause of a blank panel.
- **Label-y is unreliable for row assignment.** Use the column + odd-top algorithm (§4),
  not nearest-cage.
- **Cage face vs decoration.** A cage is layered: an outline (no fill), a solid **face**
  (`fill:rgb(19.99%…)` grey — the fillable one), sometimes a tiny mark drawn on top. Map
  `data-port` to the face, not the outline or a 3×3 decoration.
- **Cairo vs Inkscape exports differ.** Cairo (7220/7730): grouped `<g>`, has `viewBox`,
  native `1/N` text. Inkscape/EMF (SR-1 set): flat, no `viewBox`, no text. The compose/derive
  scripts handle both; don't assume one shape.
- **Composites are large** (~1–1.7 MB each). Expected.
- **Per-slot id collisions.** Cairo reuses generic ids (`clip1`, `glyph0-1`). Inlining many
  panels collides their `url(#…)` refs → wrong shapes. `isolateIds()` namespaces per inline;
  keep it. Composites also namespace per slot (`s1-`, `s2-`).

---

## 9. Dev inspector — `/stencils.html`

A dev-only tool for building and reviewing stencils. **Its own Vite entry**
(`stencils.html` → `src/stencils-main.tsx` → `src/StencilViewer.tsx`), so it is **never in
the prod build** (`vite build` only builds `index.html`; verified the inspector strings are
absent from `dist/`). All three files are gitignored.

Run the dev server and open `http://localhost:<port>/stencils.html`. Features:

- **platform group → subtype** cascading dropdowns. Only the modular chassis (SR-1, SR-1s,
  SR-2s, SR-2se) fan out into card-config subtypes; every fixed platform is its own group.
- **`< >` arrows** next to the subtype to step through variants (no wrap), for fast review.
- **fill cages** (on by default) — fills every `path[data-port]` green (coverage check: a
  real cage with no fill is untagged; fill on a non-cage is a decoy mis-tag).
- **click any path** → its `data-port` (or UNTAGGED), centre in SVG user units, and full
  `d` (copied to clipboard) — use this to position/retag a cage.
- **canvas node** below the stencil renders the real `SwitchNode` in a minimal `<ReactFlow>`
  — exactly how it looks on the topology canvas.
- **hot reload**: a dev Vite plugin (`frontpanelHmr` in `vite.config.ts`) watches
  `public/frontpanel/**/*.svg` and pings `cable-map:frontpanel`; the viewer re-fetches the
  current panel in place (cache-busted), preserving the group/subtype selection. Meta
  changes still full-reload (static JSON import).

---

## 10. Recipe: add a new modular chassis

1. **Locate assets** in `stencils/`: the chassis frame SVG and the card SVGs.
2. **Find bay geometry**: scan chassis paths for card-sized rectangular openings (bbox ≈
   the card content bbox). Note `x,y,w,h` per bay.
3. **Write a driver** like `scripts/compose-sr1s-all.mjs`: the chassis path, the `--slots`
   string, and a `code → cardFile` table. Reuse `compose-sr1.mjs` (it takes `--slots`).
   - Keep codes URL-safe: no `/` or `+` (the engine and resolver both sanitise to `-`, but
     name them cleanly).
4. **Generate** + **regen meta**: `node scripts/<driver>.mjs && node scripts/gen-frontpanel-meta.mjs`.
5. **Wire the resolver** in `src/stencil.ts` (add to `TWO_BAY_CHASSIS` / `SINGLE_MDA_CHASSIS`
   or a new branch). Make sure EDA's reported MDA `type` sanitises to your filename token.
6. **Verify**:
   - every composite serves a real SVG, not the ~600-byte SPA fallback;
   - port counts == sum of the two cards;
   - two-row slots are odd-top/even-bottom;
   - eyeball each in `/stencils.html` (fill cages on, arrow through subtypes), comparing the
     baked labels against the silkscreen and the canvas-node layout.

---

## 11. File map

| Path | Tracked | Role |
|---|---|---|
| `stencils/` | gitignored | raw vendor SVG library (source material) |
| `public/frontpanel/<name>.svg` | committed | **the stencils** (data-port + baked labels) |
| `src/frontpanel-meta.json` | committed | derived per-platform `{ports,rows,aspect,slotted,layout}` |
| `src/stencil.ts` | committed | `stencilFor()` resolver (platform+components → name) |
| `src/FrontPanel.tsx` | committed | drawer render (inline SVG, fill cages) |
| `src/SwitchNode.tsx` | committed | canvas render (cells from meta layout) |
| `scripts/gen-frontpanel-meta.mjs` | committed | meta generator |
| `scripts/compose-modular.mjs` | dev-untracked | SR-2s/2se composer |
| `scripts/compose-sr1.mjs` | dev-gitignored | SR-1/SR-1s compose engine (`--slots`) |
| `scripts/compose-sr1-all.mjs`, `compose-sr1s-all.mjs` | dev-gitignored | drivers |
| `scripts/derive-frontpanel.mjs` | dev-gitignored | fixed-chassis derive |
| `src/StencilViewer.tsx`, `src/stencils-main.tsx`, `stencils.html` | dev-gitignored | `/stencils.html` inspector |
| `vite.config.ts` `frontpanelHmr` | committed | dev SVG hot-reload plugin |

Dev-gitignored files are excluded via `.git/info/exclude` (local-only; do **not** add them
to the tracked `.gitignore`).
