import typescript from 'rollup-plugin-typescript2'

export default {
    input: 'src/app.ts',
    output: {
        dir: 'dist',           // <-- Usa esta opción
        format: 'cjs',         // o el formato que uses
    },
    onwarn: (warning) => {
        if (warning.code === 'UNRESOLVED_IMPORT') return
    },
    plugins: [typescript()],
}
