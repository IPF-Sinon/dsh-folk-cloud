/**
 * tsdown config — client-half bundle only.
 *
 * The host half is built by `tsc -p tsconfig.build.json` into lib/ (structure
 * preserved, ESM). This config bundles src/client/index.ts into lib/client.js
 * with the exact loader shape dsh-config-manager / dsh-ssh ship (verified
 * against their published lib/client.js):
 *
 *   window.__ModuleLoader__.load({
 *     id: "dsh-folk-cloud",
 *     factory: (require) => { ... cjs bundle ... return module.exports; }
 *   });
 *
 * - `format: 'cjs'` + external react/react-dom → the factory's `require`
 *   parameter resolves them (the client runtime supplies react);
 * - `banner`/`footer` wrap the bundle in that loader call; the id **must**
 *   equal the package name, otherwise the runtime cannot match the module;
 * - `clean: false` so tsdown never wipes the tsc-built host lib/;
 * - no CSS Modules here: this plugin's settings page uses plain inline styles,
 *   so the lightningcss plugin dsh-config-manager needs is unnecessary.
 */
import { defineConfig } from 'tsdown';

/** Loader id must match the package name (dsh-ssh uses "@linxin666/dsh-ssh"). */
const LOADER_ID = 'dsh-folk-cloud';

export default defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  deps: {
    neverBundle: ['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime'],
  },
  sourcemap: true,
  clean: false,
  hash: false,
  // Force lib/client.js (not .cjs): the package is `type: module` and the loader
  // serves the `./client` export by that exact filename.
  outExtensions: ({ format }) => (format === 'cjs' ? { js: '.js', dts: '.d.ts' } : undefined),
  banner: [
    'window.__ModuleLoader__.load({',
    `\tid: "${LOADER_ID}",`,
    '\tfactory: (require) => {',
    '\t\tvar module = { exports: {} };',
    '\t\tvar exports = module.exports;',
    '',
  ].join('\n'),
  footer: ['', '\t\treturn module.exports;', '\t}', '});'].join('\n'),
});
