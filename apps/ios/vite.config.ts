import { defineConfig } from 'vite'

export default defineConfig({ base: './', build: { target: 'safari26', modulePreload: false } })
