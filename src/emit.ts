import type { CallOp, EventOp, ExecutedOp, NewOp, RecordedOp, Recording, SerializedValue } from './types';

/**
 * Turns a recording into readable JavaScript.
 *
 * Everything the recorder captures is a public MapLibre call - a `new` on one of
 * its classes, or a method on one of their prototypes - so a recording can be
 * written back out as the source that would make those calls. The aim is source
 * that looks like the application's own: no runtime of any kind, no helpers to
 * learn, nothing between the reader and the calls.
 */

/** Longest expression, in characters, that is still emitted on a single line. */
const MAX_INLINE = 100;

const INDENT = '    ';

/** Deltas below this are noise next to the browser's own scheduling. */
const MIN_WAIT = 50;

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

/**
 * Methods that mutate the style, which MapLibre refuses to do until the style
 * has resolved - `setTerrain` before then throws "Style is not done loading".
 */
const STYLE_METHOD = /^(add|remove|set|move)(Source|Layer|Image|Sprite|Terrain|Sky|Light|Projection|Glyphs|PaintProperty|LayoutProperty|Filter|LayerZoomRange|FeatureState)/;

/**
 * Option keys MapLibre fills in for itself. The application never wrote them, so
 * putting them in the reproduction only obscures what it actually did:
 *
 * - `easing` is the interpolation a camera animation ended up with, supplied by
 *   whichever handler drove it rather than by the caller.
 * - `validate` rides along on the style calls MapLibre makes internally.
 */
const INTERNAL_OPTION = new Set(['easing', 'validate']);

/** Characters a single-quoted literal cannot carry verbatim. */
const UNSAFE = /[\\\u0000-\u001f\u2028\u2029]/;

type EmitContext = {
    /** Variable name for each recorded object id, e.g. `marker#2` to `marker2`. */
    names: Record<string, string>;
    /**
     * Statements a value needed before the call using it - building a marker
     * element, say. Flushed in front of that call and then cleared.
     */
    prelude: string[];
    /** How many of each hoisted local have been emitted, for naming. */
    locals: Record<string, number>;
    /** How many there will be in total, so the only one of its kind goes unnumbered. */
    totals: Record<string, number>;
};

/**
 * Emits the reproduction script: every recorded call, in the order the
 * application made them.
 *
 * @param recording - the recording to write out
 * @returns JavaScript source, to be run as a module
 */
export function emitScript(recording: Recording): string {
    const ctx: EmitContext = {
        names: nameObjects(recording.ops),
        prelude: [],
        locals: {},
        totals: countLocals(recording.ops)
    };
    return emitStatements(recording, ctx).join('\n');
}

/**
 * Assigns each recorded object a variable name. The index is left off when a
 * class was only constructed once, so the common case reads `map` and `marker`
 * rather than `map1` and `marker1`.
 */
function nameObjects(ops: RecordedOp[]): Record<string, string> {
    const created = ops.filter((op): op is NewOp => op.k === 'new' && !op.d);
    const totals: Record<string, number> = {};
    for (const op of created) totals[op.c] = (totals[op.c] ?? 0) + 1;

    const seen: Record<string, number> = {};
    const names: Record<string, string> = {};
    for (const op of created) {
        seen[op.c] = (seen[op.c] ?? 0) + 1;
        const base = op.c.charAt(0).toLowerCase() + op.c.slice(1);
        names[op.o] = totals[op.c]! > 1 ? `${base}${seen[op.c]}` : base;
    }
    return names;
}

/** Counts the values that will need a local of their own, for the same reason. */
function countLocals(ops: RecordedOp[]): Record<string, number> {
    const totals: Record<string, number> = {};
    const scan = (value: any) => {
        if (!value || typeof value !== 'object') return;
        if (Array.isArray(value)) return value.forEach(scan);
        if (value.$ === 'el') totals['element'] = (totals['element'] ?? 0) + 1;
        if (value.$ === 'img') totals['image'] = (totals['image'] ?? 0) + 1;
        for (const key of Object.keys(value)) scan(value[key]);
    };
    for (const op of ops) {
        if (op.d || (op.k !== 'new' && op.k !== 'call')) continue;
        scan(op.a);
    }
    return totals;
}

function emitStatements(recording: Recording, ctx: EmitContext): string[] {
    const lines: string[] = [];
    const awaited = new Set<string>();
    const maxWait = recording.maxDelay || 4000;
    let previous: number | null = null;
    let mapName: string | null = null;

    for (const [index, op] of recording.ops.entries()) {
        // Calls MapLibre made into itself while one of the application's own calls
        // was running. They are context, not steps, and emitting them would
        // duplicate what the library already does for itself.
        if (op.d) continue;

        if (op.k === 'mark') {
            lines.push('', `// === ${op.label} ===`);
            continue;
        }
        if (op.k === 'event') {
            lines.push(...emitEvent(op, isReconstructed(recording.ops, index), ctx));
            continue;
        }

        if (op.k === 'call' && op.g) {
            lines.push(
                '',
                '// The user panned, zoomed or rotated the map by hand at this point. The',
                '// gesture itself was not recorded - this is where it came to rest.'
            );
        }

        for (const gate of gatesFor(op, ctx)) {
            if (awaited.has(`${op.o}/${gate.key}`)) continue;
            awaited.add(`${op.o}/${gate.key}`);
            lines.push('', `// ${gate.why}`, gate.statement);
            previous = op.t;
        }

        if (previous !== null) {
            const delay = Math.min(op.t - previous, maxWait);
            if (delay >= MIN_WAIT) {
                lines.push('', `await new Promise(resolve => setTimeout(resolve, ${Math.round(delay)}));`);
            }
        }
        previous = op.t;

        const statement = op.k === 'new' ? emitNew(op, recording, ctx) : emitCall(op, ctx);
        // Anything the arguments had to build first goes in front of the call.
        if (ctx.prelude.length) {
            lines.push(...ctx.prelude);
            ctx.prelude = [];
        }
        lines.push(op.err ? `${statement}  // threw: ${op.err}` : statement);

        if (op.k === 'new' && op.c === 'Map' && !mapName) mapName = ctx.names[op.o] ?? null;
    }

    if (mapName) {
        lines.push('', '// Module scope is not the global scope, so hand the map to the console.', `window.map = ${mapName};`);
    }
    return lines;
}

/**
 * Whether the gesture that ended here was written down as a camera call. The
 * recorder appends it while handling the very `moveend` in question, so it is
 * the next entry that will be emitted, if it is there at all.
 */
function isReconstructed(ops: RecordedOp[], index: number): boolean {
    const next = ops.slice(index + 1).find(op => !op.d && (op.k === 'new' || op.k === 'call'));
    return !!next && next.k === 'call' && !!next.g;
}

/**
 * Events become comments, in place. The ones a gesture fired are left out: the
 * movement they describe is either written down as the `jumpTo` that follows,
 * which says so itself, or noted where that reconstruction is missing.
 */
function emitEvent(op: EventOp, reconstructed: boolean, ctx: EmitContext): string[] {
    if (op.u && (op.e === 'movestart' || op.e === 'zoomend')) return [];
    if (op.u && op.e === 'moveend') {
        return reconstructed ? [] : [
            '',
            '// The user panned, zoomed or rotated the map by hand at this point,',
            '// and the movement was not reconstructed, so nothing below repeats it.'
        ];
    }
    const target = ctx.names[op.o] ?? op.o;
    return [`// ${op.t}ms  ${target} fired '${op.e}'${op.msg ? `: ${op.msg}` : ''}`];
}

/**
 * The waits a call has to sit behind, at most one of each per map.
 *
 * A call the application made after the map had loaded must not run before it
 * loads here, or it would be applied to a half-initialised map. Style mutations
 * need less than that but need it earlier: MapLibre throws outright if the style
 * is not resolved yet, and some of these calls are ones MapLibre itself makes
 * from a style callback, where the nesting counter cannot tell them apart from
 * the application's own.
 *
 * Both are ordinary `await` lines, so anyone reproducing a bug about calling too
 * early can simply delete them.
 */
function gatesFor(op: ExecutedOp, ctx: EmitContext): Array<{key: string; why: string; statement: string}> {
    if (op.k !== 'call') return [];
    const name = ctx.names[op.o];
    if (!name) return [];

    // Each waits only if it has to: by the time the script gets here the map may
    // well have finished already, and `once` on an event that has been and gone
    // would never fire.
    const gates = [];
    if (STYLE_METHOD.test(op.m)) {
        gates.push({
            key: 'style',
            why: 'MapLibre refuses to touch the style until it has resolved.',
            statement: `if (!${name}.isStyleLoaded()) await new Promise(resolve => ${name}.once('style.load', resolve));`
        });
    }
    if (op.s?.l) {
        gates.push({
            key: 'load',
            why: 'The application made the calls below after the map had loaded.',
            statement: `if (!${name}.loaded()) await new Promise(resolve => ${name}.once('load', resolve));`
        });
    }
    return gates;
}

function emitNew(op: NewOp, recording: Recording, ctx: EmitContext): string {
    const name = ctx.names[op.o];
    let args = op.a;

    // `inlineStyle` captured the resolved style so the reproduction does not
    // depend on a style URL that may be private or may have changed since.
    if (op.c === 'Map' && recording.style) {
        const options = args[0] && typeof args[0] === 'object' ? args[0] as Record<string, SerializedValue> : {};
        args = [{...options, style: recording.style}, ...args.slice(1)];
    }

    const call = `new maplibregl.${op.c}${emitArguments(args, ctx)}`;
    return name ? `const ${name} = ${call};` : `${call};`;
}

function emitCall(op: CallOp, ctx: EmitContext): string {
    const target = ctx.names[op.o];
    const call = `${target ?? op.o}.${op.m}${emitArguments(op.a, ctx)};`;
    // An object the recorder never saw constructed cannot be addressed by name.
    return target ? call : `// ${call}  <- ${op.o} was never constructed`;
}

/**
 * Arguments hug the parentheses the way they would be written by hand -
 * `new maplibregl.Map({` on one line, the closing `});` on its own - as long as
 * only the last of them spreads over several lines.
 */
function emitArguments(args: SerializedValue[], ctx: EmitContext): string {
    const supplied = withoutInternalArguments(args);
    const hugged = supplied.map(arg => emitValue(arg, ctx, ''));
    if (hugged.slice(0, -1).every(part => !part.includes('\n'))) {
        const inline = hugged.join(', ');
        if (inline.length <= MAX_INLINE || hugged.at(-1)!.includes('\n')) return `(${inline})`;
    }
    // Re-emitted at depth, and any locals the first attempt hoisted go with it.
    ctx.prelude = [];
    return joinParts(supplied.map(arg => emitValue(arg, ctx, INDENT)), '(', ')', '');
}

/**
 * Drops a trailing options object that holds nothing but MapLibre's own
 * bookkeeping - `map.setTerrain(terrain, {validate: false})` is a call the
 * library makes, and the second argument is not something anyone wrote.
 */
function withoutInternalArguments(args: SerializedValue[]): SerializedValue[] {
    const last = args.at(-1);
    if (args.length < 2 || !last || typeof last !== 'object' || Array.isArray(last) || (last as any).$) return args;

    const keys = Object.keys(last as object);
    return keys.length && keys.every(key => INTERNAL_OPTION.has(key)) ? args.slice(0, -1) : args;
}

/**
 * Writes a serialized value back out as the expression that produces it - the
 * inverse of `serialize`, and the reason the exported page needs no interpreter.
 */
function emitValue(value: SerializedValue, ctx: EmitContext, indent: string): string {
    if (value === null) return 'null';

    switch (typeof value) {
        case 'string': return quote(value);
        case 'number':
        case 'boolean': return String(value);
    }

    if (Array.isArray(value)) {
        return joinParts(value.map(item => emitValue(item, ctx, indent + INDENT)), '[', ']', indent);
    }

    const tagged = value as Record<string, any>;
    return tagged['$'] ? emitTagged(tagged, ctx, indent) : emitObject(tagged, ctx, indent);
}

function emitTagged(value: Record<string, any>, ctx: EmitContext, indent: string): string {
    switch (value['$']) {
        case 'undef': return 'undefined';
        case 'nan': return 'NaN';
        case 'inf': return value['v'] > 0 ? 'Infinity' : '-Infinity';
        case 'bigint': return `${value['v']}n`;
        case 'sym': return `Symbol(${quote(value['v'])})`;
        case 'll': return `new maplibregl.LngLat(${value['v'][0]}, ${value['v'][1]})`;
        case 'llb': return `new maplibregl.LngLatBounds([${value['v'][0]}], [${value['v'][1]}])`;
        case 'pt': return `{x: ${value['v'][0]}, y: ${value['v'][1]}}`;
        case 'date': return `new Date(${quote(value['v'])})`;
        case 'ref': return ctx.names[value['v']] ?? `undefined /* ${value['v']} */`;
        case 'circ': return 'undefined /* circular reference */';
        case 'trunc': return 'undefined /* truncated by the recorder */';
        case 'ab': return `${bytes(value['v'])}.buffer`;
        case 'ta':
            return value['c'] === 'Uint8Array' ? bytes(value['v']) : `new ${value['c']}(${bytes(value['v'])}.buffer)`;
        case 'imgdata':
            return `new ImageData(Uint8ClampedArray.from(atob(${quote(value['v'])}), c => c.charCodeAt(0)), ${value['w']}, ${value['h']})`;
        case 'map': {
            const entries = value['v'].map((entry: SerializedValue[]) =>
                `[${emitValue(entry[0], ctx, indent + INDENT)}, ${emitValue(entry[1], ctx, indent + INDENT)}]`);
            return `new Map(${joinParts(entries, '[', ']', indent)})`;
        }
        case 'set':
            return `new Set(${joinParts(value['v'].map((item: SerializedValue) => emitValue(item, ctx, indent + INDENT)), '[', ']', indent)})`;
        case 'img': return hoistImage(value, ctx);
        case 'el': return hoistElement(value, ctx);
        // The source text of a callback the application passed in, e.g. a
        // `transformRequest`. Emitted as itself - that is the readable form.
        case 'fn': return `(${value['v']})`;
        // Some class the recorder could only capture field by field. The fields
        // are what the call actually needed; the class name is a note to whoever
        // is reading, not something to reconstruct - and worth nothing at all if
        // the bundle it came from was minified.
        case 'inst': {
            const plain = emitValue(value['v'], ctx, indent);
            return /^[A-Z]\w{2,}$/.test(value['c']) ? `/* ${value['c']} */ ${plain}` : plain;
        }
        default: return 'undefined';
    }
}

/** A custom marker or popup element, built the way the application built one. */
function hoistElement(value: Record<string, any>, ctx: EmitContext): string {
    const name = local('element', ctx);
    ctx.prelude.push(
        `const ${name} = document.createRange().createContextualFragment(${quote(value['v'])}).firstElementChild;`
    );

    // The computed styles the recorder froze in, so it looks the same in a page
    // without the application's stylesheet.
    const css = (value['css'] ?? []) as Array<Record<string, string>>;
    css.forEach((declarations, i) => {
        const properties = Object.keys(declarations);
        if (!properties.length) return;
        const target = i === 0 ? name : `${name}.querySelectorAll('*')[${i - 1}]`;
        const style = properties.map(property => `${camelCase(property)}: ${quote(declarations[property]!)}`);
        ctx.prelude.push(`Object.assign(${target}.style, ${joinParts(style, '{', '}', '')});`);
    });
    return name;
}

function hoistImage(value: Record<string, any>, ctx: EmitContext): string {
    const name = local('image', ctx);
    ctx.prelude.push(`const ${name} = new Image(${value['w']}, ${value['h']});`);
    if (value['v']) ctx.prelude.push(`${name}.src = ${quote(value['v'])};`, `await ${name}.decode();`);
    return name;
}

function local(kind: string, ctx: EmitContext): string {
    ctx.locals[kind] = (ctx.locals[kind] ?? 0) + 1;
    return (ctx.totals[kind] ?? 0) > 1 ? `${kind}${ctx.locals[kind]}` : kind;
}

function bytes(base64: string): string {
    return `Uint8Array.from(atob(${quote(base64)}), c => c.charCodeAt(0))`;
}

function emitObject(value: Record<string, SerializedValue>, ctx: EmitContext, indent: string): string {
    const parts = Object.keys(value)
        // Underscore-prefixed keys are what the recorder added for itself, e.g.
        // the container size, which the page applies to the map element instead.
        .filter(key => !key.startsWith('__') && !INTERNAL_OPTION.has(key))
        .map(key => `${IDENTIFIER.test(key) ? key : quote(key)}: ${emitValue(value[key], ctx, indent + INDENT)}`);
    return joinParts(parts, '{', '}', indent);
}

/** Keeps short values on one line and breaks long ones across several. */
function joinParts(parts: string[], open: string, close: string, indent: string): string {
    if (!parts.length) return open + close;

    const inline = `${open}${parts.join(', ')}${close}`;
    if (indent.length + inline.length <= MAX_INLINE && !inline.includes('\n')) return inline;

    const inner = indent + INDENT;
    return `${open}\n${inner}${parts.join(`,\n${inner}`)}\n${indent}${close}`;
}

function camelCase(property: string): string {
    return property.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
}

function quote(text: string): string {
    // U+2028 and U+2029 are valid in a JS string but end a line inside a comment,
    // and control characters have to be escaped either way.
    if (!text.includes("'") && !UNSAFE.test(text)) return `'${text}'`;
    return JSON.stringify(text).replace(/\u2028/g, '\\u2028').replace(/\u2029/g, '\\u2029');
}
