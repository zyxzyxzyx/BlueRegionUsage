/**
 * 配置读取 / 校验 / localStorage 覆盖
 * 优先级：localStorage > config.js（window.APP_CONFIG）
 */
(function () {
  'use strict';

  var STORAGE_KEY = 'blueregion-usage.config.v1';

  var DEFAULTS = {
    trendDays: 14,
    theme: 'auto',
    numberStyle: 'wan',
    dailyCreditLimit: null,
    weeklyCreditLimit: null,
    monthlyCreditLimit: null
  };

  /** 读取 localStorage 中的覆盖配置（无则返回 null） */
  function readLocal() {
    try {
      var raw = window.localStorage.getItem(STORAGE_KEY);
      if (!raw) return null;
      var obj = JSON.parse(raw);
      return (obj && typeof obj === 'object') ? obj : null;
    } catch (e) {
      return null; // localStorage 不可用或内容损坏时静默降级
    }
  }

  /** 合并配置：localStorage 覆盖 config.js，再补默认值 */
  function load() {
    var fileCfg = (typeof window.APP_CONFIG === 'object' && window.APP_CONFIG) || {};
    var localCfg = readLocal() || {};
    var merged = {};
    var keys = ['gatewayBaseUrl', 'apiKey', 'trendDays', 'theme', 'numberStyle',
      'dailyCreditLimit', 'weeklyCreditLimit', 'monthlyCreditLimit'];
    keys.forEach(function (k) {
      if (localCfg[k] !== undefined && localCfg[k] !== null && localCfg[k] !== '') merged[k] = localCfg[k];
      else if (fileCfg[k] !== undefined && fileCfg[k] !== null && fileCfg[k] !== '') merged[k] = fileCfg[k];
      else if (DEFAULTS[k] !== undefined) merged[k] = DEFAULTS[k];
    });
    return merged;
  }

  /**
   * 校验配置，返回 { ok, errors: string[], cfg }
   * gatewayBaseUrl 必须是合法 http(s) URL；apiKey 必填
   */
  function validate(cfg) {
    var errors = [];
    cfg = cfg || {};

    var base = (cfg.gatewayBaseUrl || '').trim();
    if (!base) {
      errors.push('网关地址（gatewayBaseUrl）必填');
    } else {
      try {
        var u = new URL(base);
        if (u.protocol !== 'http:' && u.protocol !== 'https:') {
          errors.push('网关地址必须是 http(s) URL');
        }
      } catch (e) {
        errors.push('网关地址不是合法 URL');
      }
    }

    if (!(cfg.apiKey || '').trim()) {
      errors.push('API Key（apiKey）必填');
    }

    var days = Number(cfg.trendDays);
    if (cfg.trendDays !== undefined && cfg.trendDays !== '') {
      if (!isFinite(days) || days < 1 || days > 15) errors.push('trendDays 必须在 1-15 之间');
    }

    if (cfg.theme && ['auto', 'light', 'dark'].indexOf(cfg.theme) < 0) {
      errors.push('theme 只能是 auto / light / dark');
    }
    if (cfg.numberStyle && ['wan', 'intl'].indexOf(cfg.numberStyle) < 0) {
      errors.push('numberStyle 只能是 wan / intl');
    }

    // 限额类字段：空表示不限，否则必须是非负数字
    ['dailyCreditLimit', 'weeklyCreditLimit', 'monthlyCreditLimit'].forEach(function (k) {
      var raw = cfg[k];
      if (raw === undefined || raw === null || raw === '') return;
      var n = Number(raw);
      if (!isFinite(n) || n < 0) errors.push(k + ' 必须是非负数字');
    });

    return { ok: errors.length === 0, errors: errors, cfg: cfg };
  }

  /** 保存到 localStorage（记住配置） */
  function saveLocal(cfg) {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(cfg));
      return true;
    } catch (e) {
      return false;
    }
  }

  /** 清除 localStorage 覆盖配置 */
  function clearLocal() {
    try { window.localStorage.removeItem(STORAGE_KEY); } catch (e) { /* ignore */ }
  }

  /** 是否存在 localStorage 覆盖配置 */
  function hasLocal() {
    return readLocal() !== null;
  }

  window.BRU = window.BRU || {};
  window.BRU.config = {
    load: load,
    validate: validate,
    saveLocal: saveLocal,
    clearLocal: clearLocal,
    hasLocal: hasLocal,
    readLocal: readLocal,
    DEFAULTS: DEFAULTS
  };
})();
