/**
 * 常用路径（相对项目根解析，避免 cwd 依赖）。
 */

import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const PROJECT_ROOT = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
);
export const SRC_DIR = path.join(PROJECT_ROOT, 'src');
export const DATA_DIR = path.join(PROJECT_ROOT, 'data', 'p5r');
export const RUNTIME_DIR = path.join(PROJECT_ROOT, 'runtime');
export const OVERLAY_HTML = path.join(RUNTIME_DIR, 'overlay', 'overlay.html');

export default { PROJECT_ROOT, SRC_DIR, DATA_DIR, RUNTIME_DIR, OVERLAY_HTML };
