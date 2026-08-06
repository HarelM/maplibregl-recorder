import { defineConfig } from 'rolldown';
import { dts } from 'rolldown-plugin-dts';

const name = 'maplibregl-recorder';

export default defineConfig([
    {
        input: 'src/index.ts',
        output: {
            file: `dist/${name}.mjs`,
            format: 'es',
            sourcemap: true,
        },
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
