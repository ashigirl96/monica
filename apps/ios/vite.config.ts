import { defineConfig } from 'vite'

export default defineConfig({
  base: './',
  plugins: [
    {
      name: 'bundled-classic-script',
      transformIndexHtml: {
        order: 'post',
        handler: (html) =>
          html.replace('type="module" crossorigin', 'defer').replaceAll(' crossorigin', ''),
      },
    },
  ],
  build: {
    target: 'safari26',
    cssCodeSplit: false,
    modulePreload: false,
    rolldownOptions: { output: { format: 'iife' } },
  },
})
