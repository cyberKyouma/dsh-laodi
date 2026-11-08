/**
 * DSH bundle 入口（Cordis 插件三件套）。
 * 业务在 src/dsh-plugin.mjs，这里只做再导出，避免相对路径踩坑。
 */
export { name, inject, apply } from './src/dsh-plugin.mjs';
