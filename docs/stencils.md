# Front-panel stencils — end-to-end guide

How the cable-map front-panel rendering works, from raw vendor SVG to the cage that
highlights on the canvas. Read this before touching anything under
`cable_map/operators/cable-map/frontpanel/`,
`scripts/compose-*`, `scripts/*-frontpanel*`, `src/FrontPanel.tsx`, `src/SwitchNode.tsx`,
`src/stencil.ts`, or `cable_map/frontend/src/generated/frontpanel-meta.json`.

The supported-hardware **source of truth** is the SR-SIM Installation and Setup Guide
(Appendix A): <https://documentation.nokia.com/sr/25-7/7750-sr/pdf/SR-SIM_Installation_and_Setup_Guide_25.7.R1.pdf>.
A per-chassis coverage audit against it is in **§12**.

---

## 1. What a "stencil" is

A **stencil** is one SVG in `cable_map/operators/cable-map/frontpanel/<platform>.svg` that
draws a device's front panel. It is the **single source of truth** for that platform's port
map — there are no separate `ports.json` / `rows.json` maps (removed).

Two things make an SVG a usable stencil:

1. **Each port cage `<path>` carries `data-port="N"`** — `N` is the bare port number on a
   fixed chassis (`"5"`), or `"<slot>-<port>"` on a slotted/modular chassis (`"1-5"`).
2. **A baked port-number `<text>` label sits at each cage's centre**, styled like every
   other panel (white NokiaPureText), reading the card's actual silkscreen (`c5` for
   connector-numbered cards, bare `5` otherwise).

The filename, the `frontpanel-meta.json` key, and the platform string a node resolves to
**must all be byte-identical**. A node renders a panel only if its resolved stencil name
equals a filename in `cable_map/operators/cable-map/frontpanel/`.

---

## 2. The pipeline (E2E)

```
stencils/                         raw vendor SVG library (gitignored, source material)
  │
  │  derive  (fixed chassis)            compose (modular chassis)
  │  scripts/derive-frontpanel.mjs      scripts/compose-modular.mjs   (SR-2s / SR-2se)
  │                                     scripts/compose-sr1.mjs       (SR-1 / SR-1s)
  ▼                                     scripts/compose-sr1-all.mjs   (drivers)
cable_map/operators/cable-map/frontpanel/<name>.svg
                                      THE SOURCE OF TRUTH (committed)
  │   • <path data-port="N">  per cage
  │   • <text data-added>…</text>  baked label per cage
  │
  │  metadata generation step          (walks every SVG's data-port cages)
  ▼
cable_map/frontend/src/generated/frontpanel-meta.json
                                  { ports, rows, aspect, slotted, layout:[{p,x,y,w,h}] }
  │
  ├──► src/stencil.ts  stencilFor(platform, components) → a stencil name
  │
  ├──► src/FrontPanel.tsx   drawer view: inlines the SVG, fills path[data-port]
  │
  └──► src/SwitchNode.tsx   canvas view: draws cells from meta.layout (real-layout mode)
```

- **`stencils/`** is gitignored raw vendor material, not app assets. The committed assets
  are the derived/composed SVGs under `cable_map/operators/cable-map/frontpanel/`.
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

> **Source of truth: the SR-SIM Installation and Setup Guide PDF**
> <https://documentation.nokia.com/sr/25-7/7750-sr/pdf/SR-SIM_Installation_and_Setup_Guide_25.7.R1.pdf>
> **Appendix A** is the supported-hardware list. Use it to decide *whether a platform is
> modular at all*, and to get the per-bay card list. Cross-check against EDA's component
> model: a platform that reports `kind: mda` components is **modular** (compose it); one with
> an **integrated** `kind: lineCard` / IMM is **fixed** (single faceplate, no compose).

### Which 7750 platforms are modular (per the SR-SIM PDF + EDA model)
| Platform | Type | Notes |
|---|---|---|
| **7750 SR-1** | modular | two MDA bays (`me*` cards) → `N×N` composites |
| **7750 SR-1s** | modular | "6.0 Tbps HD Modular System" chassis, two MDA-s bays (`ms*` cards) |
| **7750 SR-2s** | **10×10 matrix** | same 2-XCM structure as SR-2se (interchangeable geometry). Per SR-SIM Table 57, each XCM slot = a full XMA-s (`s18-100gb-qsfp28`, `s36-400gb-qsfpdd`) **or** an IOM-s with 2 MDA-s bays (the 8 `ms*` cards, same as the SR-1s) → **100 composites** `7750 SR-2s <a>_<b>`. Built by `scripts/compose-sr2s.mjs` (clone of the SR-2se engine with `-2s` modules: CPM-2s, XCM-2s, IOM-s, chassis `7750_SR-2s__Front_`). XMA-s cages don't derive, so s18/s36 are recovered tagged from the original composites (`stencils/.sr2s-xma-*.txt`). The old `6p/12p/16p/24p` composites were **not** in the PDF's SR-2s list (those XMA-s are for SR-7s/14s) and were replaced. |
| **7750 SR-2se** | **5×5 matrix** | 2 stacked XCM slots; each XCM = one full-width 36-port XMA2-s **or** an IOM2-se XIOM with two half-width MDA2-se bays. The 5 slot configs (`x2-s36-800g-qsfpdd`, `mse24-200g-sfpdd`, `mse14-800g-4-400g`, `mse6-800g-qsfpdd`, `mse6-800g-cfp2-dco`) × both slots → **25 composites** `7750 SR-2se <a>_<b>`. No bare/base — every config is a named pair. Full module hierarchy: chassis → 2× CPM-2se → 2× XCM-2se carrier → IOM2-se → 2× MDA2-se (only MDAs/XMA are port-tagged). The XMA2-s cages don't cluster with the MDA heuristic, so the XMA's tagged card is reused from the original composite (recovered from git into `stencils/.sr2se-orig-tagged.svg`). Built by `scripts/compose-sr2se.mjs`. |
| **7750 SR-1se** | **fixed** | integrated 36-port QSFP-DD IMM (`imm36-…`); the 9.6/14.4/19.2 Tbps and 400G/800G are throughput/optics tiers of the **same** faceplate — one stencil, no bays |
| **7750 SR-1-24D/46S/48D/92S, SR-1x-…** | fixed | integrated FP5 line card |

So **SR-1, SR-1s, SR-2s** are per-card-pair composites; **SR-2se** is the full 5×5 XCM-slot
matrix; SR-1se and the rest are single faceplates resolved straight by name. (Tell:
`stencils/7750 SR-1se/` has only fixed `…36-port…QSFP-DD…` SVGs — no `Modular System`
chassis and no MDA cards, unlike `stencils/7750 SR-1s/`.)

Resolver status: SR-1 / SR-1s (`TWO_BAY_CHASSIS`), SR-1se (`SINGLE_MDA_CHASSIS`), and SR-2s /
SR-2se (dedicated branches: group MDAs by XCM slot → `<platform> <c1>_<c2>`, XMA SKUs collapse
to one code per faceplate) are all wired in `stencil.ts`.

Open items for SR-2se: (1) eyeball module alignment in `/stencil-editor/` (CPM `25,18`/`100,18`,
XCM `4,36`/`4,60`, IOM inner `9.5,0 155.8×23.6`, MDA bays `1.7`/`76.4` within the IOM); (2)
the 4 bays are numbered `1-`…`4-` and the resolver groups MDAs by slot prefix — confirm both
against an onboarded SR-2se's actual `ethernet-<slot>-<port>` interface numbering.

Modular chassis are **chassis frame + one card per bay**, each card nested in its own
`<svg viewBox>` sized to the bay, ids namespaced per slot, data-ports slot-prefixed.

`scripts/compose-sr1.mjs` is the SR-1 / SR-1s engine; the drivers
`compose-sr1-all.mjs` / `compose-sr1s-all.mjs` fan out every ordered card pair (two bays →
`N×N` composites). `compose-modular.mjs` is the SR-2s/2se engine.

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

## 5. Generated front-panel metadata

The metadata generation step walks every `cable_map/operators/cable-map/frontpanel/*.svg`, reads the
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
- Regenerate after **any** SVG change. It's a committed file
  (`cable_map/frontend/src/generated/frontpanel-meta.json`)

The app also derives `cable_map/frontend/src/generated/frontpanel-labels.json` from each stencil's
baked `data-added="1"` port text. It records whether each fixed panel or modular bay uses `c1`,
`c2`, … or bare `1`, `2`, … silkscreen labels. The topology canvas uses that label while keeping
addresses such as `1-1` solely as internal cage keys. Regenerate it after changing stencils with:

```sh
pnpm -C cable_map/frontend gen:frontpanel-labels
```

`make check` verifies that the committed label metadata is current.
  and the FE reads it through `src/domain/ports/frontPanelMeta.ts`. (Note: label-only edits
  don't change meta — it's derived from cage geometry, not text.)

---

## 6. Rendering

### Drawer — `src/FrontPanel.tsx`
- Fetches `/frontpanel/<platform>.svg` from the operator-served front-panel directory, inlines it via `innerHTML` (lenient HTML
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

## 9. Dev inspector — `frontpanel-studio`

A dev-only tool for building and reviewing stencils, in its **own Vite project** at the repo root
(`frontpanel-studio/`, a sibling of `cable_map/`) — it's tooling, kept out of the app. It previews a
stencil with the app's **real** `SwitchNode` renderer via a vite alias (`@app` →
`cable_map/frontend/src`), so there's no duplicated renderer and nothing ships in the app build.

Run it: `pnpm -C frontpanel-studio install` (first time), then `pnpm -C frontpanel-studio dev` and
open `http://localhost:5174/`. Features:

- **platform group → subtype** cascading dropdowns. Only the modular chassis (SR-1, SR-1s,
  SR-2s, SR-2se) fan out into card-config subtypes; every fixed platform is its own group.
- **`< >` arrows** next to the subtype to step through variants (no wrap), for fast review.
- **fill cages** (on by default) — fills every `path[data-port]` green (coverage check: a
  real cage with no fill is untagged; fill on a non-cage is a decoy mis-tag).
- **click any path** → its `data-port` (or UNTAGGED), centre in SVG user units, and full
  `d` (copied to clipboard) — use this to position/retag a cage.
- **canvas node** below the stencil renders the real `SwitchNode` in a minimal `<ReactFlow>`
  — exactly how it looks on the topology canvas.
- **hot reload**: the `frontpanel` Vite plugin (`frontpanel-studio/vite.config.ts`) serves the
  stencils from `cable_map/operators/cable-map/frontpanel/` and pings `cable-map:frontpanel` on
  edit; the viewer re-fetches the current panel in place (cache-busted), preserving the
  group/subtype selection. Meta changes still full-reload (static JSON import).

---

## 10. Recipe: add a new modular chassis

1. **Locate assets** in `stencils/`: the chassis frame SVG and the card SVGs.
2. **Find bay geometry**: scan chassis paths for card-sized rectangular openings (bbox ≈
   the card content bbox). Note `x,y,w,h` per bay.
3. **Write a driver** like `scripts/compose-sr1s-all.mjs`: the chassis path, the `--slots`
   string, and a `code → cardFile` table. Reuse `compose-sr1.mjs` (it takes `--slots`).
   - Keep codes URL-safe: no `/` or `+` (the engine and resolver both sanitise to `-`, but
     name them cleanly).
4. **Generate** + **regen meta**: `node cable_map/frontend/scripts/<driver>.mjs && pnpm -C frontpanel-studio gen:frontpanel-meta`.
5. **Wire the resolver** in `src/stencil.ts` (add to `TWO_BAY_CHASSIS` / `SINGLE_MDA_CHASSIS`
   or a new branch). Make sure EDA's reported MDA `type` sanitises to your filename token.
6. **Verify**:
   - every composite serves a real SVG, not the ~600-byte SPA fallback;
   - port counts == sum of the two cards;
   - two-row slots are odd-top/even-bottom;
   - eyeball each in `frontpanel-studio` (fill cages on, arrow through subtypes), comparing the
     baked labels against the silkscreen and the canvas-node layout.

---

## 11. File map

Paths are from the repo root. The **stencils + their tooling are separate from the app**: the SVGs
live with the operator that serves them; the inspector + generation scripts live in `frontpanel-studio/`.

| Path | Tracked | Role |
|---|---|---|
| `stencils/` | gitignored | raw vendor SVG library (source material) |
| `cable_map/operators/cable-map/frontpanel/<name>.svg` | committed | **the stencils** (data-port + baked labels); served by the operator at `/frontpanel/*` |
| `cable_map/frontend/src/generated/frontpanel-meta.json` | committed | derived per-platform `{ports,rows,aspect,slotted,layout}` |
| `cable_map/frontend/src/generated/frontpanel-labels.json` | committed | derived per-platform/per-bay visible cage-label convention (`c1` or `1`) |
| `cable_map/frontend/src/stencil.ts` | committed | `stencilFor()` resolver (platform+components → name) |
| `cable_map/frontend/src/FrontPanel.tsx` | committed | drawer render (inline SVG, fill cages) |
| `cable_map/frontend/src/SwitchNode.tsx` | committed | canvas render (cells from meta layout) |
| `cable_map/frontend/scripts/compose-*.mjs`, `derive-frontpanel.mjs` | dev-gitignored | composers / derive (one-time generators) |
| `frontpanel-studio/{index.html,src/main.tsx,src/StencilViewer.tsx}` | committed | the inspector (its own Vite project; aliases `@app` → the frontend) |
| `frontpanel-studio/vite.config.ts` `frontpanel` plugin | committed | dev stencil serve + hot-reload |

Dev-gitignored files are excluded via `.git/info/exclude` (local-only; do **not** add them
to the tracked `.gitignore`).

---

## 12. Coverage audit — SR-OS chassis (SR-SIM Appendix A, 25.7.R1)

Cross-check of every SR-OS chassis the SR-SIM lists vs. what has stencils. **Key insight:**
SR-SIM models almost every chassis with **1–2 line-card slots** (not its physical slot
count), so each is either *fixed* (1 stencil), *single-MDA* (N faceplates, one per card), or
*2-bay/2-XCM* (a matrix) — never a combinatorial blow-up. (The 7220/7215/7730 families are
SR Linux, not SR-OS, and already covered.)

### Covered
`7750 SR-1` (49), `SR-1-24D/46S/48D/92S`, `SR-1s` (65), `SR-1se`, `SR-1x-48D/92S`,
`SR-2s` (100, Table 57), `SR-2se` (25, Table 59).

### Missing — and how each should be built

| Chassis | SR-SIM card structure (Appendix A) | Build shape |
|---|---|---|
| **7250 IXR-6 / IXR-10** | `cpm-ixr` + IMM line card: `imm36-100g-qsfp28` (m36), `imm48-sfp+2-qsfp28` (m48) | single-MDA → 2 faceplates each |
| **7250 IXR-e** | `imm24-sfp++8-sfp28+2-qsfp28` (m24), `imm14-10g-sfp++4-1g-tx` (m14) | 2 faceplates |
| **7250 IXR-e2 / e2c / ec** | fixed integrated: `m2-qsfpdd+2-qsfp28+24-sfp28` / `m12-sfp28+2-qsfp28` / `m4-1g-tx+20-1g-sfp+6-10g-sfp+` | 1 fixed faceplate each |
| **7250 IXR-R4** | `iom-ixr-r4` + 6 MDAs (`m6-…-100g-qsfp28`, `m20-1g-csfp`, `m10-10g-sfp+`, `m4-…-100g-cfp2`, `m6-…-25g-sfp28`, `m10-1g-sfp+2-10g-sfp+`) | single-MDA → 6 |
| **7250 IXR-R6 / R6d / R6dl** | `(cp)iom-ixr-r6(d)` + 6 / 8 / 10 MDAs (`m1-400g…`, `m5-100g…`, `m18-25g…`, `m2-cfp2`, `m20/m46/m80-…`, `a32-chds1v2`, …) | single-MDA → 6–10 |
| **7250 IXR-s** | `imm48-sfp++6-qsfp28` (m48) | 1 fixed |
| **7250 IXR-X / X3** | `imm32-qsfp28+4-qsfpdd` (m32), `imm6-qsfpdd+48-sfp56` (m6) / `imm36-qsfpdd` (m36) | missing. NB the `7250 IXR-X1b`/`X3b` stencils we already have are **SR Linux** platforms (different from these SR-OS `IXR-X`/`IXR-X3`) |
| **7450 ESS-7 / ESS-12** | `iom5-e` + `me6-100gb-qsfp28` | single-MDA → 1 (+ more me\* if extended) |
| **7750 SR-1e/2e/3e** | `imm-2pac-fp3`/`iom4-e` + many `me*`/`isa2` cards | single-IOM, many MDAs |
| **7750 SR-7 / SR-12 / SR-12e** | `iom5-e`/`iom4-e(-b/-hs)`/`imm*` + ~15 `me*`/`isa2`/`imm` cards | single-IOM, large MDA list |
| **7750 SR-7s / SR-14s** | `xcm-7s/14s` (s18/s36 + `ms*`) **and** `xcm2-7s/14s` (x2-s36 + `mse*` + m36) | **= SR-2s + SR-2se cards** — reuse `compose-sr2s.mjs` / `compose-sr2se.mjs` with the SR-7s/14s chassis + `xcm(2)-7s/14s` carriers |
| **7750 SR-a4 / a8** | `iom-a` + `maxp*`/`ma*` MDAs (`maxp1-100gb-cfp`, `ma44-1gb-csfp`, `ma2-10gb-sfp+12-1gb-sfp`, …) | single-MDA → ~10 |
| **7950 XRS-20/20e** | `xcm-x20`/`xcm2-x20` + `x*` MDAs (`x2-100g-tun`, `x40-10g-sfp`, `x4-100g-cfp2`, `x12-400g-qsfpdd`, `x24-100g-qsfp28`, `x6-200g-cfp2-dco`, `x6-400g-cfp8`) | single-/2-XCM matrix |

### Build notes
- **SR-7s / SR-14s are free wins** — same card sets and 2-XCM geometry as SR-2s/SR-2se;
  just swap the chassis + carrier SVGs in the existing composers.
- **Most IXR / ESS / SR-a** are single-MDA or fixed → use the `compose-sr1.mjs` 1-bay path
  (or a small derive) per card. Need each chassis SVG + its IOM/IMM carrier + the `m*` cards
  from `stencils/` (7250 IXR, 7450 ESS, 7750 SR Interface Modules, 7950 XRS dirs).
- **Reusable technique — XMA recovery:** wide multi-port XMA cards (`x2-s36`, `s18/s36`,
  `x24-…`) draw cages as merged shapes the cage heuristic can't cluster. Recover the
  already-tagged card from an original composite (git) or an existing render, renumber the
  data-port slot, re-isolate ids (see `compose-sr2s.mjs` `XMA`, `compose-sr2se.mjs` `XMA_INNER`).
- **Resolver:** each new chassis needs a `stencilFor` branch (fixed → bare name; single-MDA →
  `SINGLE_MDA_CHASSIS`; 2-bay/2-XCM → a pair branch like SR-2s/SR-2se).
- **Blank bays (partial fill):** every matrix has a `blank` config (MDA blanking plate for
  SR-1/SR-1s, XCM filler for SR-2s/2se). The resolver places each MDA by its bay/XCM slot and
  fills empty bays with `blank` — so one MDA installed renders `<card>_blank` / `blank_<card>`,
  not a mirrored card. (`blank_blank` is dropped — it has no ports.) NB for SR-2s/2se the blank
  is at **XCM-slot** granularity; an IOM with only one of its two MDA bays filled still renders
  two of that type (the inner-IOM partial case isn't separately enumerated).
