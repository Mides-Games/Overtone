# Overtone: design direction

The owner asked for the site to be reworked with the method of these skills:
- **frontend-design** (Anthropic): decide type, colour and layout with intent before code;
- **Vercel Web Design Guidelines**: an auditor's checklist;
- **Emil Kowalski's motion rules**;
- **Taste** (avoid default AI looks: generic lilac and violet, emoji, purple gradients);
- **AccessLint** (WCAG).

The plugins were not installed; their method was applied by hand. This file is the
decision, written 2026-10-28 and kept current: a page that departs from it changes
this file in the same commit, with the reason. Section 10 records where the
foundation (`design/foundation`) departed from the first draft and why; section 11
is the guide for whoever restyles a page.

## 1. The idea

**A studio monitor, not a dashboard.** Overtone is a precision instrument for people who time music. The page should feel like good audio software (a DAW's arrange view, a hardware meter): near-black, quiet surfaces, numbers set like readouts, and colour used only as signal. One strong signature element is the **waveform with red lines**, the thing the product produces. It appears as the hero, as section dividers and in empty states. It is not decoration for its own sake; it shows the product.

**What it must not look like:**
- a generic SaaS template: centred hero, three feature cards with icons, gradient blobs;
- violet everywhere;
- glassmorphism;
- emoji as icons;
- cards inside cards;
- everything in a box.

## 2. Colour

Built from the logo, a cyan wave cut by a red line. Neutral, slightly cool ink, not
violet graphite. The table is the source of truth for `site/web/src/index.css`:
`test/design.test.js` reads both and fails when they disagree.

| Token | Dark (default) | Light | Use |
|---|---|---|---|
| `--bg` | `#0a0b0d` | `#f6f7f8` | page |
| `--surface` | `#111316` | `#ffffff` | panels |
| `--surface-2` | `#16191d` | `#f0f2f4` | raised or hover |
| `--surface-3` | `#1d2126` | `#e6e9ec` | wells (inputs, the map) |
| `--line` | `#22262c` | `#e1e4e8` | hairlines |
| `--line-strong` | `#2f343b` | `#c9ced5` | control borders (buttons, tool buttons) |
| `--line-hover` | `#454b53` | `#aab0b8` | a border under the pointer |
| `--line-control` | `#62676e` | `#868b92` | a text field's edge: 3:1 on its panel |
| `--text` | `#eceef1` | `#0e1013` | |
| `--muted` | `#a2a8b1` | `#4a515b` | body copy |
| `--dim` | `#848a93` | `#5f6670` | labels (4.5:1 on every surface, wells included) |
| `--accent` | `#3fd0dc` | `#076672` | the logo's cyan: actions, focus, the wave |
| `--red` | `#ff5d6c` | `#ad2834` | red lines only (osu!'s meaning) |
| `--amber` | `#f5b44a` | `#835606` | check by ear |
| `--tempo` | `#8fd16a` | `#356b18` | the tempo curve; **replaced lavender** |

Also tokens, outside the table: `--accent-hover`, `--accent-ink` (text on the
accent), `--red-ink` (text on a red flag), `--compare` (the other timing on a
comparison), `--onset` (the waveform's bars), `--grid`, `--scrim`, `--shadow-panel`
(none in dark), `--shadow-pop` (menus and the tray).

- **Gradients:** no purple gradients. One permitted gradient: the Mides mark's own colours, only where Mides is named.
- **`--lavender` is `--tempo` everywhere**, `draw.js` included (it reads the CSS
  variables) and the map image's fixed palette (`lib/map-image.js`). The one place the
  old name stays is the i18n key `settings.palette.swatch.lavender` (keys are never
  renamed); its text says "Tempo".
- **High contrast and colour-blind sets** stay in `index.css`, re-derived for these
  hues. `test/settings.test.js` recomputes both from the CSS and was not loosened:
  every text token at 7:1 on every surface under high contrast; the colour-blind
  palette at least 30 ΔE apart under each deficiency and 10 more than the default.
- **Every pair checked against WCAG 2.2 AA:** text 4.5:1; large text and UI parts
  3:1; the focus ring 3:1 against the surfaces it sits on. Measured numbers are in
  section 9.

## 3. Type

Self-hosted (no request leaves the site, CLAUDE.md rule 6, and the CSP's
`font-src 'self' data:` needed no change), from `@fontsource-variable/archivo`,
`@fontsource-variable/geist` and `@fontsource-variable/geist-mono`, pinned exactly in
`site/web/package.json`. Each face is split by `unicode-range`, so a page downloads
only the subsets its text uses (Latin, Latin Extended, Vietnamese, and Cyrillic for
Geist and Geist Mono).

- **Display:** **Archivo** variable (`wdth` 62-125 and `wght`). Headings at width
  112-125 % (`font-stretch`) and weight 700-800, tight tracking (−0.015 to −0.02em),
  `text-wrap: balance`, sentence case. Uppercase only for short labels (mono).
- **Text:** **Geist**. 15 px base, 1.6 line height for prose, 1.4 for UI.
- **Numbers:** **Geist Mono**, `tabular-nums` (and a slashed zero in `.readout`) for every BPM, ms, offset, count and time.
- **Scale:** 12 / 13 / 15 / 17 / 20 / 24 / 32 / 44 / 60 px, as Tailwind sizes:
  `text-caption` 12, `text-label` 13, `text-body` 15, `text-lead` 17, `text-title` 20,
  `text-heading` 24, `text-section` 24-32, `text-headline` 32-44, `text-display`
  40-60 (the last three fluid). Each takes the reader's font size (`--font-scale`).
- **Scripts:** Archivo has no Cyrillic, so Russian headings fall to Geist, which does.
  Japanese and Korean fall to the system's faces (Hiragino Sans, Yu Gothic UI,
  Meiryo, Apple SD Gothic Neo, Malgun Gothic), named in the stacks.
- **Budget:** `font-display: swap` on every face. `index.html` preloads one file, the
  Latin Archivo the hero's heading is set in. Latin for all three: **142,632 bytes**
  (Archivo 90,104, Geist 29,400, Geist Mono 23,128), under the ~150 kB budget.

## 4. Layout

- **Container:** 76rem max (`max-w-[76rem]`), gutter 16 px on a phone to 24 px from
  600 px (`lib/gutter.js`, `clamp(16px, 4vw, 24px)`, safe areas respected). A 12-column
  grid on wide screens (`lg:grid-cols-12`).
- **Space over boxes:** sections are separated by space and one hairline, not by bordered cards. Panels only for things you operate (the upload drop zone, the result's map and table, forms, the example strip).
- **Rhythm:** a 4 px base (Tailwind's spacing). Section spacing `--space-section`,
  64 px on a phone to 128 on a wide screen.
- **Hero:** asymmetric, never centred: text left, the live example strip right,
  6 columns each (section 10).
- **Navigation:** one slim row, 56 px (`--bar-height`), sticky: the mark and name,
  the seven places, then palette, language, theme and sign in. Below 1024 px a sheet
  menu (section 10). The status line (the ticker) sits above it and scrolls away.
- **Targets:** 44 px minimum on touch (`.btn`, `.icon-btn`, `.menu-item` grow under
  `pointer: coarse`); 32 px is fine for pointer-only toolbars (`.tool-btn`).

## 5. Motion (Emil Kowalski's rules)

- **Easing tokens:** `--ease-out-strong: cubic-bezier(0.23, 1, 0.32, 1)` for things
  entering or reacting; `--ease-in-out-strong: cubic-bezier(0.77, 0, 0.175, 1)` for
  things moving on screen. Tailwind's `ease-out` and `ease-in-out` utilities map to
  them. No `ease-in` for UI.
- **Duration tokens:** `--dur-press` 120 ms, `--dur-fast` 160 ms (hover, small UI),
  `--dur-panel` 240 ms (panels, sheets, menus), `--dur-exit` 160 ms. Nothing over
  400 ms except the hero's playhead and the scroll reveal (420 ms).
- **What animates:** transform and opacity only. The tray's progress bar moves by
  `scaleX`, not width.
- **Press:** `.btn` scales to 0.97 on `:active`, `.tool-btn` 0.96, `.icon-btn` 0.94.
- **Hover:** only under `@media (hover: hover) and (pointer: fine)` (Tailwind 4's
  `hover:` does this too).
- **Popovers and menus:** `.pop-in`, scale 0.96 → 1 with opacity from
  `transform-origin: var(--origin, top right)`. Exits are instant.
- **Lists that appear:** `components/ui/Reveal.jsx`, 35 ms apart (`--stagger`), at
  most 6 then the rest at once.
- **Reduced motion:** the system's `prefers-reduced-motion` and the site's own
  setting (`.motion-reduce`, `.motion-allow`) end every transition and animation at
  once; the playhead, the loader's beats and the skeleton's breath stop; Reveal holds
  nothing back. The hero strip steps instead of sweeping.
- **Frequency:** never animate something done hundreds of times (map zoom, typing) beyond the immediate feedback.
- **The ticker** no longer scrolls: perpetual motion is kept for the hero's playhead.

## 6. Components (one set, in `index.css` and `components/ui/`)

- **Buttons:** `btn-primary` (accent fill, ink text), `btn-ghost` (hairline),
  `btn-quiet` (text only, accent). 40 px tall, 44 on touch; `btn-sm` 32, `btn-lg` 48.
- **Icon buttons:** `icon-btn`, 36 px (44 on touch), always with an `aria-label`.
- **Inputs:** `field`: 40 px, `--surface-3` well, `--line-control` edge, accent edge
  on focus and the focus ring; `aria-invalid="true"` turns the edge red.
- **Chips:** `chip-accent`, `chip-amber`, `chip-red`, `chip-tempo`, `chip-neutral`:
  small mono uppercase labels, square-cornered, in the reserved colours only.
- **Panels:** `panel` (`--surface`, 1 px `--line`, radius 10, no shadow in dark,
  one soft one in light); `panel-well` for a recessed area inside one.
- **Menus:** `menu` and `menu-item` (`data-active="true"` for the keyboard's item).
- **Section header:** `components/ui/SectionHeader.jsx`: the `eyebrow` (a mono
  label with an accent tick), a `heading-section`, an optional `lede`, an optional action.
- **Long-form pages:** `components/ui/Doc.jsx`: `DocHeader` (eyebrow, the page's
  `h1`, lede, notes), `DocLayout` (a hairline, then the text beside a sticky
  `Contents` list from 1024 px; the list marks the section in view with
  `aria-current="location"`) and `NextLinks` (quiet links onward with the arrow icon).
  In `index.css`: `prose` (a 70ch measure, line height 1.7, the list markers and the
  rhythm between blocks), `doc-heading` (a section heading in long text, 20 px) and
  `callout` / `callout-amber` (a note set off by a rule on its left, for the draft,
  the translation note and "check by ear"). Used by the legal pages, the credits, how
  it works, the FAQ and the glossary.
- **Page header:** `components/ui/PageHeader.jsx`: the page's one `h1` in
  `heading-headline`, an optional way back or eyebrow, a lede and an action.
- **Tabs:** `components/ui/Tabs.jsx`: sentence case, the accent underline, the
  arrow keys, Home and End (the ARIA tabs pattern); the page keeps which is open.
- **Headings:** `heading-display`, `heading-headline`, `heading-section`, `heading-title`.
- **Text:** `lede`, `label`, `readout` and `unit` (a unit after a readout), `link`
  (a link in prose, underlined).
- **Empty states:** `components/ui/EmptyState.jsx`: a small waveform, one line, one action.
- **Loading:** `components/ui/Skeleton.jsx` (`Skeleton`, `SkeletonRows`); no spinners for under 300 ms.
- **Icons:** `components/ui/Icon.jsx`: one line set, 1.5 px stroke, inline SVG. No emoji.
- **The signature:** `components/ui/Waveform.jsx` (`Waveform`, `WaveRule`).
- **Focus ring:** 2 px accent outline, 2 px offset, on everything the keyboard reaches.

## 7. The Vercel checklist the result must pass (selection)

- Every interactive element is reachable and operable by keyboard, with a visible focus ring.
- No layout shift: images and canvas have sizes; fonts swap without reflow where possible.
- Numbers are tabular; units have a thin space or are in a smaller muted style.
- Headings use `text-wrap: balance` and copy uses `text-wrap: pretty`.
- Hit targets ≥ 24 px everywhere and ≥ 44 px on touch.
- Forms keep values on error, show errors next to the field, and disable submit only while sending.
- The colour scheme is set (`color-scheme`), the theme colour meta follows the theme
  (`ThemeContext` rewrites it on every switch), and the light and dark themes are both
  designed, not inverted.
- Long text truncates gracefully; nothing overflows at 320–375 px; the site works at 200 % zoom.
- Links look like links in prose; external links say so (an arrow, and
  `common.newTab` for a screen reader).

## 8. Accessibility (WCAG 2.2 AA)

- Contrast as in §2 and §9. Focus is never hidden behind the sticky bar
  (`scroll-padding-top` on `html`, `scroll-margin-top` on every `[id]`).
- Landmarks: header, nav, main, footer; one `h1` per page; ordered headings.
- Every icon-only button has an accessible name.
- Live regions for progress (kept).
- Language switching sets `lang` (and `dir`).
- axe-core runs on every public page in both themes: `pnpm --dir site/e2e test tests/a11y.spec.js`.

## 9. Measured (2026-10-28)

Contrast, computed from `index.css` (WCAG 2 ratio; the lowest surface first):

| Ink | Dark: bg / surface / surface-2 / surface-3 | Light: bg / surface / surface-2 / surface-3 |
|---|---|---|
| text | 16.94 / 16.01 / 15.17 / 13.92 | 17.76 / 19.05 / 16.98 / 15.63 |
| muted | 8.22 / 7.77 / 7.37 / 6.76 | 7.47 / 8.02 / 7.14 / 6.58 |
| dim | 5.66 / 5.35 / 5.07 / 4.65 | 5.41 / 5.80 / 5.17 / 4.76 |
| accent (and the focus ring) | 10.56 / 9.98 / 9.46 / 8.68 | 6.21 / 6.66 / 5.94 / 5.47 |
| red | 6.60 / 6.23 / 5.91 / 5.42 | 6.26 / 6.71 / 5.98 / 5.51 |
| amber | 10.79 / 10.20 / 9.66 / 8.87 | 5.93 / 6.37 / 5.67 / 5.22 |
| tempo | 10.78 / 10.19 / 9.65 / 8.86 | 5.99 / 6.43 / 5.73 / 5.27 |
| line-control (a field's edge) | 3.45 / 3.26 / 3.09 / — | 3.20 / 3.43 / 3.06 / — |

- Text on fills: accent-ink on accent 8.55 dark, 6.66 light; red-ink on red 6.38 dark, 6.71 light.
- Each signal colour on its own 10-15 % tint (a chip, a pressed tool button): dark
  4.86 (red) to 7.15; light 4.61 (amber) to 4.77.
- High contrast: every text token 7.18:1 or more on every surface in dark, 7.28 in light.
- Colour-blind separation (smallest CIELAB ΔE between accent, red, amber and tempo
  under protanopia, deuteranopia and tritanopia): default light 3.7, dark 11.5;
  colour-blind palette light 32.6, dark 42.2.
- axe-core (WCAG 2.0-2.2 A/AA tags), every public page, the palette, a result page
  running and done, profile and history, in dark and light: 50 of 50 clean.
- Build (`vite build`): CSS 66.1 kB (13.0 kB gzip) against 52.7 kB (10.1 kB) on
  master; entry JS 397.9 kB (127.9 kB gzip) against 390.7 kB (125.2 kB); initial JS
  163.8 kB gzip of the 200 kB budget (`scripts/budget.mjs`: ok). Fonts: 142,632 bytes
  of Latin woff2, loaded as text needs them.

## 10. Where the foundation departed from the first draft, and why

- **`--dim` dark `#80868f` → `#848a93`:** the draft's value read 4.41:1 on
  `--surface-3`, and labels sit in wells. Now 4.65.
- **Light signal colours darker** (accent `#0a7480` → `#076672`, amber `#8f5e08` →
  `#835606`, red `#c42e3b` → `#ad2834`, tempo `#3d7a1c` → `#356b18`): master had
  already darkened accent and amber (W10.2) because each must read on its own 10-15 %
  tint (a chip, a pressed tool button), not only on a panel; red and tempo now do
  the same, since `chip-red` and `chip-tempo` exist.
- **`--line-control` added:** the draft's control border (`--line-strong`, 1.5:1) is
  fine for buttons, whose label identifies them, but a text field's edge is the only
  thing that says "type here" (WCAG 1.4.11), so fields get a 3:1 edge.
- **The sheet menu below 1024 px, not 768:** the seven places need 383-563 px across
  the ten languages (Russian the widest, measured in Geist at 13.5 px); the bar has
  them from 1024 px and not below, where they would scroll inside the bar with
  nothing to say so.
- **The hero splits 6/6, not 7/5:** at 5 columns the example strip's four readouts
  were cramped and the strip read small; it is the product shot.
- **The ticker kept, as a still status line:** it carries the site's own lines and
  the Mides structure, but a marquee that never stops is the one perpetual motion the
  rules forbid outside the playhead. It no longer scrolls, is not sticky, and is not
  drawn below 768 px.
- **Archivo has no Cyrillic:** Russian display text falls to Geist (section 3).
- **The content pages (`design/content-pages`):** long text keeps a 70ch measure inside
  the wide layout rather than a narrow page column (the owner found 72ch columns
  cramped; the contents list fills the side instead). The status page's "down" and
  "unreachable" keep red (`chip-red`): it is how the site already says an error
  (`text-red` on every failure message), and no other reserved colour means "broken".
  The pipeline on `/how-it-works` is HTML, not an SVG: six across from 1280 px, three
  on a tablet, two on a phone, so its words never shrink with a viewBox; its one red
  line falls where the steps start making red lines (Sections).

The core pages (`design/core-pages`: Analyze, the queue, the result page, `/t/:id`,
Compare) added these, each for the reason given:

- **The result page has three zones** (listen, check, export), each under a
  `SectionHeader`, with an "On this page" row of jump links above them. It is the
  densest page on the site; a reader who came for the .osz should not scroll past the
  map to find it, and one who came to listen should not meet the exports first.
- **One primary per zone there, not per page:** Play in the transport and Download .osz
  in the export panel. Play is the instrument's own control, used every few seconds;
  as a ghost it read as optional. Everything else on the page (Publish, Analyse again,
  Save a version, Choose an .osu) became a ghost.
- **Folds, `components/result/Disclosure.jsx`:** a native `details` whose summary names
  everything inside it. Used twice: practice and the by-ear tools, and the beat-snap
  chart with the .osz options. What is folded stays mounted, so its keyboard shortcuts
  (T, A) work folded. Nested `details` use named groups (`group/…`) so an inner chevron
  does not turn with the outer one.
- **The tempo map and the red lines table are the panels** of their zones; check here,
  compare with a map, how it was analysed and sharing sit between hairlines.

The community and account pages (`design/social-pages`) departed from what they had:

- **A suggestion's state is accent or neutral, not amber, green or red:** "under
  review" was amber, "planned" the tempo green and "rejected" red, and each of those
  colours means something else here (section 12). Planned, in progress and done are
  the accent (it is going somewhere); open, under review and rejected are neutral, and
  their word says which. The same for a hidden item (neutral, with the eye icon) and
  the API reference's methods (a read in the accent, a write in plain text).
- **Stars are the icon set's `star` and `star-filled`, in amber:** a rating stays
  amber as it was (the one non-signal use, kept because five amber stars are what a
  rating looks like everywhere); the `★` character is gone.
- **A profile is not a card:** the banner is a band (the site's waveform, seeded by
  the name, when there is no banner), the name the page's heading, the totals a row
  of readouts a hairline apart.
- **Settings, two columns from 1024 px:** each group's name and note on the left, its
  controls on the right, a hairline between groups; not a panel per group, since the
  page is one form.

## 11. Guide for restyling a page

Read sections 1, 4 and 6 first. Then, for each page:

1. **Start from what you operate.** A form, the drop zone, the map, a table: those
   are `panel`s. Everything else (copy, lists of facts, headings) sits on the page's
   own ground, separated by space and one hairline (`border-t border-line`). Never a
   `panel` inside a `panel`; use `panel-well` inside.
2. **Head each section with `SectionHeader`** (`components/ui/SectionHeader.jsx`):
   `eyebrow`, a short `title`, an optional `lede`, an optional `action` (usually a
   `btn-quiet` link with `<Icon name="arrow-right" size={16} />`). The page's `h1`
   is `heading-headline` (or `heading-display` on a landing page), sentence case;
   remove `uppercase` and the old `font-display ... uppercase tracking` strings.
3. **Buttons:** one `btn-primary` per view for the main action; `btn-ghost` for the
   rest; `btn-quiet` for "more" links. Sizes with `btn-sm` / `btn-lg`, not `h-*`.
   Icon-only: `icon-btn` with an `aria-label`. Toolbar toggles: `tool-btn` with
   `aria-pressed`.
4. **Numbers are readouts:** `readout` on every BPM, ms, offset, count, time; a unit
   after it as `<span className="unit">ms</span>`. A row of stats is a `dl` of
   readouts separated by hairlines, not cards.
5. **Labels** for fields, columns and stats: `label`. Inputs: `field` with a real
   `type`, `autocomplete`, `inputmode`; the error next to it with `aria-invalid`.
6. **States:** chips in the reserved colours only (`chip-red` for red lines,
   `chip-amber` for check by ear, `chip-tempo` for tempo, `chip-accent` for signal,
   `chip-neutral` otherwise). Loading: `SkeletonRows` or `Skeleton` shaped like the
   content. Nothing to show: `EmptyState` with one action.
7. **Icons** come from `components/ui/Icon.jsx` (add one there, 24 px grid, 1.5 px
   stroke, if a page needs it). No emoji, no `×` or `→` characters for controls.
8. **Motion:** a list or grid below the fold may use `Reveal` with `data-reveal` and
   `style={{ '--i': i }}` on each item; a menu or popover `pop-in` with `--origin`;
   transitions with `duration-150 ease-out` (the strong curve). Animate transform and
   opacity only; nothing on what is used hundreds of times.
9. **Links:** in prose, `link` (underlined). External: the `external` icon and
   `<span className="sr-only">{t('common.newTab')}</span>`.
10. **Strings:** add keys, never rename; all ten locale files, English first.
11. **Check:** 375, 1024 and 1440 px; dark and light; en, de (long words), ja (CJK),
    ru (Cyrillic). `pnpm --dir site/web test`, the build, and axe on the page
    (`site/e2e/tests/a11y.spec.js` covers every public page).

## 12. What stays

- **Behaviour:** routes, data, i18n keys (add keys rather than rename; ten locale files must stay in sync), and every feature's behaviour. This is a visual and interaction rework, not a feature change.
- **Reserved colour meanings:** red = red lines, amber = check by ear, tempo = the tempo curve, accent = action and signal.
- **The logo:** `components/Mark.jsx` and `assets/logo-web.svg`.
