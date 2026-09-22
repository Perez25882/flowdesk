# Brag Plan: Flowdesk

## What is this app?
Flowdesk turns a Ghanaian shop's WhatsApp conversations into tracked orders,
confirmed payments and a bookable diary, without the customer installing
anything or changing the number they already message.

## The angle
**The receipts, not the pitch.** Every claim on screen is shown with the
mechanism behind it, using one customer conversation as the spine and then
following that same order into the product.

The film is built on one continuity: a message arrives at 06:41, the assistant
prices it, haggles, refuses to go under the floor, and the resulting order
`FD-02214` is the top row of the dashboard three scenes later, for the same
amount. Nothing is a mock-up of a different shop.

## Hook (first 2-3 seconds)
A WhatsApp thread, drawn in WhatsApp's own colours, with one inbound bubble:
**"Morning. 2 bags of the 5kg jasmine rice and a crate of eggs?"** at **06:41**.
Then the three dots. No logo, no title card, no product name for nine seconds.

## Two visual languages, on purpose
- The chat panel is **WhatsApp's** (`#efeae2` paper, `#d9fdd3` outbound, read
  ticks, the typing bubble), because that is the surface the customer is
  actually on and drawing it in Flowdesk's colours would be a lie.
- Everything else is **Flowdesk's** palette and components.
- The dark rail between them is the seam: it is the only thing on screen the
  customer never sees, which is exactly why it is worth showing.

## Showing that the assistant is the one replying
Three signals, none of which is a caption saying "AI":
1. The header switches to **typing…** and a three-dot bubble appears before
   every outbound message.
2. The **Flowdesk assistant** rail runs live beside the thread, showing the
   grounding as it happens: intent, the catalogue match, the list price, the
   floor.
3. In the diary, two appointments carry the real badge **booked by Flowdesk**.

## The moment the whole film is built to earn
The customer offers **GHS 90**. The rail shows, line by line:

```
OFFERED    GHS 90.00
FLOOR      GHS 95.00
DECISION   refused  ·  below floor
COUNTER    GHS 95.00  ·  sent
```

and only then does the reply land: **"I can do GHS 95, not less."** The caption
underneath is the thesis: **The floor lives in the database, not the prompt.**

## Arithmetic, not decoration
Every figure survives a pause-and-check:
- 2 x 95.00 = 190.00, plus 58.50 = **GHS 248.50** on the order card
- that same **248.50** is the FD-02214 row on the dashboard
- the dashboard's **"worth GHS 742.50"** is 248.50 + 316.00 + 178.00, the three
  rows printed directly under it
- **"across 9 orders"** against GHS 2,480.00 averages GHS 275, which is what a
  provisions shop actually looks like

## Screen copy is verbatim from the app
"Today" / "Overnight, and what is still open." / "Open the board" / "Money in
today" / "Awaiting confirmation" / "Payments to verify" / "Money owed to you" /
"Waiting on you" / "All orders" / "Bookings" / "What you offer, and who is
coming in." / "Next free times" / "booked by Flowdesk" / "That time was just
taken" / "Finish setting up" and all six of its step titles / "Every order, out
of your chats." / "14 days. No card."

## Format: landscape, 1920x1080
## Duration: 46.5 seconds
## Tone: polished. Long holds, soft crossfades, no zooms, no flashes.

## The seven lines under the stage
One quiet line holds the bottom of the frame in each scene. They escalate from
observation to mechanism:
1. **Nobody was awake.** (3.3s)
2. **That was not a person.** (9.4s)
3. **The floor lives in the database, not the prompt.** (15.75s)
4. **A priced order, out of a conversation.** (21.8s)
5. **The 06:41 one is already at the top.** (28.75s)
6. **Two bookings cannot share a slot. Postgres refuses.** (34.6s)
7. **Six steps, once.** (40.7s)

Every line holds at least 0.3s per word before it leaves.

## Storyboard

| # | Scene | Window | What must be seen |
|---|---|---|---|
| 1 | 06:41 | 0 - 4.5s | One inbound bubble, the timestamp, the typing dots |
| 2 | What it is doing | 4.5 - 11.0s | The rail: intent, catalogue match, list price, floor locked. Then the reply lands with read ticks |
| 3 | The floor | 11.0 - 18.5s | The GHS 90 offer, the refusal, the counter at exactly the floor |
| 4 | The order | 18.5 - 23.5s | FD-02214, two lines, GHS 248.50 |
| 5 | Today | 23.5 - 31.3s | The real dashboard, four metrics, and FD-02214 glowing at the top of "Waiting on you" |
| 6 | Bookings | 31.0 - 37.2s | The diary, two "booked by Flowdesk" badges, and a fourth booking bouncing off a taken 10:00 |
| 7 | Setting up | 37.0 - 42.0s | "Finish setting up", six real step titles, the bar filling to 6 of 6 |
| 8 | Outro | 42.0 - 46.5s | Mark, wordmark, "Every order, out of your chats.", "14 days. No card." |

## Visual identity (from the project)
- Background `#f7fbfd`, surface `#ffffff`, sunken `#f2f8fb`
- Ink `#0f161a`, ink surface `#152029`, primary `#2a3e4b`, primary light `#d6e6ef`
- Clay accent `#99502b` on wash `#fdf3ee` with border `#dfb8a4`
- Muted text darkened from the app's `#5a707c` to `#52656f`, and WhatsApp's own
  meta colours darkened likewise, because both fail WCAG AA at these sizes and a
  timestamp nobody can read is not authenticity
- Plus Jakarta Sans (400/500/700/800) and JetBrains Mono (400/500/600), both
  self-hosted from the same families the app loads. No network fetch at render
- The mark is defined once as an SVG `<symbol>` from the real traced geometry in
  `apps/web/src/lib/brand-mark.ts` and referenced by the two sidebars and the
  outro lockup, so the three can never drift
- The highlighter under "your chats." is the real one: across the baseline so
  the descenders cut through it, a solid `#d6e6ef` tint rather than a
  transparency

## Audio direction
- Role: warm bed with sparse, motion-matched accents
- Music: `happy-beats-business-moves-vol-1-by-ende-dot-app.mp3`, 120.19 BPM
- Treatment: in at 0.40 under the first bubble, 0.78 through the body, 0.88 into
  the outro, fading to nothing across the last 1.2s so the final line reads in
  silence. Mastered to about -19 LUFS with no limiting
- Beat grid extrapolated from the bundled preset at the stated tempo. Rail lines
  land every other beat so each is readable; the four dashboard cards and the six
  setup ticks land on consecutive beats, then the full set holds
- Beat-locked: the mark at **42.458s**, the hero line at **43.456s**
- Audio-reactive: subtle. The page wash follows overall RMS and the order card's
  glow follows the two lowest bands, as GSAP keyframe arrays rather than
  per-frame callbacks so every seek is reproducible. Nothing carrying text reacts
- SFX: nine cues in 46.5 seconds, one per real visual event, never two inside a
  second, nothing brighter than medium high-frequency risk. The bell on the mark
  is allowed to ring over the fading bed
