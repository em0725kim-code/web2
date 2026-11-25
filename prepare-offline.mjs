import { readFile, writeFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { gzipSync } from 'node:zlib';

const { createCatalog } = createRequire(import.meta.url)('./data.js');
const path = name => new URL(name, import.meta.url);
const original = await readFile(path('./전국주유소표준데이터/HangJeongDong_ver20261001.geojson'));
const features = JSON.parse(original.toString('utf8')).features;
const catalog = createCatalog(features);
const compressed = gzipSync(original, { level: 9 }).toString('base64');
const header = '// Generated from HangJeongDong_ver20261001.geojson by prepare-offline.mjs.\n';
await Promise.all([
  writeFile(path('./offline-regions.js'), `${header}globalThis.fuelRegions = ${JSON.stringify(catalog)};\n`),
  writeFile(path('./offline-boundaries.js'), `${header}globalThis.fuelBoundariesGzip = '${compressed}';\n`),
]);
