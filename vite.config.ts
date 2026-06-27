import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';

export default defineConfig(({ command }) => {
  if (command === 'serve') {
    return {
      root: 'demo',
      plugins: [vue()],
    };
  }
  return {
    plugins: [vue(), dts({ include: ['src'] })],
    build: {
      lib: {
        entry: resolve(__dirname, 'src/index.ts'),
        name: 'TianAnnotateVue',
        fileName: (format) => `tian-annotate-vue.${format === 'es' ? 'es.js' : 'umd.cjs'}`,
      },
      rollupOptions: {
        external: ['vue'],
        output: {
          globals: { vue: 'Vue' },
        },
      },
    },
  };
});
