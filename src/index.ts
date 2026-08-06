/**
 * maplibregl-recorder
 *
 * Records the calls an application makes into MapLibre GL JS and writes them
 * back out as a single self-contained HTML page - not a recording plus a player,
 * but the actual JavaScript that makes those calls: `new maplibregl.Map({...})`,
 * `map.flyTo({...})`. Everything the recorder captures is public API, so the
 * export can be read, edited and cut down to a minimal reproduction by hand.
 *
 * > **Experimental.** This package pokes at MapLibre's own classes, which are
 * > not a stable interface. A MapLibre release can break it at any time, and the
 * > recording format carries no compatibility promise. It is a debugging aid,
 * > not something to ship in production.
 *
 * @example Attach before any map is created
 * ```ts
 * import * as maplibre from 'maplibre-gl';
 * import { MaplibreRecorder } from 'maplibregl-recorder';
 *
 * // A module namespace is read-only, so the recorder patches a copy - and the
 * // application has to build its map from that same copy.
 * const maplibregl = {...maplibre};
 *
 * MaplibreRecorder.attach(maplibregl);
 *
 * // The panel that drives it is a control, added like any other.
 * map.addControl(new RecorderControl());
 * ```
 */
export { MaplibreRecorder, Recorder } from './recorder';
export { RecorderControl } from './recorder-control';
export { emitScript } from './emit';
export { buildReproPage } from './page';
export type { RecordedOp, RecorderOptions, Recording, SerializedValue } from './types';
