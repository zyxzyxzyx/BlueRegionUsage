/**
 * fetch 封装：鉴权头、10s 超时（AbortController）、错误归一化
 * 归一化错误结构：{ status: Number|null, code: string, message: string }
 *   code: 'unauthorized' | 'http' | 'timeout' | 'network' | 'bad_response'
 */
(function () {
  'use strict';

  var TIMEOUT_MS = 10000;

  function normalizeError(err, status) {
    if (err && err.name === 'AbortError') {
      return { status: null, code: 'timeout', message: '请求超时（10 秒未响应）' };
    }
    if (status === 401) {
      return { status: 401, code: 'unauthorized', message: 'API Key 无效或已过期（401）' };
    }
    if (typeof status === 'number') {
      return { status: status, code: 'http', message: '网关返回错误（HTTP ' + status + '）' };
    }
    return { status: null, code: 'network', message: '网络失败：地址不可达或 CORS 未放行' };
  }

  /**
   * 发起 GET 请求
   * @param {Object} cfg  含 gatewayBaseUrl / apiKey
   * @param {string} path 如 /v1/usage/summary
   * @param {Object} [params] query 参数
   * @returns {Promise<Object>} 成功 resolve 响应 JSON，失败 reject 归一化错误
   */
  function get(cfg, path, params) {
    return new Promise(function (resolve, reject) {
      var base = String(cfg.gatewayBaseUrl || '').replace(/\/+$/, '');
      var url;
      try {
        url = new URL(base + path);
        if (params) {
          Object.keys(params).forEach(function (k) {
            if (params[k] !== undefined && params[k] !== null) {
              url.searchParams.set(k, params[k]);
            }
          });
        }
      } catch (e) {
        reject({ status: null, code: 'bad_response', message: '网关地址非法：' + e.message });
        return;
      }

      var ctrl = new AbortController();
      var timer = setTimeout(function () { ctrl.abort(); }, TIMEOUT_MS);

      fetch(url.toString(), {
        method: 'GET',
        headers: { 'Authorization': 'Bearer ' + cfg.apiKey },
        signal: ctrl.signal
      }).then(function (resp) {
        clearTimeout(timer);
        return resp.text().then(function (text) {
          var body = null;
          try { body = text ? JSON.parse(text) : null; } catch (e) { /* 非 JSON */ }
          if (!resp.ok) {
            var nerr = normalizeError(null, resp.status);
            // 优先使用网关统一错误格式中的 message
            if (body && body.error && body.error.message) nerr.message = body.error.message;
            reject(nerr);
            return;
          }
          if (body === null || typeof body !== 'object') {
            reject({ status: resp.status, code: 'bad_response', message: '响应不是合法 JSON' });
            return;
          }
          resolve(body);
        });
      }).catch(function (err) {
        clearTimeout(timer);
        reject(normalizeError(err));
      });
    });
  }

  // ---- 业务接口 ----
  function summary(cfg, window_) { return get(cfg, '/v1/usage/summary', { window: window_ || 'today' }); }
  function daily(cfg, days) { return get(cfg, '/v1/usage/daily', { days: days }); }
  function hourly(cfg) { return get(cfg, '/v1/usage/hourly'); }
  function byModel(cfg, window_) { return get(cfg, '/v1/usage/by-model', { window: window_ }); }
  function byProvider(cfg, window_) { return get(cfg, '/v1/usage/by-provider', { window: window_ }); }
  function performance(cfg, hours, groupBy) {
    return get(cfg, '/v1/usage/performance', { hours: hours, group_by: groupBy || 'model' });
  }
  /** 模型目录：网关在 key-auth 后注入身份，函数回显 consumer，可用作连通性探测 */
  function models(cfg) { return get(cfg, '/v1/models'); }

  /**
   * 连接测试：调稳定的 /v1/models
   * 成功返回 { ok:true, consumer, models:[{id, credit, creditHistory}...], modelIds:[id...] }，失败返回 { ok:false, error }
   * credit 为当日生效计量系数；creditHistory 为版本历史 [{from, credit}] 按生效日升序
   * （函数旧版无 credit_history 时为空数组，面板回退"总量×当前系数"的平铺算法）
   */
  function testConnection(cfg) {
    return models(cfg).then(
      function (data) {
        var list = (data && data.data) || [];
        var models = list.map(function (m) {
          var hist = [];
          if (Array.isArray(m.credit_history)) {
            m.credit_history.forEach(function (e) {
              if (e && typeof e.from === 'string' && typeof e.credit === 'number') {
                hist.push({ from: e.from, credit: e.credit });
              }
            });
            hist.sort(function (a, b) { return a.from < b.from ? -1 : (a.from > b.from ? 1 : 0); });
          }
          return {
            id: m.id,
            credit: (typeof m.credit === 'number') ? m.credit : null,
            creditHistory: hist
          };
        });
        return {
          ok: true,
          consumer: (data && data.consumer) || '',
          models: models,
          modelIds: models.map(function (m) { return m.id; })
        };
      },
      function (err) { return { ok: false, error: err }; }
    );
  }

  window.BRU = window.BRU || {};
  window.BRU.api = {
    get: get,
    summary: summary,
    daily: daily,
    hourly: hourly,
    byModel: byModel,
    byProvider: byProvider,
    performance: performance,
    models: models,
    testConnection: testConnection,
    TIMEOUT_MS: TIMEOUT_MS
  };
})();
