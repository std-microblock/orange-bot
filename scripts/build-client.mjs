/**
 * Bundle a plugin's browser half into the artifact the harness serves as its `./client` export.
 *
 * Usage: `node build-client.mjs [package dir]` (default: the current directory). Bundles
 * `<dir>/src/client/index.tsx` (or `index.ts`) into `<dir>/client/client.js`; the bundle id is the package name.
 *
 * The harness loads a plugin's browser half as one closure factory (`window.__ModuleLoader__.load({ id, factory })`),
 * resolves the platform modules it shares (React, the slot runtime, the UI primitives, the store) through the
 * `require` handed to that factory, and inlines everything else. The build reproduces that artifact shape: CommonJS
 * output, the platform modules kept as imports, one banner and one footer. Stylesheets are imported as text; inject
 * them with one `<style>` tag.
 *
 * Any extension package may run this script from here (`node ../im-panel/scripts/build-client.mjs .`) or copy it: it
 * depends on nothing but esbuild.
 */

import { existsSync, readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { build } from 'esbuild'

const root = resolve(process.argv[2] ?? '.')
const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
if (typeof manifest.name !== 'string') throw new Error(`${root}/package.json declares no name`)
const id = manifest.name
const entry = ['src/client/index.tsx', 'src/client/index.ts'].map(path => resolve(root, path)).find(existsSync)
if (entry === undefined) throw new Error(`${root} has no src/client/index.tsx`)

/**
 * The modules the web shell shares into its frozen module table. React must come from there: a second copy would give
 * the slot renderer a different React instance.
 */
const PLATFORM_MODULES = [
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  'zod',
  '@tanstack/react-virtual',
  '@deepseek-ai/dsh-client-store',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-dockkit',
]

await build({
  entryPoints: [entry],
  outfile: resolve(root, 'client/client.js'),
  bundle: true,
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  jsx: 'automatic',
  minify: false,
  sourcemap: false,
  legalComments: 'none',
  loader: { '.css': 'text' },
  external: PLATFORM_MODULES,
  banner: {
    js: `window.__ModuleLoader__.load({ id: ${JSON.stringify(id)}, factory: (require) => {\n`
      + 'var module = { exports: {} }; var exports = module.exports;',
  },
  footer: { js: 'return module.exports; } });' },
  logLevel: 'info',
})
