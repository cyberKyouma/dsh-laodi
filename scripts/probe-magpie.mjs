#!/usr/bin/env node
import { resolveMagpieVision } from '../src/vision/magpie.mjs';
import { VisionClient } from '../src/vision/client.mjs';

const magpie = resolveMagpieVision();
console.log(JSON.stringify({ magpie: { ...magpie, apiKey: magpie.apiKey ? '(set)' : '' } }, null, 2));

const pixel =
  'iVBORw0KGgoAAAANSUhEUgAAACAAAAAgCAYAAABzenr0AAAAAXNSR0IArs4c6QAAAARnQU1BAACxjwv8YQUAAAAJcEhZcwAADsMAAA7DAcdvqGQAAACESURBVFhH7dFBCsAgDETRHsz7n6J3SclCkPKjpi1oYRZv6eSDx1mKraQABSggHWB2DNG7SCqAjkXoPZkKoAOzaK+1fwCNZtFu1Q2gsado3ylg3wAaeYNuOH2BAroBjsayaLcaBjganUV7rX8EVHQgQu9JKsDRsTt6F0kHfE0BClgcUOwCO5sXy45ZFqUAAAAASUVORK5CYII=';

const client = new VisionClient({
  baseURL: magpie.baseURL,
  model: magpie.model,
  apiKey: magpie.apiKey,
  mock: false,
  prompt: '这是一张测试图。用不超过 10 个字描述你看到了什么，并输出 JSON：{"scene":"unknown","summary":"...","suggestion":"测试通过","spoilerLevel":0}',
});

try {
  const result = await client.describe({ imageBase64: pixel, mimeType: 'image/png' });
  console.log('VISION_OK', JSON.stringify(result));
  process.exit(0);
} catch (err) {
  console.error('VISION_FAIL', err?.message || err);
  process.exit(1);
}
