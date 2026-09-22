# Hyperframes Composition Brief: Flowdesk

## Objective
A launch film for Flowdesk that shows the product working end to end, not a
title-card promo. One customer conversation is followed all the way into the
dashboard.

## Output
- Composition: `brag-output/composition/` (single `index.html`, assembled by a
  build script so the repetitive markup stays generated rather than typed)
- Render: `brag-output/brag.mp4`, landscape 1920x1080, 46.5s, 30fps

## Source material
- Project root `/home/claude/flowdesk`
- Screen copy lifted verbatim from `apps/web/src/pages/Dashboard.tsx`,
  `Bookings.tsx`, `components/shared/SetupChecklist.tsx`,
  `config/navigation.ts`, `pages/Landing.tsx`
- Mark geometry from `apps/web/src/lib/brand-mark.ts` and wordmark outlines from
  `brand-wordmark.ts`, extracted by script so the film cannot drift from the app
- Palette, shadows, radii and the highlighter from `styles/globals.css`
- Fonts self-hosted from the same families the app loads

## Creative direction
- Tone: polished. Long holds, soft crossfades, no zooms, no flashes, no eyebrow
  pills, no em dashes on screen
- Angle: the receipts, not the pitch
- Hook: one WhatsApp bubble at 06:41, no branding for nine seconds
- Two visual languages, kept separate on purpose: WhatsApp's for the chat,
  Flowdesk's for everything else, with a dark assistant rail as the seam

## Non-negotiables this composition holds to
- **Continuity.** `FD-02214` at GHS 248.50 in scene 4 is the same row, same
  amount, at the top of the dashboard in scene 5
- **Arithmetic.** Every figure reconciles with every other figure on screen,
  including the dashboard's "worth GHS 742.50" against its own three rows
- **The assistant is visibly the author.** Typing indicator, a live grounding
  rail, and the real "booked by Flowdesk" badge in the diary
- **Readability.** Every line holds at least 0.3s per word. Sequential items that
  are text land every other beat; only non-text accents take consecutive beats
- **Contrast.** 75/75 text checks pass WCAG AA. WhatsApp's own meta colours and
  the app's `--muted` were darkened to get there rather than waived
- **Determinism.** Audio reactivity is GSAP keyframe arrays, not per-frame
  callbacks; no clocks, no unseeded randomness, no network at render time

## Audio
- `happy-beats-business-moves-vol-1-by-ende-dot-app.mp3` at 120.19 BPM
- Bed 0.40 in, 0.78 body, 0.88 outro, fade to silence over the last 1.2s
- Beat-locked: mark 42.458s, hero line 43.456s
- Nine SFX cues, one per real visual event, none brighter than medium
  high-frequency risk
- Master lands at -17.7 LUFS / -2.4 dBTP with no limiting

## Gate
`npx hyperframes check` must pass: lint, runtime, layout, motion and contrast.
