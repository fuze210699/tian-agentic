import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import dts from 'vite-plugin-dts';
import { resolve } from 'path';
import { tianAnnotate } from 'tian-vue-annotate/vite';

export default defineConfig(({ command }) => {
  if (command === 'serve') {
    return {
      root: 'demo',
      plugins: [vue(), tianAnnotate()],
    };
  }
  return {
    plugins: [vue(), dts({ include: ['src'] })],
    build: {
      lib: {
        entry: resolve(__dirname, 'src/index.ts'),
        name: 'TianVueAnnotate',
        fileName: (format) => `tian-vue-annotate.${format === 'es' ? 'es.js' : 'umd.cjs'}`,
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
