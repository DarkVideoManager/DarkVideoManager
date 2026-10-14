# DarkVideoManager local SEED adaptation

This document describes a local interface adapter inspired by the supplied design guide. It is not an official SEED distribution or an exported SEED token set.

## Tokens

`src/renderer/styles/seed-tokens.css` provides the semantic dark workspace palette, spacing, radii, and type scale.

- Foreground: `#f3f4f5`; dark surface: `#16171b`
- Spacing: 4, 8, 12, 16, 24, 32px
- Radius: controls 8px, cards 12px, dialogs 16px
- Type: system stack; title 26/35, body 16/24, metadata 14/19; 400/500/700 weights
- `--seed-brand` is a local orange adaptation for participation/create actions, used only for library import/creation.

## Application

The workspace gives each context one strong action: **가져오기** in the library header and **라이브러리 추가** in the navigation rail. Navigation, search, counts, and selected-library state are neutral. Empty, loading, and error states explain the next action; the error state includes an in-place retry.

## Responsive behavior

The shell uses `100dvh`, preserves scrolling inside the content pane, maintains 44px touch targets, and allows library chrome to wrap rather than squeeze. Keyboard focus uses a high-contrast visible ring.
