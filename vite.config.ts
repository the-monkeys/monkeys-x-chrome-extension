import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';

// Wraps specified output chunks in an IIFE to prevent global scope pollution.
// This is necessary because Chrome injects all content scripts from the same
// extension into a shared scope — minified variable names can collide.
function iifeWrapPlugin(): Plugin {
  const wrapTargets = ['content.js', 'notifications-watcher.js', 'snapshot-automator.js', 'x-reply-automator.js'];
  return {
    name: 'iife-wrap',
    generateBundle(_options, bundle) {
      for (const [fileName, chunk] of Object.entries(bundle)) {
        if (chunk.type === 'chunk' && wrapTargets.includes(fileName)) {
          chunk.code = `(function(){\n${chunk.code}\n})();\n`;
        }
      }
    }
  };
}

export default defineConfig({
  define: { __MONKEYS_BUILD_ID__: JSON.stringify(new Date().toISOString()) },
  plugins: [react(), iifeWrapPlugin()],
  build: {
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'index.html'),
        background: resolve(__dirname, 'src/background/background.ts'),
        content: resolve(__dirname, 'src/content/content.ts'),
        'notifications-watcher': resolve(__dirname, 'src/content/notifications-watcher.ts'),
        'snapshot-automator': resolve(__dirname, 'src/content/snapshot-automator.ts'),
        'x-reply-automator': resolve(__dirname, 'src/content/x-reply-automator.ts'),
      },
      output: {
        entryFileNames: (chunkInfo) => {
          const names = ['background', 'content', 'notifications-watcher', 'snapshot-automator', 'x-reply-automator'];
          if (names.includes(chunkInfo.name)) return '[name].js';
          return 'assets/[name]-[hash].js';
        },
        chunkFileNames: 'assets/[name]-[hash].js',
        assetFileNames: (assetInfo) => {
          if (assetInfo.name === 'content.css') return 'content.css';
          return 'assets/[name]-[hash][extname]';
        }
      }
    }
  }
});
