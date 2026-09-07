/**
 * 数字 / 百分比 / 延迟 / 日期格式化工具
 * - 卡片与坐标轴用缩写（wan / intl 两种风格）
 * - tooltip 与表格永远显示完整千分位
 */
(function () {
  'use strict';

  /** 千分位完整数字，如 2,453,824；非法值返回 -- */
  function fullNumber(n) {
    if (n === null || n === undefined || !isFinite(Number(n))) return '--';
    return Number(n).toLocaleString('en-US');
  }

  /**
   * 大数字缩写
   * wan 模式：<1万 原值千分位；>=1万 x.x 万；>=1亿 x.xx 亿
   * intl 模式：K / M / B
   */
  function abbrev(n, style) {
    if (n === null || n === undefined || !isFinite(Number(n))) return '--';
    n = Number(n);
    var neg = n < 0 ? '-' : '';
    n = Math.abs(n);
    if (style === 'intl') {
      if (n >= 1e9) return neg + (n / 1e9).toFixed(2) + 'B';
      if (n >= 1e6) return neg + (n / 1e6).toFixed(1) + 'M';
      if (n >= 1e3) return neg + (n / 1e3).toFixed(1) + 'K';
      return neg + String(Math.round(n));
    }
    // 默认 wan
    if (n >= 1e8) return neg + (n / 1e8).toFixed(2) + ' 亿';
    if (n >= 1e4) return neg + (n / 1e4).toFixed(1) + ' 万';
    return neg + Number(n).toLocaleString('en-US');
  }

  /**
   * 缓存命中率：输入比例（0-1），输出 1 位小数百分比
   * 分母为 0 / 空值时显示 --
   */
  function hitRate(ratio) {
    if (ratio === null || ratio === undefined || !isFinite(Number(ratio))) return '--';
    return (Number(ratio) * 100).toFixed(1) + '%';
  }

  /** 由分子分母计算命中率，分母为 0 时返回 -- */
  function hitRateOf(cached, req) {
    if (!req || !isFinite(Number(req)) || Number(req) <= 0) return '--';
    return hitRate(Number(cached || 0) / Number(req));
  }

  /** TTFT：<1000ms 显示 xxx ms，>=1s 显示 x.xx s */
  function latency(ms) {
    if (ms === null || ms === undefined || !isFinite(Number(ms))) return '--';
    ms = Number(ms);
    if (ms < 1000) return Math.round(ms) + ' ms';
    return (ms / 1000).toFixed(2) + ' s';
  }

  /**
   * Credit 用量（估算值）：2 位小数千分位；0 < v < 0.01 显示 <0.01
   * Credit = 总 Tokens ÷ 1e6 × 模型 Credit 系数
   */
  function credit(v) {
    if (v === null || v === undefined || !isFinite(Number(v))) return '--';
    v = Number(v);
    if (v > 0 && v < 0.01) return '<0.01';
    return v.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }

  /** '2026-09-05' -> '09-05'，趋势图横轴用 */
  function shortDate(iso) {
    if (!iso || typeof iso !== 'string') return '';
    var m = iso.match(/^\d{4}-(\d{2}-\d{2})/);
    return m ? m[1] : iso;
  }

  /** 秒级时间戳 -> 'HH:MM:SS' */
  function timeOfDay(epochSec) {
    if (!epochSec || !isFinite(Number(epochSec))) return '--';
    var d = new Date(Number(epochSec) * 1000);
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
  }

  /** Date -> 'YYYY-MM-DD'，CSV 文件名用 */
  function todayStr(d) {
    d = d || new Date();
    function p(x) { return (x < 10 ? '0' : '') + x; }
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }

  /** 秒级时间戳 -> 'HH:00'，分时图横轴用 */
  function hourLabel(epochSec) {
    if (!epochSec || !isFinite(Number(epochSec))) return '';
    var d = new Date(Number(epochSec) * 1000);
    return (d.getHours() < 10 ? '0' : '') + d.getHours() + ':00';
  }

  /**
   * 环比变化（比值）：当前值与上一周期值比较，返回 { text, dir }
   * dir: 1 升 / -1 降 / 0 持平；基准为 0 或空值时返回 null（不展示）
   */
  function pctChange(cur, prev) {
    cur = Number(cur); prev = Number(prev);
    if (!isFinite(cur) || !isFinite(prev) || prev <= 0) return null;
    var d = (cur - prev) / prev;
    var dir = d > 0.0005 ? 1 : (d < -0.0005 ? -1 : 0);
    return { text: (d >= 0 ? '+' : '') + (d * 100).toFixed(1) + '%', dir: dir };
  }

  /** 比率环比（百分点差）：如命中率 32.1% vs 30.0% -> '+2.1pp' */
  function ppChange(cur, prev) {
    cur = Number(cur); prev = Number(prev);
    if (!isFinite(cur) || !isFinite(prev)) return null;
    var d = (cur - prev) * 100;
    var dir = d > 0.05 ? 1 : (d < -0.05 ? -1 : 0);
    return { text: (d >= 0 ? '+' : '') + d.toFixed(1) + 'pp', dir: dir };
  }

  /** API Key 脱敏：保留前 11 位与后 2 位，如 api-key-t006••••56 */
  function maskKey(key) {
    if (!key) return '';
    key = String(key);
    if (key.length <= 6) return key.charAt(0) + '••••';
    if (key.length <= 13) return key.slice(0, 4) + '••••' + key.slice(-2);
    return key.slice(0, 11) + '••••' + key.slice(-2);
  }

  window.BRU = window.BRU || {};
  window.BRU.format = {
    fullNumber: fullNumber,
    abbrev: abbrev,
    hitRate: hitRate,
    hitRateOf: hitRateOf,
    latency: latency,
    credit: credit,
    shortDate: shortDate,
    timeOfDay: timeOfDay,
    todayStr: todayStr,
    hourLabel: hourLabel,
    pctChange: pctChange,
    ppChange: ppChange,
    maskKey: maskKey
  };
})();
