/**
 * Types used by the call recorder.
 *
 * > **Experimental.** The recording format carries no compatibility promise and
 * > may change in any release. Do not build tooling on top of it.
 */

/**
 * Options accepted by {@link Recorder.attach}.
 */
export type RecorderOptions = {
    /**
     * Record the source text of function arguments, e.g. a `transformRequest`
     * callback. Set to `false` if your callbacks contain secrets.
     * @defaultValue true
     */
    recordFunctions?: boolean;
    /**
     * Record map events (`load`, `moveend`, `error`, ...) as timeline
     * annotations. They are never executed, only written into the exported
     * script as comments.
     * @defaultValue true
     */
    recordEvents?: boolean;
    /**
     * Freeze the computed CSS of custom marker and popup elements into inline
     * styles, so they look the same in a reproduction that does not have the host
     * page stylesheet.
     * @defaultValue true
     */
    captureElementStyles?: boolean;
    /**
     * Keep the calls MapLibre makes into itself. They are stored for context but
     * never written into the exported script.
     * @defaultValue true
     */
    recordNestedCalls?: boolean;
    /**
     * Reconstruct pans, zooms and rotations the user made by hand.
     *
     * A gesture is a stream of pointer events, not a call, so there is nothing to
     * record. What the recorder can do is read the camera once the map settles and
     * write a `jumpTo` that lands in the same place - so the reproduction carries
     * on from where the person was looking, instead of from wherever the last
     * `flyTo` left it.
     *
     * It is a reconstruction, not a recording: the path is lost, only the
     * destination survives, and the exported script says so.
     * @defaultValue true
     */
    recordGestures?: boolean;
    /**
     * Stop recording once this many operations have been captured, to bound
     * memory usage.
     * @defaultValue 20000
     */
    maxOps?: number;
    /**
     * Print every entry to the console as it is recorded, one line each, with
     * the calls MapLibre made into itself indented under the call that caused
     * them. Useful for seeing what is being captured without exporting first.
     *
     * It can be turned on and off while recording, and the whole timeline can be
     * printed at any time - see {@link Recorder.logCalls} and {@link Recorder.print}.
     * @defaultValue false
     */
    logCalls?: boolean;
    /**
     * Embed the result of `map.getStyle()` in the export instead of relying on
     * the original style URL. Useful when the style is not publicly reachable.
     * @defaultValue false
     */
    inlineStyle?: boolean;
    /**
     * Longest pause, in milliseconds, that the exported script waits between two
     * calls. Longer gaps in the recording are shortened to this.
     * @defaultValue 4000
     */
    maxDelay?: number;
    /**
     * Version of MapLibre GL JS the exported page should load from unpkg.
     * Defaults to the version of the library the recorder is attached to.
     */
    maplibreVersion?: string;
};

/**
 * A value that survived JSON serialization. Values JSON cannot express are
 * represented as tagged objects carrying a `$` discriminator - see `serialize.ts`
 * for the tags, and `emit.ts` for the expression each one is written back out as.
 */
export type SerializedValue = unknown;

/** What the map had finished doing when a call was made. */
export type MapCallState = {
    /** Whether the map had loaded. */
    l: boolean;
    /** Whether the style had loaded. */
    s: boolean;
};

/** Fields shared by every entry of the timeline. */
export type TimelineEntry = {
    /** Sequence number. */
    i: number;
    /** Milliseconds since the recording started. */
    t: number;
    /**
     * Nesting depth. Anything above zero was emitted by MapLibre itself while one
     * of the application's own calls was still running, and never reaches the
     * exported script.
     */
    d?: number;
};

/** Construction of a recorded object. */
export type NewOp = TimelineEntry & {
    k: 'new';
    /** Identifier of the object, e.g. `map#1`. */
    o: string;
    /** Class name. */
    c: string;
    /** Serialized constructor arguments. */
    a: SerializedValue[];
    /** Error thrown by the constructor, if any. */
    err?: string;
};

/** A method call on a recorded object. */
export type CallOp = TimelineEntry & {
    k: 'call';
    /** Identifier of the object the call was made on. */
    o: string;
    /** Method name. */
    m: string;
    /** Serialized arguments. */
    a: SerializedValue[];
    /** Map state when the call was made. */
    s?: MapCallState;
    /** Error thrown by the call, if any. */
    err?: string;
    /**
     * Set when the recorder synthesized this call from a user gesture rather than
     * seeing the application make it. See {@link RecorderOptions.recordGestures}.
     */
    g?: boolean;
};

/** A map event, kept as an annotation. */
export type EventOp = TimelineEntry & {
    k: 'event';
    /** Identifier of the map that fired it. */
    o: string;
    /** Event name. */
    e: string;
    /** Whether it was caused by a user gesture. */
    u: boolean;
    /** Extra detail, e.g. the text of an `error` event. */
    msg?: string;
};

/** A human readable annotation added with {@link Recorder.mark}. */
export type MarkOp = TimelineEntry & {
    k: 'mark';
    /** What the person recording said was on screen. */
    label: string;
};

/** A single entry of the recorded timeline. */
export type RecordedOp = NewOp | CallOp | EventOp | MarkOp;

/** The entries that become statements, as opposed to the ones that become comments. */
export type ExecutedOp = NewOp | CallOp;

/** An entry before the recorder has stamped it with a sequence number and a time. */
export type PendingOp = RecordedOp extends infer Op
    ? Op extends RecordedOp
        ? Omit<Op, 'i' | 't'>
        : never
    : never;

/** The browser the recording was made in. */
export type RecordingEnvironment = {
    /** `navigator.userAgent`. */
    userAgent: string;
    /** `window.devicePixelRatio`, which changes how terrain and text are rendered. */
    devicePixelRatio: number;
    /** Screen size, as `[width, height]`. */
    screen: [number, number] | null;
    /** Viewport size, as `[width, height]`. */
    viewport: [number, number] | null;
};

/**
 * The complete recording, as produced by {@link Recorder.toJSON}.
 */
export type Recording = {
    /** Version of the recorder that produced this recording. */
    recorder: string;
    /** Version of MapLibre GL JS that was recorded. */
    maplibre: string;
    /** ISO timestamp of the export. */
    createdAt: string;
    /** Browser environment the recording was made in. */
    env: RecordingEnvironment;
    /** Size of the map container at recording time. */
    container: { width: number; height: number } | null;
    /** Inlined style, when `inlineStyle` was enabled. */
    style: SerializedValue;
    /** Value of {@link RecorderOptions.maxDelay}. */
    maxDelay: number;
    /** The recorded timeline. */
    ops: RecordedOp[];
};
