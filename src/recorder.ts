import { serialize, type SerializeContext } from './serialize';
import type { CallOp, MapCallState, NewOp, PendingOp, RecordedOp, RecorderOptions, Recording, SerializedValue } from './types';

const RECORDER_VERSION = '1.0.0';

/** Classes whose construction is intercepted, so their instances can be referenced later. */
const CONSTRUCTED_CLASSES = [
    'Map', 'Marker', 'Popup',
    'NavigationControl', 'GeolocateControl', 'AttributionControl', 'ScaleControl',
    'FullscreenControl', 'TerrainControl', 'LogoControl', 'GlobeControl'
];

/** Classes whose prototype methods are intercepted. */
const PATCHED_CLASSES = ['Map', 'Marker', 'Popup'];

/**
 * Methods that do not change state. Recording them would bury the interesting
 * calls under thousands of `project`/`getBounds`/`queryRenderedFeatures` entries.
 */
const SKIP_METHOD = /^(_|get|is|has|query|list|on$|off$|once$|fire$|listens|setEventedParent|project$|unproject$|loaded$|cameraFor|terrainCameraFor|convert|toString|toJSON|toArray|constructor$)/;

/**
 * Methods MapLibre drives itself with, from a render loop or an async style
 * callback. They are public, and an application may well call them, but they
 * arrive from outside any application call so the nesting counter cannot tell
 * them apart - and there are hundreds of them per session, which would bury the
 * calls the reproduction is actually about.
 */
const INTERNAL_METHOD = /^(triggerRepaint|redraw|migrateProjection)$/;

/** Map events kept in the timeline as annotations. They are never executed. */
const RECORDED_EVENTS = [
    'load', 'idle', 'error', 'styledata', 'movestart', 'moveend', 'zoomend',
    'terrain', 'styleimagemissing', 'webglcontextlost', 'webglcontextrestored'
];

const DEFAULT_OPTIONS: Required<Omit<RecorderOptions, 'maplibreVersion'>> = {
    recordFunctions: true,
    recordEvents: true,
    captureElementStyles: true,
    recordNestedCalls: true,
    recordGestures: true,
    maxOps: 20000,
    inlineStyle: false,
    maxDelay: 4000
};

const PATCHED_FLAG = '__maplibreglRecorderPatched';
const WRAPPER_FLAG = '__maplibreglRecorderWrapper';

/**
 * Marks an object as part of the recorder's own user interface. A call that is
 * handed one - `map.addControl(recorderControl)` - is left out of the recording:
 * the panel someone recorded the bug with is not part of the bug.
 */
export const RECORDER_UI_FLAG = '__maplibreglRecorderUi';

/**
 * Patching classes is global and cannot be undone, so the patches route to
 * whichever recorder attached last rather than to the one that installed them.
 * Otherwise a second recorder would silently receive nothing.
 */
let activeRecorder: Recorder | null = null;

/**
 * Records every call an application makes into MapLibre GL JS, as a timeline
 * that `emitScript` writes back out as the JavaScript that would make them.
 *
 * This is the engine and nothing else: it has no user interface and touches no
 * files. The panel that drives it is {@link RecorderControl}, a MapLibre control
 * that uses this class through its public API.
 *
 * > **Experimental.** This reaches into MapLibre's own classes, which are not a
 * > stable interface: a MapLibre release can break it at any time. It is a
 * > debugging aid for producing bug reports, not something to ship.
 *
 * Most of the time you want the shared {@link MaplibreRecorder} instance rather
 * than one of your own.
 *
 * @example
 * ```ts
 * import * as maplibre from 'maplibre-gl';
 * import { MaplibreRecorder } from 'maplibregl-recorder';
 *
 * // A module namespace is read-only, so the recorder patches a copy - and the
 * // application has to build its map from that same copy.
 * const maplibregl = {...maplibre};
 *
 * MaplibreRecorder.attach(maplibregl);  // before any map is created
 * // ... reproduce the problem in the application ...
 * MaplibreRecorder.mark('markers are oversized here');
 *
 * // Exporting is the control's job - see {@link RecorderControl} - or, without
 * // any user interface, `buildReproPage(MaplibreRecorder.toJSON())`.
 * ```
 */
export class Recorder {
    /** Version of the recorder, written into every recording. */
    readonly version: string = RECORDER_VERSION;

    private _options: Required<Omit<RecorderOptions, 'maplibreVersion'>> & {maplibreVersion?: string} = {...DEFAULT_OPTIONS};
    private _ops: RecordedOp[] = [];
    private _recording: boolean = false;
    private _startedAt: number = 0;
    private _opSeq: number = 0;
    /** Nesting depth, so calls MapLibre makes into itself can be told apart. */
    private _depth: number = 0;
    private _ids: WeakMap<object, string> = new WeakMap();
    private _idSeq: Record<string, number> = {};
    private _namespace: any = null;
    private _maps: any[] = [];
    private _overflowed: boolean = false;
    private _listeners: Array<() => void> = [];
    /**
     * The gesture entry a further `moveend` may still overwrite. Cleared as soon
     * as the application makes a call of its own, so a later gesture starts a new
     * entry rather than rewriting a finished one.
     */
    private _lastGesture: CallOp | null = null;

    /**
     * Patches a MapLibre namespace and starts recording. Call this before the
     * application creates any map.
     *
     * @param namespace - the MapLibre namespace. It has to be writable, because
     * the constructors are replaced on it: pass `{...maplibre}` rather than the
     * module namespace itself, and have the application use that same copy.
     * Defaults to `window.maplibregl`.
     * @param options - recorder options
     * @returns the recorder, for chaining
     */
    attach(namespace?: any, options?: RecorderOptions): this {
        const ns = namespace ?? (typeof window !== 'undefined' ? (window as any).maplibregl : null);
        if (!ns) throw new Error('[maplibregl-recorder] no maplibregl namespace found - pass it explicitly');

        this._options = {...this._options, ...options};
        this._namespace = ns;
        activeRecorder = this;

        for (const name of CONSTRUCTED_CLASSES) this._wrapConstructor(ns, name);
        for (const name of PATCHED_CLASSES) {
            if (ns[name]) this._patchPrototypeChain(ns[name].prototype, name);
        }

        this.start();
        this._log(`attached to MapLibre ${this._libraryVersion()} - recording`);
        return this;
    }

    /**
     * Fallback for applications that bundle MapLibre and do not expose the
     * namespace. Only `Map` calls are captured - marker and popup calls are not,
     * because their classes cannot be reached from a map instance.
     *
     * @param map - a live `Map` instance
     * @param options - recorder options
     * @returns the recorder, for chaining
     */
    attachToMap(map: any, options?: RecorderOptions): this {
        this._options = {...this._options, ...options};
        activeRecorder = this;
        this._patchPrototypeChain(Object.getPrototypeOf(map), 'Map');
        this.start();
        this._register(map, 'Map', [this._snapshotMapOptions(map)]);
        this._log('attached to an existing Map - Marker and Popup calls will NOT be recorded');
        return this;
    }

    /** Resumes recording. */
    start(): this {
        if (this._recording) return this;
        this._recording = true;
        this._startedAt ||= now();
        this._emitChange();
        return this;
    }

    /** Pauses recording. Patches stay in place, so recording can be resumed. */
    stop(): this {
        this._recording = false;
        this._emitChange();
        return this;
    }

    /** Discards everything recorded so far and restarts the clock. */
    clear(): this {
        this._ops = [];
        this._opSeq = 0;
        this._overflowed = false;
        this._lastGesture = null;
        this._startedAt = now();
        this._emitChange();
        return this;
    }

    /**
     * Notes what is on screen right now, at this point in the timeline.
     *
     * A recording is a few hundred calls with no indication of which one matters.
     * A mark becomes a comment at exactly this place in the exported script, so
     * whoever reads the reproduction knows which line to look at. It is an
     * annotation and never a call - nothing else about the recording changes.
     *
     * @param label - what is on screen right now, e.g. `'markers are oversized'`
     * @returns the recorder, for chaining
     */
    mark(label: string): this {
        this._push({k: 'mark', label: String(label)});
        this._log(`mark: ${label}`);
        return this;
    }

    /** The raw recording. */
    toJSON(): Recording {
        return {
            recorder: RECORDER_VERSION,
            maplibre: this._libraryVersion(),
            createdAt: new Date().toISOString(),
            env: {
                userAgent: typeof navigator !== 'undefined' ? navigator.userAgent : '',
                devicePixelRatio: typeof devicePixelRatio !== 'undefined' ? devicePixelRatio : 1,
                screen: typeof screen !== 'undefined' ? [screen.width, screen.height] : null,
                viewport: typeof innerWidth !== 'undefined' ? [innerWidth, innerHeight] : null
            },
            container: this._containerSize(),
            style: this._options.inlineStyle ? this._inlineStyle() : null,
            maxDelay: this._options.maxDelay,
            // A copy: recording carries on after this call, and a recording that
            // grew while its reader was walking it would be a trap.
            ops: [...this._ops]
        };
    }

    /**
     * Subscribes to state changes - a call recorded, recording paused, the
     * timeline cleared. This is how a front end such as {@link RecorderControl}
     * follows the recorder without the recorder knowing anything about it.
     *
     * @param listener - called after every change
     * @returns a function that removes the listener
     */
    onChange(listener: () => void): () => void {
        this._listeners.push(listener);
        return () => {
            this._listeners = this._listeners.filter(existing => existing !== listener);
        };
    }

    /** The operations recorded so far. */
    get ops(): RecordedOp[] {
        return this._ops;
    }

    /** Whether the recorder is currently capturing calls. */
    get isRecording(): boolean {
        return this._recording;
    }

    // -----------------------------------------------------------------
    // Interception
    // -----------------------------------------------------------------

    private _wrapConstructor(namespace: any, name: string) {
        const Original = namespace[name];
        if (typeof Original !== 'function' || Original[PATCHED_FLAG]) return;

        // A class must only ever be wrapped once: attaching again with a fresh
        // namespace object has to reuse the existing wrapper, or the wrappers
        // would nest and record every construction twice.
        const existing = Original[WRAPPER_FLAG];
        if (existing) {
            namespace[name] = existing;
            return;
        }

        function Wrapped(this: any, ...args: any[]) {
            const recorder = activeRecorder;
            const target = new.target ?? Wrapped;
            // The map container is a live DOM node; the reproduction supplies its
            // own, so serializing this one would only bloat the export.
            const forSerialization = name === 'Map' ? [omit(args[0], 'container'), ...args.slice(1)] : args;
            const serialized = recorder?._recording ?
                forSerialization.map(arg => recorder._serialize(arg)) :
                null;
            // Whatever the constructor builds for itself - the `Map` constructor
            // adds the attribution and logo controls, for instance - is MapLibre's
            // own doing, and emitting it would duplicate it.
            if (recorder) recorder._depth++;
            let instance: any;
            try {
                instance = Reflect.construct(Original, args, target === Wrapped ? Original : target);
            } finally {
                if (recorder) recorder._depth--;
            }
            try {
                recorder?._register(instance, name, serialized, args);
            } catch (error) {
                recorder?._warn(String(error));
            }
            return instance;
        }

        (Wrapped as any)[PATCHED_FLAG] = true;
        Wrapped.prototype = Original.prototype;
        Object.setPrototypeOf(Wrapped, Original);
        Object.defineProperty(Wrapped, 'name', {value: name, configurable: true});
        Object.defineProperty(Original, WRAPPER_FLAG, {value: Wrapped, enumerable: false});

        try {
            namespace[name] = Wrapped;
        } catch (error) {
            this._warn(`could not wrap the ${name} constructor: ${(error as Error).message}`);
        }
    }

    /**
     * Patches every level of the prototype chain, because a method is not
     * necessarily an own member of the class it looks like it belongs to - the
     * camera methods (`flyTo`, `jumpTo`, `fitBounds`, ...) have moved between
     * `Camera.prototype` and `Map.prototype` across releases.
     */
    private _patchPrototypeChain(prototype: any, kind: string) {
        let current = prototype;
        while (current && current !== Object.prototype) {
            this._patchPrototype(current, kind);
            current = Object.getPrototypeOf(current);
        }
    }

    private _patchPrototype(prototype: any, kind: string) {
        if (!prototype || Object.hasOwn(prototype, PATCHED_FLAG)) return;
        Object.defineProperty(prototype, PATCHED_FLAG, {value: true, enumerable: false});

        for (const key of Object.getOwnPropertyNames(prototype)) {
            const descriptor = Object.getOwnPropertyDescriptor(prototype, key);
            if (!descriptor?.writable || typeof descriptor.value !== 'function') continue;
            if (SKIP_METHOD.test(key) || INTERNAL_METHOD.test(key)) continue;

            const original = descriptor.value;
            prototype[key] = function (this: any, ...args: any[]) {
                const recorder = activeRecorder;
                if (!recorder) return original.apply(this, args);

                let op: CallOp | null = null;
                const skip = args.some(arg => arg && typeof arg === 'object' &&
                    ((arg as any)[RECORDER_UI_FLAG] || isHandlerEventData(arg)));
                if (!skip && recorder._recording && (recorder._depth === 0 || recorder._options.recordNestedCalls)) {
                    const actualKind = recorder._detectKind(this) ?? kind;
                    op = recorder._push({
                        k: 'call',
                        o: recorder._idOf(this, actualKind),
                        m: key,
                        a: args.map(arg => recorder._serialize(arg)),
                        d: recorder._depth,
                        s: actualKind === 'Map' ? recorder._mapState(this) : undefined
                    }) as CallOp;
                }
                recorder._depth++;
                try {
                    return original.apply(this, args);
                } catch (error) {
                    if (op) op.err = String((error as Error)?.message ?? error);
                    throw error;
                } finally {
                    recorder._depth--;
                }
            };
        }
    }

    /** Which of the recorded classes an instance belongs to, if any. */
    private _detectKind(instance: any): string | null {
        for (const name of PATCHED_CLASSES) {
            if (this._namespace?.[name] && instance instanceof this._namespace[name]) return name;
        }
        const ctorName = instance?.constructor?.name;
        return PATCHED_CLASSES.includes(ctorName) ? ctorName : null;
    }

    private _serialize(value: unknown): SerializedValue {
        const context: SerializeContext = {
            idFor: object => this._ids.get(object),
            options: this._options
        };
        return serialize(value, context);
    }

    /** Assigns an id to an instance, recording its construction the first time it is seen. */
    private _register(instance: any, kind: string, serializedArgs: SerializedValue[] | null, rawArgs?: any[]): string | null {
        if (!instance || typeof instance !== 'object') return null;
        const existing = this._ids.get(instance);
        if (existing) return existing;

        this._idSeq[kind] = (this._idSeq[kind] ?? 0) + 1;
        const id = `${kind.toLowerCase()}#${this._idSeq[kind]}`;
        this._ids.set(instance, id);

        let args = serializedArgs ?? [];
        if (kind === 'Map') {
            this._maps.push(instance);
            args = [this._mapOptions(args[0], rawArgs?.[0])];
            if (this._options.recordEvents) this._listenToEvents(instance);
        }

        this._push({k: 'new', o: id, c: kind, a: args, d: this._depth} satisfies Omit<NewOp, 'i' | 't'>);
        return id;
    }

    private _idOf(instance: any, kind: string): string {
        const existing = this._ids.get(instance);
        if (existing) return existing;
        // An object first seen inside a nested call is one whose constructor is
        // still running. Giving it an id here would claim the one its `new` entry
        // needs, and nested calls are not emitted anyway.
        if (this._depth > 0) return `${kind.toLowerCase()}#pending`;
        return this._register(instance, kind, kind === 'Map' ? [this._snapshotMapOptions(instance)] : []) ?? `${kind.toLowerCase()}#unknown`;
    }

    private _listenToEvents(map: any) {
        for (const type of RECORDED_EVENTS) {
            try {
                map.on(type, (event: any) => {
                    if (!this._recording) return;
                    const gesture = !!event?.originalEvent;
                    this._push({
                        k: 'event',
                        o: this._ids.get(map)!,
                        e: type,
                        u: gesture,
                        msg: type === 'error' ? String(event?.error?.message ?? '') : undefined,
                        d: 0
                    });
                    if (type === 'moveend' && gesture) this._recordGesture(map);
                });
            } catch {
                // Event type not supported by this version of MapLibre.
            }
        }
    }

    /**
     * Reconstructs a pan, zoom or rotation the user made by hand.
     *
     * There is no call to intercept - a gesture is a stream of pointer events -
     * so the camera is read once the map settles and written down as the `jumpTo`
     * that would land in the same place.
     *
     * Two things say this really was a gesture rather than an animation the
     * application asked for. MapLibre only attaches `originalEvent` to the moves
     * its own handlers drive, which the caller has already checked; and a camera
     * method still in flight leaves the map easing, which would mean this
     * `moveend` belongs to something like a `flyTo` that is already in the
     * recording as itself.
     */
    private _recordGesture(map: any) {
        if (!this._options.recordGestures) return;
        try {
            if (map.isEasing?.()) return;
        } catch {
            // Not exposed by this version; the originalEvent check stands alone.
        }

        const camera = this._camera(map);
        if (!camera) return;

        // A single drag or wheel-zoom settles more than once. Only where it came
        // to rest is worth keeping, so a burst overwrites rather than piles up.
        if (this._lastGesture && this._lastGesture.o === this._ids.get(map)) {
            this._lastGesture.a = [camera];
            this._lastGesture.t = Math.round(now() - this._startedAt);
            return;
        }

        this._lastGesture = this._push({
            k: 'call',
            o: this._ids.get(map)!,
            m: 'jumpTo',
            a: [camera],
            s: this._mapState(map),
            g: true,
            d: 0
        }) as CallOp;
    }

    /** Where the camera is now, rounded to what anyone would type by hand. */
    private _camera(map: any): SerializedValue | null {
        try {
            const center = map.getCenter();
            const camera: Record<string, SerializedValue> = {
                center: [round(center.lng, 6), round(center.lat, 6)],
                zoom: round(map.getZoom(), 4),
                bearing: round(map.getBearing(), 2),
                pitch: round(map.getPitch(), 2)
            };
            const roll = typeof map.getRoll === 'function' ? map.getRoll() : 0;
            if (roll) camera['roll'] = round(roll, 2);
            return camera;
        } catch {
            return null;
        }
    }

    private _mapState(map: any): MapCallState | undefined {
        try {
            return {l: !!map.loaded?.(), s: !!map.isStyleLoaded?.()};
        } catch {
            return undefined;
        }
    }

    private _push(pending: PendingOp): RecordedOp {
        const op = pending as RecordedOp;
        if (!this._recording) return op;
        if (this._ops.length >= this._options.maxOps) {
            if (!this._overflowed) {
                this._overflowed = true;
                this._recording = false;
                this._warn(`maxOps (${this._options.maxOps}) reached - recording stopped`);
                this._emitChange();
            }
            return op;
        }
        op.i = this._opSeq++;
        op.t = Math.round(now() - this._startedAt);
        if (!op.d) delete op.d;
        // A call of the application's own closes off the gesture before it: what
        // comes next is a new movement, not more of the same one.
        if ((op.k === 'new' || op.k === 'call') && !op.d && !(op as CallOp).g) this._lastGesture = null;
        this._ops.push(op);
        this._emitChange();
        return op;
    }

    // -----------------------------------------------------------------
    // Map options
    // -----------------------------------------------------------------

    /** Replaces the live container with a placeholder, remembering its size. */
    private _mapOptions(serialized: SerializedValue, raw: any): SerializedValue {
        const options: Record<string, SerializedValue> =
            serialized && typeof serialized === 'object' && !(serialized as any).$ ?
                {...serialized as Record<string, SerializedValue>} :
                {};
        options['container'] = 'map';

        const element = typeof raw?.container === 'string' ? document.getElementById(raw.container) : raw?.container;
        const rect = element?.getBoundingClientRect?.();
        if (rect) options['__containerSize'] = [Math.round(rect.width), Math.round(rect.height)];
        return options;
    }

    /**
     * Best-effort reconstruction of the constructor options of a map that was
     * created before the recorder was attached.
     */
    private _snapshotMapOptions(map: any): SerializedValue {
        const options: Record<string, SerializedValue> = {container: 'map'};
        const getters: Record<string, string> = {
            center: 'getCenter', zoom: 'getZoom', bearing: 'getBearing', pitch: 'getPitch',
            roll: 'getRoll', minZoom: 'getMinZoom', maxZoom: 'getMaxZoom',
            minPitch: 'getMinPitch', maxPitch: 'getMaxPitch', maxBounds: 'getMaxBounds',
            renderWorldCopies: 'getRenderWorldCopies', pixelRatio: 'getPixelRatio',
            style: 'getStyle'
        };
        for (const key of Object.keys(getters)) {
            try {
                if (typeof map[getters[key]] === 'function') options[key] = this._serialize(map[getters[key]]());
            } catch {
                // Not available in this version.
            }
        }
        try {
            const rect = map.getContainer().getBoundingClientRect();
            options['__containerSize'] = [Math.round(rect.width), Math.round(rect.height)];
        } catch {
            // No container yet.
        }
        return options;
    }

    private _containerSize(): {width: number; height: number} | null {
        for (const map of this._maps) {
            try {
                const rect = map.getContainer().getBoundingClientRect();
                return {width: Math.round(rect.width), height: Math.round(rect.height)};
            } catch {
                // Map already removed.
            }
        }
        return null;
    }

    private _inlineStyle(): SerializedValue {
        try {
            return this._maps[0] ? this._serialize(this._maps[0].getStyle()) : null;
        } catch {
            return null;
        }
    }

    private _libraryVersion(): string {
        try {
            if (this._options.maplibreVersion) return this._options.maplibreVersion;
            if (typeof this._namespace?.getVersion === 'function') return this._namespace.getVersion();
            if (this._namespace?.version) return this._namespace.version;
        } catch {
            // Not exposed by this version.
        }
        return 'latest';
    }

    // -----------------------------------------------------------------
    // Helpers
    // -----------------------------------------------------------------

    private _emitChange() {
        for (const listener of this._listeners) {
            try {
                listener();
            } catch (error) {
                this._warn(`change listener failed: ${String(error)}`);
            }
        }
    }

    private _log(message: string) {
        console.log(`[maplibregl-recorder] ${message}`);
    }

    private _warn(message: string) {
        console.warn(`[maplibregl-recorder] ${message}`);
    }
}

function now(): number {
    return typeof performance !== 'undefined' ? performance.now() : Date.now();
}

/**
 * Whether an argument is the event data MapLibre's own gesture handlers pass
 * along - `map.easeTo(camera, {originalEvent: <the mouse event>})`.
 *
 * A drag makes one of these per frame, from a handler rather than from the
 * application, and the nesting counter cannot tell them apart because the
 * handler runs on its own. They are the machinery of the gesture, not something
 * anyone wrote; what the gesture came to is recorded instead, once, by
 * `_recordGesture`.
 */
function isHandlerEventData(value: any): boolean {
    return !!value.originalEvent && typeof value.originalEvent === 'object';
}

/** Camera values carry far more precision than anyone would write by hand. */
function round(value: number, places: number): number {
    const factor = 10 ** places;
    return Math.round(value * factor) / factor;
}

function omit(value: any, key: string): any {
    if (!value || typeof value !== 'object') return value;
    const rest = {...value};
    delete rest[key];
    return rest;
}

/**
 * The shared recorder instance - the one {@link RecorderControl} drives unless
 * it is handed another, and the one to import unless you need your own. See
 * {@link Recorder}.
 */
export const MaplibreRecorder: Recorder = new Recorder();
