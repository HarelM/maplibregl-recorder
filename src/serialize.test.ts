import { describe, expect, it } from 'vitest';
import { serialize, type SerializeContext } from './serialize';

const ctx: SerializeContext = {
    idFor: () => undefined,
    options: { recordFunctions: true, captureElementStyles: false },
};

describe('serialize', () => {
    it('tags the non-JSON values that appear in MapLibre arguments', () => {
        expect(serialize({
            zoom: 4.5,
            name: 'layer',
            visible: true,
            missing: undefined,
            nothing: null,
            broken: Number.NaN,
            far: Number.POSITIVE_INFINITY,
            center: [1, 2],
        }, ctx)).toEqual({
            zoom: 4.5,
            name: 'layer',
            visible: true,
            missing: { $: 'undef' },
            nothing: null,
            broken: { $: 'nan' },
            far: { $: 'inf', v: 1 },
            center: [1, 2],
        });
    });
});
