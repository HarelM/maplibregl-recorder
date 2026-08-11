/**
 * End to end tests: a real MapLibre map in a real browser, driven the way an
 * application drives it, then the recording - and the script it exports - held
 * up against what was actually called.
 *
 * The style is inline and empty, so nothing here goes near the network.
 */

import { afterEach, expect, test, vi } from 'vitest';
import * as maplibre from 'maplibre-gl';
import { Recorder } from './recorder';
import { RecorderControl } from './recorder-control';
import { emitScript } from './emit';
import type { CallOp, RecorderOptions, RecordedOp } from './types';

const STYLE = {version: 8, sources: {}, layers: []};

/** Everything a test built, torn down afterwards. */
const built: {maps: any[]; elements: HTMLElement[]} = {maps: [], elements: []};

afterEach(() => {
    for (const map of built.maps.splice(0)) map.remove();
    for (const element of built.elements.splice(0)) element.remove();
    vi.restoreAllMocks();
});

/**
 * A recorder on its own copy of the namespace, the way the README says to attach
 * one. `maxDelay` is dropped to a millisecond so the exported script carries no
 * waits and the round trip below runs at full speed.
 */
function attach(options?: RecorderOptions) {
    const maplibregl: any = {...maplibre};
    const recorder = new Recorder().attach(maplibregl, {maxDelay: 1, ...options});
    return {recorder, maplibregl};
}

function element(id?: string): HTMLElement {
    const container = document.createElement('div');
    if (id) container.id = id;
    container.style.width = '400px';
    container.style.height = '300px';
    document.body.appendChild(container);
    built.elements.push(container);
    return container;
}

async function createMap(maplibregl: any, options?: Record<string, unknown>): Promise<any> {
    const map = new maplibregl.Map({container: element(), style: STYLE, center: [0, 0], zoom: 2, ...options});
    built.maps.push(map);
    await map.once('load');
    return map;
}

/**
 * Where the recording has got to, so a test can look at what it does next
 * without clearing - clearing would take the `new Map` entry with it, and the
 * calls that follow would have nothing to hang off in the exported script.
 */
function checkpoint(recorder: Recorder): () => RecordedOp[] {
    const from = recorder.ops.length;
    return () => recorder.ops.slice(from);
}

/** The calls the application itself made - what the exported script is made of. */
function applicationCalls(ops: RecordedOp[]): string[] {
    return ops.filter((op): op is CallOp => op.k === 'call' && !op.d).map(op => op.m);
}

/** The calls MapLibre made into itself while one of those was still running. */
function nestedCalls(ops: RecordedOp[]): string[] {
    return ops.filter((op): op is CallOp => op.k === 'call' && !!op.d).map(op => op.m);
}

test('records the map and the calls made on it', async () => {
    const {recorder, maplibregl} = attach();
    const map = await createMap(maplibregl);
    const since = checkpoint(recorder);

    map.setZoom(5);
    map.setBearing(30);

    const created = recorder.ops.filter(op => op.k === 'new' && !op.d);
    expect(created.map((op: any) => op.c)).toEqual(['Map']);
    expect(applicationCalls(since())).toEqual(['setZoom', 'setBearing']);
    expect(emitScript(recorder.toJSON())).toContain('const map = new maplibregl.Map({');
});

test('records a method that MapLibre implements through another one only once', async () => {
    const {recorder, maplibregl} = attach();
    const map = await createMap(maplibregl);
    const since = checkpoint(recorder);

    // Every one of these is a thin wrapper: MapLibre implements panTo, zoomTo
    // and fitBounds through easeTo, and setCenter and setZoom through jumpTo.
    map.panTo([10, 10], {duration: 0});
    map.zoomTo(4, {duration: 0});
    map.setCenter([1, 2]);
    map.fitBounds([[0, 0], [1, 1]], {duration: 0});
    map.setZoom(5);

    // One entry each, under the name the application used. What MapLibre reaches
    // them through is its own business and is not a second call.
    expect(applicationCalls(since())).toEqual(['panTo', 'zoomTo', 'setCenter', 'fitBounds', 'setZoom']);
    expect(nestedCalls(since())).not.toContain('easeTo');
    expect(nestedCalls(since())).not.toContain('jumpTo');

    // And the script moves the camera the way the application moved it: five
    // calls, under their own names, with nothing MapLibre reached them through.
    const script = emitScript(recorder.toJSON());
    expect(script.match(/^map\.(panTo|zoomTo|setCenter|fitBounds|setZoom|easeTo|jumpTo)\(/gm)).toEqual(
        ['map.panTo(', 'map.zoomTo(', 'map.setCenter(', 'map.fitBounds(', 'map.setZoom(']);
});

test('an animated camera call is still one call once it has finished animating', async () => {
    const {recorder, maplibregl} = attach();
    const map = await createMap(maplibregl);
    new maplibregl.Marker().setLngLat([1, 1]).addTo(map);
    const since = checkpoint(recorder);

    map.panTo([10, 10], {duration: 200});
    await map.once('moveend');
    // The frames after it settles are where anything MapLibre drives itself with
    // would turn up, out of any call and so indistinguishable from the
    // application's own.
    await new Promise(resolve => setTimeout(resolve, 200));

    expect(applicationCalls(since())).toEqual(['panTo']);
});

test('keeps the calls MapLibre makes into itself out of the exported script', async () => {
    const {recorder, maplibregl} = attach();
    const map = await createMap(maplibregl);
    const since = checkpoint(recorder);

    // `addTo` calls `remove` and `setDraggable` on the way through, and `setText`
    // goes through `setDOMContent`.
    const marker = new maplibregl.Marker().setLngLat([1, 1]).addTo(map);
    marker.setPopup(new maplibregl.Popup().setText('hello'));

    expect(nestedCalls(since()).length).toBeGreaterThan(0);

    const script = emitScript(recorder.toJSON());
    expect(script).toContain('marker.addTo(map);');
    expect(script).toContain('marker.setPopup(popup);');
    expect(script).not.toContain('marker.remove();');
    expect(script).not.toContain('setDOMContent');
});

/**
 * The converse of the case above, and the limitation the README calls out: a
 * call MapLibre makes into itself from an *async* callback arrives with nothing
 * of the application's on the stack, so the nesting counter cannot tell it apart
 * and it is recorded as though the application had made it. `Style._load` ends
 * with `map.setTerrain(this.stylesheet.terrain ?? null)`, so every recording of a
 * map has one of these. It is visible in the script and can be deleted; this test
 * is here so that if it ever stops happening, that is noticed rather than assumed.
 */
test('cannot tell a call MapLibre makes from an async callback apart from the application\'s', async () => {
    const {recorder, maplibregl} = attach();
    await createMap(maplibregl);

    expect(applicationCalls(recorder.ops)).toEqual(['setTerrain']);
    expect(emitScript(recorder.toJSON())).toContain('map.setTerrain(null);');
});

test('leaves getters and repaints alone', async () => {
    const {recorder, maplibregl} = attach();
    const map = await createMap(maplibregl);
    const since = checkpoint(recorder);

    map.getCenter();
    map.getZoom();
    map.getBounds();
    map.project([0, 0]);
    map.queryRenderedFeatures();
    map.triggerRepaint();

    expect(since()).toEqual([]);
});

test('keeps events and notes as annotations, never as calls', async () => {
    const {recorder, maplibregl} = attach();
    const map = await createMap(maplibregl);
    map.setZoom(4);
    recorder.mark('the bug is on screen here');

    expect(recorder.ops.filter(op => op.k === 'event').map((op: any) => op.e)).toContain('load');

    const script = emitScript(recorder.toJSON());
    expect(script).toContain("fired 'load'");
    expect(script).toContain('// === the bug is on screen here ===');
});

test('exports a script that puts a fresh map where the recorded one ended up', async () => {
    const {recorder, maplibregl} = attach();
    const map = await createMap(maplibregl);
    map.jumpTo({center: [11.382, 47.313], zoom: 9, bearing: 25, pitch: 40});
    recorder.stop();

    // The exported script builds its map in an element called `map`, the way the
    // exported page does.
    element('map');
    const script = emitScript(recorder.toJSON());
    const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor;
    await new AsyncFunction('maplibregl', script)(maplibregl);

    const replayed = (window as any).map;
    built.maps.push(replayed);
    expect(replayed).not.toBe(map);
    expect(replayed.getCenter().lng).toBeCloseTo(map.getCenter().lng, 4);
    expect(replayed.getCenter().lat).toBeCloseTo(map.getCenter().lat, 4);
    expect(replayed.getZoom()).toBeCloseTo(map.getZoom(), 4);
    expect(replayed.getBearing()).toBeCloseTo(map.getBearing(), 4);
    expect(replayed.getPitch()).toBeCloseTo(map.getPitch(), 4);
});

test('records nothing while paused, and nothing at all once cleared', async () => {
    const {recorder, maplibregl} = attach();
    const map = await createMap(maplibregl);
    const since = checkpoint(recorder);

    recorder.stop();
    map.setZoom(6);
    expect(since()).toEqual([]);

    recorder.start();
    map.setZoom(7);
    expect(applicationCalls(since())).toEqual(['setZoom']);

    recorder.clear();
    expect(recorder.ops).toEqual([]);
});

test('leaves its own control out of the recording', async () => {
    const {recorder, maplibregl} = attach();
    const map = await createMap(maplibregl);
    const since = checkpoint(recorder);

    map.addControl(new RecorderControl(recorder));
    map.addControl(new maplibregl.NavigationControl());

    // The panel someone recorded the bug with is not part of the bug.
    const script = emitScript(recorder.toJSON());
    expect(script).toContain('map.addControl(navigationControl);');
    expect(script).not.toContain('RecorderControl');
    expect(applicationCalls(since())).toEqual(['addControl']);
});

test('prints each entry as it is recorded when logCalls is on', async () => {
    const {recorder, maplibregl} = attach({logCalls: true});
    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    const map = await createMap(maplibregl);
    map.panTo([10, 10], {duration: 0});

    const lines = log.mock.calls.map(call => String(call[0]));
    expect(lines.some(line => line.includes('map#1 = new Map('))).toBe(true);
    expect(lines.some(line => line.includes('map#1.panTo([10,10]'))).toBe(true);

    recorder.logCalls = false;
    log.mockClear();
    map.setZoom(6);
    expect(log).not.toHaveBeenCalled();
});

test('prints the whole timeline on demand, nesting what MapLibre called itself', async () => {
    const {recorder, maplibregl} = attach();
    const map = await createMap(maplibregl);
    recorder.clear();
    new maplibregl.Marker().setLngLat([1, 1]).addTo(map);
    recorder.mark('a note');

    const log = vi.spyOn(console, 'log').mockImplementation(() => {});
    expect(recorder.print()).toBe(recorder);

    const lines = log.mock.calls.map(call => String(call[0]));
    expect(lines[0]).toContain(`${recorder.ops.length} entries`);
    expect(lines.some(line => /marker#1\.addTo\(/.test(line) && !line.includes('↳'))).toBe(true);
    expect(lines.some(line => line.includes('↳'))).toBe(true);
    expect(lines.some(line => line.includes('=== a note ==='))).toBe(true);
});
