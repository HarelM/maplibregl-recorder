import type { RecorderOptions, SerializedValue } from './types';

/**
 * CSS properties captured from custom marker/popup elements so that they render
 * the same way in a reproduction that does not have the host page stylesheet.
 */
const CAPTURED_CSS = [
    'box-sizing', 'display', 'width', 'height', 'min-width', 'min-height', 'max-width', 'max-height',
    'margin', 'padding', 'border', 'border-radius', 'background-color', 'background-image',
    'background-size', 'background-position', 'background-repeat', 'color', 'font-family',
    'font-size', 'font-weight', 'font-style', 'line-height', 'letter-spacing', 'text-align',
    'text-transform', 'white-space', 'opacity', 'overflow', 'z-index', 'flex-direction',
    'align-items', 'justify-content', 'gap', 'box-shadow', 'fill', 'stroke', 'stroke-width',
    'pointer-events', 'cursor'
];

/** Computed values that carry no information and would only bloat the export. */
const DEFAULT_CSS_VALUES = new Set(['none', 'normal', 'auto', '0px', 'rgba(0, 0, 0, 0)']);

const MAX_FUNCTION_SOURCE = 20000;
const MAX_ELEMENT_HTML = 200000;
const MAX_DEPTH = 24;
const MAX_STYLED_NODES = 100;

/**
 * Everything `serialize` needs from the recorder that owns it.
 */
export type SerializeContext = {
    /** The id of an already recorded instance, e.g. `marker#3`, if it has one. */
    idFor: (value: object) => string | undefined;
    /** The active recorder options. */
    options: Required<Pick<RecorderOptions, 'recordFunctions' | 'captureElementStyles'>>;
};

/**
 * Converts an arbitrary argument into something `JSON.stringify` can handle,
 * representing non-JSON values as tagged objects that `deserialize` in the
 * generated replay page understands.
 *
 * @param value - the value to serialize
 * @param ctx - recorder context
 * @param seen - objects currently on the stack, for cycle detection
 * @param depthLeft - remaining recursion budget
 * @returns a JSON-safe representation of `value`
 */
export function serialize(value: unknown, ctx: SerializeContext, seen: WeakSet<object> = new WeakSet(), depthLeft: number = MAX_DEPTH): SerializedValue {
    if (value === null) return null;
    if (value === undefined) return {$: 'undef'};

    switch (typeof value) {
        case 'number':
            if (Number.isNaN(value)) return {$: 'nan'};
            if (!Number.isFinite(value)) return {$: 'inf', v: value > 0 ? 1 : -1};
            return value;
        case 'string':
        case 'boolean':
            return value;
        case 'bigint':
            return {$: 'bigint', v: value.toString()};
        case 'symbol':
            return {$: 'sym', v: String(value.description ?? '')};
        case 'function':
            return {
                $: 'fn',
                n: value.name || '',
                v: ctx.options.recordFunctions ? truncate(String(value), MAX_FUNCTION_SOURCE) : 'function() {}'
            };
    }

    const object = value as object;
    const existingId = ctx.idFor(object);
    if (existingId) return {$: 'ref', v: existingId};
    if (depthLeft <= 0) return {$: 'trunc'};
    if (seen.has(object)) return {$: 'circ'};

    const tagged = serializeKnownType(object, ctx);
    if (tagged) return tagged;

    seen.add(object);
    try {
        if (Array.isArray(value)) {
            return value.map(item => serialize(item, ctx, seen, depthLeft - 1));
        }
        return serializePlainObject(object, ctx, seen, depthLeft);
    } finally {
        seen.delete(object);
    }
}

/**
 * Handles the value types MapLibre APIs actually receive - geographic types, DOM
 * nodes, images and binary data - which structured cloning cannot express as JSON.
 * Detection is structural so it works no matter how the application imported MapLibre.
 */
function serializeKnownType(value: object, ctx: SerializeContext): SerializedValue {
    const ctorName = value.constructor?.name ?? '';
    const anyValue = value as any;

    if (typeof anyValue.lng === 'number' && typeof anyValue.lat === 'number' && typeof anyValue.wrap === 'function') {
        return {$: 'll', v: [anyValue.lng, anyValue.lat]};
    }
    if (typeof anyValue.getSouthWest === 'function' && typeof anyValue.getNorthEast === 'function') {
        const sw = anyValue.getSouthWest();
        const ne = anyValue.getNorthEast();
        return {$: 'llb', v: [[sw.lng, sw.lat], [ne.lng, ne.lat]]};
    }
    if (ctorName === 'Point' && typeof anyValue.x === 'number' && typeof anyValue.y === 'number') {
        return {$: 'pt', v: [anyValue.x, anyValue.y]};
    }
    if (value instanceof Date) return {$: 'date', v: value.toISOString()};
    if (isImageLike(value)) return serializeImage(value);
    if (typeof Element !== 'undefined' && value instanceof Element) return serializeElement(value, ctx);
    if (typeof ImageData !== 'undefined' && value instanceof ImageData) {
        return {$: 'imgdata', w: value.width, h: value.height, v: bytesToBase64(new Uint8Array(value.data.buffer))};
    }
    if (ArrayBuffer.isView(value) && !(value instanceof DataView)) {
        const view = value as Uint8Array;
        return {$: 'ta', c: ctorName, v: bytesToBase64(new Uint8Array(view.buffer, view.byteOffset, view.byteLength))};
    }
    if (value instanceof ArrayBuffer) return {$: 'ab', v: bytesToBase64(new Uint8Array(value))};
    if (value instanceof Map) {
        return {$: 'map', v: [...value.entries()].map(([k, v]) => [serialize(k, ctx), serialize(v, ctx)])};
    }
    if (value instanceof Set) {
        return {$: 'set', v: [...value].map(item => serialize(item, ctx))};
    }
    return null;
}

function serializePlainObject(value: object, ctx: SerializeContext, seen: WeakSet<object>, depthLeft: number): SerializedValue {
    const plain: Record<string, SerializedValue> = {};
    for (const key of Object.keys(value)) {
        // Underscore-prefixed members are the internal state of class instances;
        // reconstructing them would produce an invalid object.
        if (key.startsWith('_')) continue;
        let member: unknown;
        try {
            member = (value as Record<string, unknown>)[key];
        } catch {
            continue;
        }
        plain[key] = serialize(member, ctx, seen, depthLeft - 1);
    }

    const ctorName = value.constructor?.name ?? '';
    const isPlain = !ctorName || ctorName === 'Object';
    return isPlain ? plain : {$: 'inst', c: ctorName, v: plain};
}

function isImageLike(value: object): value is HTMLImageElement | HTMLCanvasElement | ImageBitmap {
    return (typeof HTMLImageElement !== 'undefined' && value instanceof HTMLImageElement) ||
        (typeof HTMLCanvasElement !== 'undefined' && value instanceof HTMLCanvasElement) ||
        (typeof ImageBitmap !== 'undefined' && value instanceof ImageBitmap);
}

function serializeImage(image: HTMLImageElement | HTMLCanvasElement | ImageBitmap): SerializedValue {
    const width = image.width || (image as HTMLImageElement).naturalWidth;
    const height = image.height || (image as HTMLImageElement).naturalHeight;
    try {
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        canvas.getContext('2d')!.drawImage(image, 0, 0);
        return {$: 'img', w: width, h: height, v: canvas.toDataURL('image/png')};
    } catch {
        // Tainted canvas - the reproduction gets a placeholder of the right size.
        return {$: 'img', w: width, h: height, v: null};
    }
}

function serializeElement(element: Element, ctx: SerializeContext): SerializedValue {
    const out: Record<string, SerializedValue> = {$: 'el', v: truncate(element.outerHTML, MAX_ELEMENT_HTML)};
    if (!ctx.options.captureElementStyles || typeof getComputedStyle !== 'function') return out;

    const nodes = [element, ...[...element.querySelectorAll('*')].slice(0, MAX_STYLED_NODES)];
    out['css'] = nodes.map(node => {
        const computed = getComputedStyle(node);
        const declarations: Record<string, string> = {};
        for (const property of CAPTURED_CSS) {
            const value = computed.getPropertyValue(property);
            if (value && !DEFAULT_CSS_VALUES.has(value)) declarations[property] = value;
        }
        return declarations;
    });
    return out;
}

function truncate(text: string, max: number): string {
    return text.length > max ? `${text.slice(0, max)}/* ...truncated by the recorder... */` : text;
}

function bytesToBase64(bytes: Uint8Array): string {
    const chunkSize = 0x8000;
    let binary = '';
    for (let i = 0; i < bytes.length; i += chunkSize) {
        binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
    }
    return btoa(binary);
}
