import typescript from '@rollup/plugin-typescript'
import nodeResolve from '@rollup/plugin-node-resolve'
import commonjs from '@rollup/plugin-commonjs'
import json from '@rollup/plugin-json'
import { builtinModules } from 'module'
import pkg from './package.json' assert { type: 'json' }

const external = [
    ...builtinModules,
    ...Object.keys(pkg.dependencies || {}),
    ...Object.keys(pkg.devDependencies || {}),
    'node:path', 'node:url', 'node:fs', 'node:events', 'node:http', 'node:https'
]

export default {
    input: 'src/app.ts',
    output: {
        dir: 'dist',
        format: 'esm',
        sourcemap: false,
    },
    external: (id) => external.some(pkgName => id === pkgName || id.startsWith(`${pkgName}/`)),
    plugins: [
        nodeResolve({
            preferBuiltins: true,
            exportConditions: ['node']
        }),
        commonjs(),
        json(),
        typescript({
            tsconfig: './tsconfig.json',
            outDir: './dist',
            declaration: false,
        }),
    ],
}
