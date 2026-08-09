import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { existsSync } from 'node:fs';
import path from 'node:path';

function resolveMigratedTypeScript() {
  return {
    name: 'resolve-migrated-typescript',
    enforce: 'pre',
    resolveId(source, importer) {
      if (!importer || !/^\.\.?\/.*\.jsx?$/.test(source)) return null;
      const extensions = source.endsWith('.jsx') ? ['.tsx'] : ['.ts', '.tsx'];
      for (const extension of extensions) {
        const candidate = path.resolve(
          path.dirname(importer.split('?')[0]),
          source.replace(/\.jsx?$/, extension),
        );
        if (existsSync(candidate)) return candidate;
      }
      return null;
    },
  };
}

// Make the bundled app stylesheet non-render-blocking. By default Vite emits a plain
// <link rel="stylesheet"> in <head>, which blocks the FIRST paint until that ~48KB CSS finishes
// downloading — over the tunnel that delay is long enough that Android dismisses its native PWA splash
// before our inline boot splash has painted, leaving a transparent window that shows the (blurred)
// home-screen wallpaper. Loading the CSS with media="print" + onload swap lets the inline splash (its
// styles live in index.html's <head>) paint on frame one; the app CSS arrives in parallel, well before
// the much larger JS bundle finishes and React mounts, so there's no flash of unstyled content.
function asyncAppCss() {
  return {
    name: 'async-app-css',
    enforce: 'post',
    transformIndexHtml(html) {
      return html.replace(
        /<link rel="stylesheet"([^>]*)>/g,
        (_m, attrs) =>
          `<link rel="stylesheet"${attrs} media="print" onload="this.media='all'">` +
          `<noscript><link rel="stylesheet"${attrs}></noscript>`,
      );
    },
  };
}

export default defineConfig({
  plugins: [resolveMigratedTypeScript(), react(), asyncAppCss()],
  server: {
    host: true,
    port: 9010, // 开发前端(vite dev)监听端口；它把 /api 代理到后端 9999
    proxy: {
      // 指向【开发】后端(`node bin/handmux.js start` 读项目里的 ./config.json,端口 9999),
      // 而非生产。改了 dev config 的端口要同步这里。用 127.0.0.1(而非 localhost)强制 IPv4,避免
      // localhost 先解析到 ::1 与后端绑定的 0.0.0.0(IPv4) 不匹配导致代理 ECONNREFUSED。
      '/api': 'http://127.0.0.1:9999',
      '/ws': { target: 'ws://127.0.0.1:9999', ws: true },
    },
  },
  test: {
    environment: 'jsdom',
    // Component tests carry JSX, so they're named .test.jsx (plain logic tests stay .test.js).
    include: ['test/**/*.test.{js,jsx,ts,tsx}', 'src/**/*.test.{js,jsx,ts,tsx}'],
    setupFiles: ['./test/setup.js'],
    // React warnings are test failures, not harmless stderr. This keeps async state updates from
    // silently drifting back outside act() while the suite still reports green.
    onConsoleLog(log) {
      if (/^Warning:/m.test(log)) throw new Error(`Unexpected test warning:\n${log}`);
    },
  },
});
