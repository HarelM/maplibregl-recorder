# maplibregl-recorder

[**API documentation**](https://harelm.github.io/maplibregl-recorder/) ·
[issues](https://github.com/HarelM/maplibregl-recorder/issues)

Records the calls an application makes into [MapLibre GL JS](https://github.com/maplibre/maplibre-gl-js)
and writes them back out as **a single self-contained HTML page that makes those
same calls**.

Not a recording plus a player — the actual JavaScript:

```js
const map = new maplibregl.Map({
    zoom: 12,
    center: [11.39085, 47.27574],
    pitch: 60,
    style: { version: 8, sources: { /* ... */ }, layers: [ /* ... */ ] },
    container: 'map'
});
const navigationControl = new maplibregl.NavigationControl({visualizePitch: true});
map.addControl(navigationControl);

// MapLibre refuses to touch the style until it has resolved.
await new Promise(resolve => map.once('style.load', resolve));
map.setTerrain({source: 'terrain', exaggeration: 1});

await new Promise(resolve => setTimeout(resolve, 1224));
const element = document.createRange().createContextualFragment('<div class="pin">1</div>').firstElementChild;
const marker = new maplibregl.Marker({element: element});
marker.setLngLat([11.39085, 47.27574]);
marker.addTo(map);
map.flyTo({center: [11.382, 47.313], zoom: 14});
```

Everything the recorder captures is public API, so it can be written back out as
source. That makes the export something you can read, edit and cut down to the
smallest case that still shows the bug. Open it, paste it into
[JS Bin](https://jsbin.com), or attach it to a GitHub issue — no build step, no
access to the original application needed.

> ### ⚠️ Experimental
>
> This package reaches into MapLibre's own classes, which are not a stable
> interface. **A MapLibre release can break it at any time**, and the recording
> format carries no compatibility promise. It is a debugging aid for producing bug
> reports — do not ship it in production, and do not build tooling on the format.

Requires **MapLibre GL JS 6 or later**, which ships as an ES module.

## Install

```bash
npm install --save-dev maplibregl-recorder
```

## Record

Attach **before the application creates its map**, otherwise the constructor
options can only be reconstructed approximately.

```ts
import * as maplibre from 'maplibre-gl';
import { MaplibreRecorder } from 'maplibregl-recorder';

// A module namespace object is read-only, so the recorder patches a copy of it -
// which means the application has to build its map from that same copy.
export const maplibregl = {...maplibre};

if (location.search.includes('record')) {
    MaplibreRecorder.attach(maplibregl);
}
```

or straight from a page, with no build step:

```html
<script type="module">
    import * as maplibre from 'https://unpkg.com/maplibre-gl@6/dist/maplibre-gl.mjs';
    import { MaplibreRecorder } from 'https://unpkg.com/maplibregl-recorder/dist/maplibregl-recorder.mjs';

    const maplibregl = {...maplibre};
    MaplibreRecorder.attach(maplibregl);
</script>
```

The package defines no globals. Everything is an import, including from a
`<script type="module">` — so nothing of the recorder's ends up on `window`,
where it could collide with the application it is meant to be observing.

Which object you pass matters. The recorder patches class **prototypes**, which
works however the classes were imported, but it can only capture
`new Map(...)` / `new Marker(...)` themselves by replacing the constructors on the
object it is given. A module namespace — what `import * as maplibre` produces — is
read-only, so those assignments silently do nothing and constructor options are
lost. Pass a plain copy, and have the application use that copy. Likewise, if the
application does `import { Map } from 'maplibre-gl'` and calls `new Map(...)`, that
binding cannot be replaced; fall back to `attachToMap` below.

### Last resort: an existing map

If the namespace really is unreachable, the recorder can patch a live map:

```js
MaplibreRecorder.attachToMap(window.someExistingMap);
```

Constructor options are then reconstructed from the map's getters, and
`Marker`/`Popup` calls are **not** captured, because those classes cannot be
reached from a map instance.

## Drive it

The panel is a MapLibre control, so it goes on the map like any other:

```js
import { RecorderControl } from 'maplibregl-recorder';
import 'maplibregl-recorder/dist/maplibregl-recorder.css';

map.addControl(new RecorderControl(), 'bottom-right');
```

```html
<link rel="stylesheet" href="https://unpkg.com/maplibregl-recorder/dist/maplibregl-recorder.css" />
```

Four icon buttons:

| | |
| --- | --- |
| ⏺ / ⏸ | start or pause recording. Red while it is capturing. |
| ✎ | **note** — label this moment. See below. |
| 🗑 | discard everything recorded so far |
| ⤓ | export the reproduction as an HTML page |

Discard and export are disabled until something has been recorded.

It drives the shared recorder by default; pass your own instance to use that
instead. It also keeps itself out of the recording — `map.addControl(<the
recorder's own panel>)` never reaches the reproduction.

The split is deliberate:

| | |
| --- | --- |
| `Recorder` | the engine. Records calls, hands back a recording. No DOM, no files. |
| `RecorderControl` | the front end. Buttons, and turning a recording into a page and putting it somewhere. |
| `emitScript` / `buildReproPage` | plain functions, for exporting with no user interface at all. |

## Export

The ⤓ button saves `maplibre-repro.html`. Everything it does is on the control
itself too, so the console can reach it — saving the raw recording, copying the
page, opening it in a new tab or in CodePen. See
[`RecorderControl`](https://harelm.github.io/maplibregl-recorder/classes/RecorderControl.html).

With no user interface in play, the conversions are plain functions:

```js
import { buildReproPage } from 'maplibregl-recorder';

buildReproPage(MaplibreRecorder.toJSON());
```

### Notes

`mark()` — the ✎ button — is the most valuable part of a bug report. A recording is
a few hundred calls with no indication of which one matters; a note says *the bug is
on screen right now*, at that point in the timeline:

```js
MaplibreRecorder.mark('markers are oversized here');
```

It becomes a comment at exactly that place in the exported script, so whoever reads
the reproduction knows which line to look at:

```js
map.flyTo({center: [11.382, 47.313], zoom: 14});

// === markers are oversized here ===
```

Nothing else about the recording changes — a note is an annotation, never a call.

### Into JS Bin

1. `control.copy()`
2. open <https://jsbin.com/?html,output>
3. select everything in the HTML panel and paste

## The exported page

A module that imports the recorded MapLibre version from unpkg and then makes the
calls. **It declares nothing of its own** — no helpers, no runtime, no scaffolding
to read past. Every `const` in it is one of the objects the application built.

Everything is meant to be edited:

- `await new Promise(resolve => setTimeout(resolve, n))` keeps the original
  pacing, capped at `maxDelay`. Delete the waits to run it flat out.
- `if (!map.loaded()) await new Promise(...)` sits in front of the first call
  that needed it, with a comment saying why. Delete it to reproduce a bug about
  calling too early.
- `// 412ms  map fired 'load'` comments are the recorded events, in place, and
  `// === ... ===` are your `mark()` annotations.
- a **user gesture** becomes a `jumpTo` to wherever the map came to rest, under a
  comment saying it is a reconstruction rather than a call anyone made.
- a call that threw during recording keeps its error as a trailing comment.
- the map is `window.map`, so the console can poke at it.

Values with no literal syntax are written out in full rather than through a
helper: a marker element is a `createContextualFragment(...)` line, an image is
`new Image()` plus a `src`, binary data is `Uint8Array.from(atob(...), ...)`.

## Before you send it to anyone

`attach` takes a second argument of options —
[`RecorderOptions`](https://harelm.github.io/maplibregl-recorder/types/RecorderOptions.html)
has the list. Two of them matter for reproductions that leave your machine:

- `recordFunctions` stores the source text of callbacks such as
  `transformRequest`. **Turn it off if your callbacks contain API keys.**
- `inlineStyle` embeds the resolved style, which is what you want when the style
  URL needs authentication — but the embedded style still contains its tile URLs,
  so read it before sharing.

## What is and is not captured

Captured:

- constructor options for `Map`, `Marker`, `Popup` and the controls
- every state-changing method call, in order, with timings
- geographic types, DOM elements (with their computed styles frozen inline),
  images, `ImageData` and typed arrays
- map events, as annotations

Not captured:

- **the path of a user gesture.** A pan or a drag is a stream of pointer events,
  not a call, so there is nothing to intercept. What the recorder does instead is
  read the camera once the map settles and write down the `jumpTo` that lands in
  the same place, with a comment saying it is a reconstruction — so the
  reproduction carries on from where the person was looking. The movement itself
  is gone; only where it ended up survives. Turn it off with `recordGestures`.
- getters. `getCenter`, `project`, `queryRenderedFeatures` and friends are
  skipped — they change nothing and would bury the interesting calls.
- the options MapLibre fills in for itself. `easing` on a camera animation and
  the `{validate: false}` that rides along on the style calls MapLibre makes
  internally are dropped, because the application never wrote them and they make
  the reproduction look like it asked for something it did not. A custom `easing`
  you passed yourself goes with them.
- `triggerRepaint`, `redraw` and `migrateProjection`. MapLibre drives itself with
  these from its render loop — hundreds per session, all of it noise.
- the camera calls MapLibre's own gesture handlers make. A drag runs
  `map.easeTo(camera, {originalEvent: <the mouse event>})` every frame; that
  second argument is the tell, and those calls are dropped in favour of the one
  reconstruction above.
- calls made from inside a synchronous MapLibre callback while another recorded
  call is still on the stack. They are stored with a nesting marker but never
  emitted. The converse also happens: a call MapLibre makes into itself from an
  **async** callback — `setTerrain` once the style resolves, for instance — looks
  like an application call and is emitted. Harmless, and visible in the script, so
  it can be deleted.
- network responses. The reproduction re-fetches tiles, so a bug that depends on a
  specific tile response will not reproduce if that response has changed.

## API

**<https://harelm.github.io/maplibregl-recorder/>** — every export, method and
option, generated from the source so it cannot drift from it.

Start at `Recorder` for the engine, `RecorderControl` for the panel and the
exporting, and `RecorderOptions` for what `attach` accepts.

## Develop

```bash
npm install
npm run build-dist  # the bundle, plus the control's stylesheet
npm run typecheck
npm run docs        # the generated API documentation
```

The demo at `test/demo.html` browses a list of places with prev/next buttons, with
terrain on by default (`?terrain=0` turns it off), and has the recorder attached
and its control on the map — a realistic thing to record. Serve the repo root and
open it after `npm run build-dist`.

## License

MIT
