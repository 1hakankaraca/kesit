// Sunucuyu masaüstü uygulaması için tek dosyaya paketler (esbuild).
// Motor (server/engine, CommonJS) de pakete girer: engine.ts'deki
// require(`./engine/${ad}.js`) esbuild'in glob desteğiyle çözülür; böylece
// paketlenmiş uygulamada node_modules aranmaz. Yalnız Redis modülleri
// (bullmq/ioredis) dışarıda kalır — Kesit'te hiç kullanılmaz.
import { build } from '../desktop/node_modules/esbuild/lib/main.js';
import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(import.meta.dirname, '..');
const out = path.join(root, 'desktop', 'dist-server');
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });

await build({
  entryPoints: [path.join(root, 'server/index.ts')],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node22',
  outfile: path.join(out, 'server.mjs'),
  external: ['bullmq', 'ioredis'],
  // CommonJS motor dosyaları __dirname bekler (FacecamDetector vendor/ okur);
  // ESM pakette sunucu dizinine işaret eder, vendor/ yanına kopyalanır.
  banner: {
    js: [
      "import { createRequire as __cr } from 'node:module';",
      "import { fileURLToPath as __fu } from 'node:url';",
      "import { dirname as __dn } from 'node:path';",
      'const require = __cr(import.meta.url);',
      'const __filename = __fu(import.meta.url);',
      'const __dirname = __dn(__filename);',
    ].join('\n'),
  },
  logLevel: 'warning',
  sourcemap: false,
  legalComments: 'none',
});

fs.cpSync(path.join(root, 'server/engine/vendor'), path.join(out, 'vendor'), { recursive: true });
const size = fs.statSync(path.join(out, 'server.mjs')).size;
console.log(`sunucu paketi hazır: ${(size / 1024).toFixed(0)} KB + vendor/`);
