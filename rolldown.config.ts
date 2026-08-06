import { defineConfig } from 'rolldown';
import { dts } from 'rolldown-plugin-dts';

const name = 'maplibregl-recorder';

export default defineConfig([
    {
        input: 'src/index.ts',
        output: [
            {
                // CommonJS rather than UMD: `require()` is all this output is for,
                // and a UMD bundle would put a global on `window` the moment
                // someone dropped it into a page with a <script> tag.
                file: `dist/${name}.js`,
                format: 'cjs',
                sourcemap: true,
            },
            {
                file: `dist/${name}.mjs`,
                format: 'es',
                sourcemap: true,
            },
        ],
    },
    {
        input: { [name]: 'src/index.ts' },
        plugins: [dts({ emitDtsOnly: true })],
        output: {
            dir: 'dist',
            format: 'es',
        },
    },
]);
