/**
 * BlueRegion Usage 面板配置模板（示例）
 * ===============================================================
 * 使用方法：复制本文件为 config.js，按需修改下方配置项。
 * !! 注意：config.js 会包含你的 API Key，请勿提交 git / 请勿截图分享 !!
 * 优先级：浏览器 localStorage 中保存的配置 > config.js。
 */

window.APP_CONFIG = {
  // 网关地址（必填）：BlueRegion API 网关基础地址，必须是合法 http(s) URL
  // 示例：'https://gateway.example.com'；本地联调可用 'http://localhost:8765'
  gatewayBaseUrl: 'http://localhost:8765',

  // API Key（必填）：网关签发的个人 Key，请求时以 Bearer 方式携带
  apiKey: 'api-key-xxxxxxxx',

  // 趋势图天数（1-15，默认 14）：仅"今日"周期下，趋势图回看的天数
  trendDays: 14,

  // 主题：auto（跟随系统）| light（浅色）| dark（深色），默认 auto
  theme: 'auto',

  // 大数字缩写风格：wan（万 / 亿，默认）| intl（K / M / B）
  numberStyle: 'wan'
};
