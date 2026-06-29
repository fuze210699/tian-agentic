import * as esbuild from 'esbuild';

await esbuild.build({
  entryPoints: ['src/vite-plugin.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/vite.cjs',
  external: ['vite'],
});

await esbuild.build({
  entryPoints: ['src/webpack-plugin.ts'],
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'cjs',
  outfile: 'dist/webpack.cjs',
});

console.log('Plugin build complete: dist/vite.cjs, dist/webpack.cjs');
