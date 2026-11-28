# Nevergear — Design System

This file is the visual source of truth for the Nevergear website. Keep new pages and changes aligned with these decisions.

## Brand

Nevergear, formerly called Wii, is a browser arcade arena where the body is the controller. The site should feel thoughtful, precise, calm, and ambitious: editorial typography over a light interface that borrows Nevergear Sports' white and blue (Frutiger Aero: clean, light, and tactile, on the site and in the arena alike).

The wordmark is the Nevergear sticker logo (`public/images/nevergear-logo.png`): rounded grey “Never”, italic blue “Gear”, white outline. Use the image; do not retype the name in a font as a mark.

## Color and surfaces

### Palette

| Role | Light | Dark | Source |
| --- | --- | --- | --- |
| Canvas | `#f4f8fa` | `#1b1c19` | `--paper` |
| Ink | `#05090c` | `#f2f1ec` | `--ink` |
| Muted text (high contrast, by request) | `#1f2a32` | `#a3a49b` | `--muted` |
| Accent: highlights and interaction feedback, used sparingly | `#ade4f8` | `#8e916e` | `--accent` |
| Nevergear blue: glass edges, button borders, speed lines | `#34beed` | — | literal |
| Deep blue: focus rings, headings in the arena | `#1a8fc4` | — | literal |
| Blue text on light | `#0b6f9e` | — | literal |
| Nevergear orange: small details only (title stripe, a few speed lines) | `#f59b3c` | — | literal |
| Ready green: tracking and calibration states | `#4cbf6b` | — | literal |
| Nevergear grey: wordmark in the arena and the opening | `#8b949c` | — | literal |
| Nevergear Menu greys: background, empty channel, footer, channel edge and label | `#d5dbe0` `#bcc3ca` `#b4bdc5` `#8f9aa4` `#737e88` | — | literal |

New work uses these colors; do not introduce others without adding them here.

### Surfaces

- The site is light only (Frutiger Aero, Nevergear Sports): there is no dark mode. Faint TV scanlines and a soft light-blue fade at the bottom of the canvas; header, product pill and Mii controls are glass with a light-blue edge.
- Every button is a glossy pill with a deep-blue edge (solid blue for the primary action); every panel is light glass with a light-blue edge. The shared tokens are `--aero-*` in `src/site.css`; reuse them.
- Shadows are blue-tinted (`rgba(26, 110, 168, …)`), never neutral grey or olive-black.
- Text selection is a translucent blue, so it never hides tightly spaced headline lines.
- Glass surfaces use a translucent paper tint, a fine border, restrained shadow, and backdrop blur. Keep enough tint for text behind a card to become unreadable.
- Prefer rounded pills for compact controls and softly rounded cards for content. Avoid boxed rules and decorative borders that interrupt the editorial page flow.

## Typography

- Sans: Manrope, with the existing system fallbacks. Use it for headlines, body copy, and interface labels where a clean reading voice is needed.
- Mono: DM Mono, with the existing system fallbacks. Use it for navigation, metadata, small status labels, and the Vision page's editorial text.
- Serif italics are reserved for the short editorial accent in the Product headline. Do not apply italics or bold to whole paragraphs.
- Definition card: a restrained medium-weight sans title; small mono part-of-speech label; readable, regular-weight sans definition; muted secondary line. Italicize only the part-of-speech word.
- Do not add a new font family without updating this system and getting an explicit design reason.

## Header and motion

- The compact header wordmark always shows the dot on the last “i”: as the home webcam fades out, the real dot fades in at its place.
- Keep `Nevergear` centered in the header as the page scrolls. It begins as the large home-page wordmark and settles into the compact header position without jumping.
- The navigation becomes a narrow, light glass surface while scrolling: subtle blur, fine border, soft shadow, and a shorter height.
- The header, centered wordmark, and definition card must remain legible and within the viewport at browser zoom and at 320 px CSS width.
- Hover feedback should be small and clear: a fine underline, slight color change, or a one-pixel lift. Avoid jitter, looping motion, and pointer-driven movement of content. The one exception is the webcam's red recording dot, which blinks only while the pointer or keyboard focus is on the webcam and stops (steady red under reduced motion) when it leaves.
- The definition opens from the Nevergear wordmark only. It stays open while the pointer moves from the wordmark onto the card and closes when moving to Product or another control.
- The custom page scrubber is a visible, compact glass capsule with a readable track and thumb. Keep pointer dragging and keyboard navigation; do not reduce it to a tiny line.
- Home exceptions to the hover rule above: each Nevergear letter hops on hover (and the webcam, which is the dot of the final "i", follows it), and the gallery highlights one card at a time every 7 s with the same lift as hover. Both are disabled under reduced motion.
- Papers exceptions: any `Nevergear` in running text (not the wordmark) shows a short speech bubble on hover. Under reduced motion the bubble animation is off.
- Respect reduced-motion preferences.

## Definition card

- The Nevergear definition appears only when hovering or keyboard-focusing the Nevergear mark in the shared header, on every route.
- Keep the glass card centered beneath the mark, readable at compact and large viewport sizes, with no scaling tied to the wordmark size.
- The card copy should describe the body-as-controller idea in plain language and retain enough detail to communicate the vision. The card does not belong in the Vision page body.

## Page composition

Use whitespace for hierarchy. Keep the pages minimal and avoid adding sections or labels that were not requested.

### Home

- Home places a still archive of milestones of body and motion as input (from the Vitruvian Man to Kinect) around the centered Nevergear wordmark. Keep the artifacts static, make each one link to its primary or archival source, and preserve room around the wordmark. Add a small webcam SVG in place of the dot of the final “i” (rendered as a dotless “ı”); fade it as the wordmark settles into the compact header. Hovering or focusing the webcam opens a matching glass card that explains its role in live capture. Place that card to the wordmark’s right on desktop and below it on narrow screens, clear of the page scrubber. Keep the webcam card separate from the Nevergear definition card. On narrow screens, move the archive below the first-screen mark. On load, trace each archive frame as a stroke in staggered order, then let the frame's paper, artwork, and caption fade in from a blur. Let the Nevergear wordmark emerge from depth on first load: it starts small, blurred, and pushed back, then settles forward to full size and sharpness over about 1.3 s. On hover or focus, an archive frame grows about 4.5% and gains a soft shadow beneath it (no growth under reduced motion). Reduced-motion users see everything at once.
- Below the home archive, a games showcase (one screenshot and short text per game, revealed on scroll, ending in “Play now”), then the Mii creator: a draggable 3D preview beside the form (stacked on narrow screens), with photo/webcam suggestion as an option. The face is the same `MiiFaceSpec` the arena games and editor use. Its controls are Frutiger Aero glass: pill buttons with a top highlight, deep-blue edge and blue-tinted shadow; the single primary action (“Save”) is solid blue with white text; fields are glass pills and color swatches glass beads with a clear selected ring. Hover lifts and sweeps one highlight across (never looping), press sinks; reduced motion removes both.
- Computer and player Miis wander on every site page (not `/app`) on a layer that never takes the pointer. Clicking one only makes it grumble; holding and dragging carries it elsewhere.

### Vision

- Vision is an uninterrupted editorial page: a large centered Manrope headline (medium weight, tight tracking, matching the Product headline), readable centered mono paragraphs, and a quiet mono sign-off. A local canvas renders a Sailor Moon inspired portrait as ASCII above the headline; her eyes open on entry, blink, and wink while separate waves move through the twin tails. On entry the portrait is not drawn as a stroke: its symbols appear from the top down, scattered, over about three seconds, and only then do the eyes and hair begin to move. Taper the portrait's lower silhouette so it does not end in a rectangular crop. Type the headline and copy in one measured reading order, with the full copy immediately available to assistive technology and reduced-motion users. If the reader keeps scrolling down (about 260 px of wheel, touch, or key intent, which resets after a brief pause), stop typing and let the remaining copy emerge from a blur with a 640 ms fade, leaving typed text untouched. Reduced-motion users get the full copy immediately. Do not insert a dictionary card, eyebrow, or horizontal rules into the Vision copy.

### Papers

- Papers (`/papers`, the “papers” tab beside “vision” in the header) is a stage with no cards in the page body: a large centered Manrope “papers” headline, one short mono line under it that cycles every ~4.8 s (fades through a blur), and the five research-paper proposals from `docs/research` orbiting on a slow ellipse as small glass cards (number + short name; the ones passing in front are larger and sharper, the ones behind smaller and faint, and the title stays above those behind). The ring keeps turning under the pointer (cards are never stopped by hover, so none slips away from a click) and eases to a stop while a card has keyboard focus or its summary is open; clicking a card opens a glass panel under the headline with the title, one-sentence summary and “close” (Escape also closes), and the panel sits above every card. Article pages render the source Markdown with illustrations, captions, and an interactive matrix where available. Readers can download the article as a PDF. The copy must stay honest: the collection is proposals, not validated results (“no results yet”). Reduced-motion users get a static ring and a static line. The header's `vision`/`papers` links drop to 12 px under 640 px so they clear the centered Nevergear mark at 320 px.

### Product

- Product uses the shared pill style for its “under construction” status, a centered ASCII illustration that settles still after its entry, a clear headline, and concise explanatory copy.
- The Product construction illustration is rendered as colored ASCII symbols on a canvas, using the same glyph-ranking approach as the Vision portrait. On entry its symbols appear from the top down, scattered, slowly over about 4.6 s, then the artwork stays still. Do not animate or parallax it afterward. Reduced-motion users see it at once.

## Arena (`/app`)

- Opened by the Product “under construction” pill; source in `src/arena/`. Athletics, boxing and tennis use body pose through the webcam, full screen, with no site header, scrubber or Nevergear speech bubble, under its own tab title.
- Skin: light Nevergear-style Frutiger Aero using the palette above (white and light blue, glossy pill buttons with a blue edge, soft gradients and shadows). Arena styles stay nested under `.arena` so they never reach the site.
- Order: a white screen, then the blue “Nevergear” wordmark rushes forward and the screen splits open; body calibration starts (the camera starts automatically and “Skip” bypasses calibration); the channel screen shows four playable channels, with no empty placeholders (Nevergear Sports, Athletics, Boxing, and Tennis). On the first visit, the channels appear in a row for about one second, then settle into an elliptical ring with Nevergear Sports in front. Hand rotation, arrow buttons, or a channel click can bring a channel to the front. Each channel has a glass highlight. Clicking the front Nevergear Sports channel grows it in three steps: the ring and footer fade (0.3 s), an empty glass pane grows from the tile to fill the screen (0.65 s), then the title screen appears. The title screen offers the menu and start actions; the main menu offers Athletics, Boxing, and Tennis with a preview; choosing one starts the game and provides a Games control to return.
- On the main menu, the Nevergear Sports wordmark returns to the channel screen.
- The only site control is “exit”, shown just on the channel grid, in its footer at bottom left, below the blue curve.
- “Exit” uses the camera button’s font (the arena’s rounded sans, bold, uppercase); the minimized “Camera” pill and “Exit” share a Frutiger Aero glass finish (top highlight, light-blue body, blue edge and glow).
- The corner camera panel has a minimize button that shrinks it to a “Camera” pill; calibration still opens it full screen.

### Entering and leaving

- Entering plays a radial warp tunnel (about 2.3 s, `src/lib/warp.ts`): speed lines in the palette blues, with a few orange ones, on the light canvas, accelerating toward the viewer with motion-blur trails and a slight twist, ending in a white flare.
- Then the arena arrives under a white flash that fades over about 1.3 s while it settles from overexposed with a small punch-in.
- Leaving (“Exit”) is its own sequence: the arena washes out to white (about 1.1 s), then the Product page returns from far away, shrinking to normal size while the white fades (about 1.5 s).
- Reduced motion: no tunnel, flash or channel zoom.

## Interaction and responsive behavior

- Navigation links and controls need visible hover and keyboard-focus states.
- The PT/EN language choices stay inside the viewport on narrow screens.
- The location label is not a link. On hover or keyboard focus, “São Paulo, Brazil” lifts slightly and a hairline divider with “São José dos Campos” fades in beneath it.
- Keep the location label's response restrained on desktop. On narrow layouts, prioritize the centered wordmark and prevent overlap with the language choices.
- Test critical header/card layouts at desktop width, 640 px, and 320 px, including while the home wordmark is transitioning on scroll.

## Opening sequence

- Plays on each page load (not in `/app`) and is always light, in the site’s Nevergear white and blue (artwork in a blue duotone, grey “Nevergear”): a documentary title sequence, not a web page. No cards, bubbles, containers, hard-edged light circles, neon or cyberpunk styling.
- One continuous timeline (about 46 s, skippable with “skip” or Escape): the two questions over a faint “Nevergear”, then the camera travels through the eight milestones in depth, then “Nevergear” alone and a fade to the site.
- The picture is raw WebGL (`src/lib/introScene.ts`): noise-shaped diffuse light, dust, artwork with dissolved edges, depth of field, restrained bloom, vignette and film grain. Text is bare light typography set directly over the picture.
- Camera drift is autonomous, never pointer-driven. Reduced motion holds the camera and grain still and only crossfades. Without WebGL the artwork shows as plain images.
- Adaptive quality (`src/lib/quality.ts`): Lite, Medium and Ultra change only internal resolution, shader cost, particles, light warp and bloom; layout, timing, vignette and grain stay. A short non-blocking benchmark of the real shaders picks the start level, then frame times adjust it with hysteresis. The profile is stored in `localStorage` (`nevergear-quality`), measured again after 7 days or a GPU/screen change; the quiet top-right control (or `?quality=`) overrides it. Nothing is sent anywhere.
- Leaving (end or skip) is ordered: the current frame and text freeze and fade (about 0.5 s), the veil dissolves (1 s), and the page entrance, held until then, builds up piece by piece: header, wordmark, then each archive frame’s traced line, paper, artwork and caption in sequence. The automatic card highlight starts only afterwards.
