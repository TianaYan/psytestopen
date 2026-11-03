/**
 * 站点级部署配置。改这个文件就行，不用动业务代码。
 *
 * - 填了 proxyBase：页面走代理，访客**不需要填 API Key**（密钥存在代理的 secret 里，
 *   仓库与页面上都没有密钥）。
 * - 不填：回到自带密钥模式，访客自己填 Key（当前默认）。
 *
 * 代理怎么部署、地址从哪来，见 worker/README.md。
 */
window.PSYTEST_CONFIG = {
  // 例：'https://psytest-proxy.你的子域.workers.dev'
  proxyBase: '',
};
