/**
 * 视图切换、数据编排、手动刷新
 * 视图：#view-onboarding（引导）/ #view-panel（面板）
 * token 口径：req_tokens 含缓存命中（OpenAI 规范），展示拆分为
 *   输入（缓存未命中）= req_tokens - cached_tokens、输入（缓存命中）、输出
 * Credit 口径：逐日分段 —— 每日 Credit = 当日总 Tokens × 当日生效系数 ÷ 百万，
 *   系数版本历史来自 /v1/models 的 credit_history（[from, 下一条 from) 区间生效）；
 *   无 daily 明细（旧后端）或无历史（旧目录）时回退 总量 × 当前系数
 */
(function () {
  'use strict';

  var C = window.BRU.config;
  var F = window.BRU.format;
  var API = window.BRU.api;
  var CH = window.BRU.charts;

  // Promise.allSettled 兜底（ES2020 特性，老内核降级为等价实现）
  // 注意: 原生方法必须保持 this=Promise 调用，不能直接解构引用
  var allSettled = Promise.allSettled
    ? function (arr) { return Promise.allSettled(arr); }
    : function (arr) {
    return Promise.all(arr.map(function (p) {
      return p.then(
        function (v) { return { status: 'fulfilled', value: v }; },
        function (e) { return { status: 'rejected', reason: e }; }
      );
    }));
  };

  // 周期语义：今日/本周/本月均为日历对齐（后端按 UTC+8 切分）。
  // KPI 用 summary(window)（含环比 compare）；daily 供趋势图（本周=周一至今、本月=1日至今）；
  // performance 的 hours = 周期起点至今的小时数（向上取整）；今日额外拉 hourly 分时
  function periodParams(key) {
    var now = new Date();
    if (key === 'week') {
      var wd = (now.getDay() + 6) % 7;  // 周一=0 … 周日=6
      return { window: 'week', days: wd + 1, hours: wd * 24 + now.getHours() + 1 };
    }
    if (key === 'month') {
      var dom = now.getDate();
      return { window: 'month', days: dom, hours: (dom - 1) * 24 + now.getHours() + 1 };
    }
    return { window: 'today', days: null, hours: 24 };
  }

  // 后端 compare.window -> 展示文案
  var COMPARE_LABELS = { yesterday: '较昨日', prev_week: '较上周', prev_month: '较上月' };

  var state = {
    cfg: null,              // 生效配置
    consumer: '',           // 网关注入的消费者 ID（/v1/models 回显）
    modelCatalog: [],       // 网关可用模型列表 [{id, credit, creditHistory}]
    creditMap: {},          // 模型 id -> 当前生效 Credit 系数（null = 未提供，展示降级 --）
    creditHistMap: {},      // 模型 id -> [{from, credit}] 系数版本历史（按生效日升序）
    period: 'today',
    cooldownTimer: null,
    cooldownLeft: 0,
    consecutiveFails: 0,    // 连续失败次数
    inFlight: false,
    tableRows: [],          // 明细表当前数据
    tableSort: { key: 'total_tokens', dir: -1 },
    cache: { trend: null, hourly: null, model: null, provider: null } // 主题切换重建图表用
  };

  // ---------- DOM 工具 ----------
  function $(id) { return document.getElementById(id); }
  function show(el) { el.classList.remove('hidden'); }
  function hide(el) { el.classList.add('hidden'); }

  /** 卡片状态层：loading / empty / error / ready */
  function setCardState(cardEl, st, msg, retryFn) {
    var layer = cardEl.querySelector('.card-state');
    if (!layer) return;
    layer.className = 'card-state state-' + st;
    if (st === 'ready') { layer.innerHTML = ''; hide(layer); return; }
    show(layer);
    if (st === 'loading') {
      layer.innerHTML = '<div class="skeleton"></div><div class="skeleton sk-60"></div><div class="skeleton sk-40"></div>';
    } else if (st === 'empty') {
      layer.innerHTML = '<div class="state-text">该周期暂无调用记录</div>';
    } else if (st === 'error') {
      layer.innerHTML = '';
      var div = document.createElement('div');
      div.className = 'state-text state-error-text';
      div.textContent = msg || '加载失败';
      var btn = document.createElement('button');
      btn.className = 'btn btn-sm';
      btn.textContent = '重试';
      btn.addEventListener('click', retryFn || loadAll);
      layer.appendChild(div);
      layer.appendChild(btn);
    }
  }

  // ---------- 主题 ----------
  var mediaDark = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;

  function resolveTheme() {
    var t = (state.cfg && state.cfg.theme) || 'auto';
    if (t === 'auto') return (mediaDark && mediaDark.matches) ? 'dark' : 'light';
    return t;
  }

  function applyTheme(rebuild) {
    document.documentElement.setAttribute('data-theme', resolveTheme());
    // 同步主题切换按钮高亮
    var cur = (state.cfg && state.cfg.theme) || 'auto';
    ['light', 'dark', 'auto'].forEach(function (t) {
      var b = $('theme-' + t);
      if (b) b.classList.toggle('active', t === cur);
    });
    if (rebuild) {
      // 主题变化：销毁重建图表（ECharts 主题只能 init 时指定）
      CH.disposeAll();
      renderCachedCharts();
    }
  }

  if (mediaDark && mediaDark.addEventListener) {
    mediaDark.addEventListener('change', function () {
      if ((state.cfg && state.cfg.theme || 'auto') === 'auto') applyTheme(true);
    });
  }

  function setTheme(t) {
    state.cfg.theme = t;
    applyTheme(true);
  }

  // ---------- 视图切换 ----------
  function switchView(name) {
    if (name === 'panel') { hide($('view-onboarding')); show($('view-panel')); }
    else { hide($('view-panel')); show($('view-onboarding')); }
  }

  /** 401：整页退回引导视图并红字提示 */
  function backToOnboarding(msg) {
    switchView('onboarding');
    var err = $('onboard-error');
    err.textContent = msg;
    show(err);
  }

  // ---------- KPI 渲染 ----------
  /** 环比徽章：升红降绿（A 股风格），无基准时留空 */
  function setDelta(id, change, label) {
    var el = $(id);
    if (!change) { el.textContent = ''; el.className = 'kpi-delta'; return; }
    var arrow = change.dir > 0 ? '▲' : (change.dir < 0 ? '▼' : '—');
    el.textContent = arrow + ' ' + change.text + ' ' + label;
    el.className = 'kpi-delta ' + (change.dir > 0 ? 'delta-up' : (change.dir < 0 ? 'delta-down' : 'delta-flat'));
  }

  function renderKpis(kpi) {
    $('kpi-requests').textContent = F.fullNumber(kpi.requestCount);
    $('kpi-total-tokens').textContent = F.abbrev(kpi.totalTokens, state.cfg.numberStyle);
    $('kpi-uncached-tokens').textContent = F.abbrev(kpi.uncachedTokens, state.cfg.numberStyle);
    $('kpi-cached-tokens').textContent = F.abbrev(kpi.cachedTokens, state.cfg.numberStyle);
    $('kpi-rsp-tokens').textContent = F.abbrev(kpi.rspTokens, state.cfg.numberStyle);
    $('kpi-cache-rate').textContent = kpi.cacheRateText;
    $('kpi-ttft').textContent = F.latency(kpi.ttftMs);
    // 悬停显示完整值
    $('kpi-total-tokens').title = F.fullNumber(kpi.totalTokens);
    $('kpi-uncached-tokens').title = F.fullNumber(kpi.uncachedTokens);
    $('kpi-cached-tokens').title = F.fullNumber(kpi.cachedTokens);
    $('kpi-rsp-tokens').title = F.fullNumber(kpi.rspTokens);
    // 环比徽章（基准 = 上一等长周期）
    var cmp = kpi.compare, label = kpi.compareLabel;
    setDelta('kpi-requests-delta', cmp && F.pctChange(kpi.requestCount, cmp.request_count), label);
    setDelta('kpi-total-delta', cmp && F.pctChange(kpi.totalTokens, (cmp.req_tokens || 0) + (cmp.rsp_tokens || 0)), label);
    setDelta('kpi-uncached-delta', cmp && F.pctChange(kpi.uncachedTokens, Math.max(cmp.req_tokens - cmp.cached_tokens, 0)), label);
    setDelta('kpi-cached-delta', cmp && F.pctChange(kpi.cachedTokens, cmp.cached_tokens), label);
    setDelta('kpi-rsp-delta', cmp && F.pctChange(kpi.rspTokens, cmp.rsp_tokens), label);
    setDelta('kpi-cache-rate-delta',
      cmp && cmp.req_tokens > 0 && kpi.cacheHitRate !== null
        ? F.ppChange(kpi.cacheHitRate, cmp.cached_tokens / cmp.req_tokens) : null, label);
  }

  /** 某天 (YYYY-MM-DD) 生效的系数：版本历史最后一条 from <= 当天；无历史回退当前系数 */
  function creditOn(modelId, dateStr) {
    var hist = state.creditHistMap[modelId];
    if (hist && hist.length && dateStr) {
      var v = null;  // 日期早于首条历史（如 08-01 前）= 无生效系数，当天不计
      for (var i = 0; i < hist.length; i++) {
        if (hist[i].from <= dateStr) v = hist[i].credit; else break;
      }
      return v;
    }
    var cur = state.creditMap[modelId];
    return (cur === null || cur === undefined) ? null : cur;
  }

  /**
   * 单行 by-model 的 Credit 估算用量：
   * 有 daily 逐日明细 → Σ 当日总Tokens × 当日生效系数 ÷ 百万（跨系数变更正确分段）；
   * 无 daily（旧后端）→ 回退 窗口总量 × 当前系数 ÷ 百万；无系数返回 null（展示 --）
   */
  function modelCreditUsage(r) {
    var i, c, sum = 0, has = false;
    if (r.daily && r.daily.length) {
      for (i = 0; i < r.daily.length; i++) {
        c = creditOn(r.model, r.daily[i].date);
        if (c !== null) { has = true; sum += (r.daily[i].total_tokens || 0) * c / 1e6; }
      }
      return has ? sum : null;
    }
    c = creditOn(r.model, null);
    return c !== null ? (r.total_tokens || 0) * c / 1e6 : null;
  }

  /** Credit 估算用量卡：Σ 各模型逐日分段用量；目录未提供系数时降级 -- */
  function renderCreditKpi(list) {
    var sum = 0, has = false;
    (list || []).forEach(function (r) {
      var v = modelCreditUsage(r);
      if (v !== null) { has = true; sum += v; }
    });
    var el = $('kpi-credit');
    el.textContent = has ? F.credit(sum) : '--';
    el.title = has ? 'Σ 逐日（模型总Tokens × 当日生效 Credit 系数）÷ 1,000,000（估算）' : '模型目录未返回 Credit 系数';
  }

  var KPI_IDS = ['kpi-requests', 'kpi-total-tokens', 'kpi-uncached-tokens', 'kpi-cached-tokens', 'kpi-rsp-tokens', 'kpi-credit', 'kpi-cache-rate', 'kpi-ttft'];
  var KPI_DELTA_IDS = ['kpi-requests-delta', 'kpi-total-delta', 'kpi-uncached-delta', 'kpi-cached-delta', 'kpi-rsp-delta', 'kpi-cache-rate-delta'];

  function setKpiState(st, msg) {
    KPI_IDS.forEach(function (id) {
      var el = $(id);
      if (st === 'loading') { el.textContent = '…'; el.classList.add('kpi-loading'); }
      else if (st === 'error') { el.textContent = '--'; el.classList.remove('kpi-loading'); }
      else el.classList.remove('kpi-loading');
    });
    if (st !== 'ready') {
      KPI_DELTA_IDS.forEach(function (id) { $(id).textContent = ''; $(id).className = 'kpi-delta'; });
    }
  }

  // ---------- 数据编排 ----------
  /** 统一取数：summary(window) 供 KPI+环比；by-*(window)；performance；daily 供趋势；今日加 hourly 分时 */
  function fetchAll(cfg) {
    var p = periodParams(state.period);
    var jobs = [
      API.summary(cfg, p.window),
      API.byModel(cfg, p.window),
      API.byProvider(cfg, p.window),
      API.performance(cfg, p.hours, 'model'),
      API.daily(cfg, p.days || cfg.trendDays || 14)
    ];
    if (state.period === 'today') jobs.push(API.hourly(cfg));
    return allSettled(jobs).then(function (r) {
      return { summary: r[0], byModel: r[1], byProvider: r[2], perf: r[3], daily: r[4], hourly: r[5] || null };
    });
  }

  /** performance 数据中取第一个模型的 ttft_avg_ms 作为整体均值（接口已按窗口聚合） */
  function extractTtft(perfData) {
    if (!perfData || !perfData.data || !perfData.data.length) return null;
    // 样本数加权平均
    var sumW = 0, sum = 0;
    perfData.data.forEach(function (d) {
      var w = d.samples_min || 1;
      sum += (d.ttft_avg_ms || 0) * w;
      sumW += w;
    });
    return sumW ? sum / sumW : null;
  }

  function loadAll() {
    if (state.inFlight) return Promise.resolve();
    state.inFlight = true;
    var isToday = state.period === 'today';
    setKpiState('loading');
    setCardState($('card-trend'), 'loading');
    setCardState($('card-model'), 'loading');
    setCardState($('card-provider'), 'loading');
    setCardState($('card-table'), 'loading');
    var chartsGrid = document.querySelector('.charts-grid');
    if (isToday) { chartsGrid.classList.remove('no-hourly'); show($('card-hourly')); setCardState($('card-hourly'), 'loading'); }
    else { chartsGrid.classList.add('no-hourly'); hide($('card-hourly')); }

    return fetchAll(state.cfg).then(function (res) {
      state.inFlight = false;

      // 任一接口 401 → 整页退回引导
      var results = [res.summary, res.daily, res.byModel, res.byProvider, res.perf, res.hourly].filter(Boolean);
      var unauthorized = results.some(function (r) {
        return r.status === 'rejected' && r.reason && r.reason.code === 'unauthorized';
      });
      if (unauthorized) {
        backToOnboarding('API Key 无效或已过期，请重新输入');
        return;
      }

      var anyFail = false;

      // --- KPI（全周期统一走 summary，自带环比 compare） ---
      if (res.summary.status === 'fulfilled') {
        var v = res.summary.value;
        var d = v.data;
        var cached = d.cached_tokens || 0;
        renderKpis({
          requestCount: d.request_count,
          totalTokens: (d.req_tokens || 0) + (d.rsp_tokens || 0),
          uncachedTokens: Math.max((d.req_tokens || 0) - cached, 0),
          cachedTokens: cached,
          rspTokens: d.rsp_tokens,
          cacheHitRate: d.cache_hit_rate,
          cacheRateText: F.hitRate(d.cache_hit_rate),
          ttftMs: res.perf.status === 'fulfilled' ? extractTtft(res.perf.value) : null,
          compare: v.compare || null,
          compareLabel: COMPARE_LABELS[(v.compare || {}).window] || '环比'
        });
        setKpiState('ready');
        $('last-updated').textContent = '更新于 ' + F.timeOfDay(v.as_of);
      } else {
        anyFail = true;
        setKpiState('error', res.summary.reason && res.summary.reason.message);
      }

      // --- 每日趋势 ---
      handleTrend(res.daily);

      // --- 今日分时 ---
      if (isToday) handleHourly(res.hourly);

      // --- 模型分布 / 明细表（共用 by-model） ---
      if (res.byModel.status === 'fulfilled') {
        var list = res.byModel.value.data || [];
        state.cache.model = list;
        state.tableRows = list;
        renderModelChart(list);
        renderTable(list);
        renderCreditKpi(list);
      } else {
        anyFail = true;
        setCardState($('card-model'), 'error', res.byModel.reason && res.byModel.reason.message);
        setCardState($('card-table'), 'error', res.byModel.reason && res.byModel.reason.message);
      }

      // --- 供应商分布 ---
      if (res.byProvider.status === 'fulfilled') {
        var plist = res.byProvider.value.data || [];
        state.cache.provider = plist;
        renderProviderChart(plist);
      } else {
        anyFail = true;
        setCardState($('card-provider'), 'error', res.byProvider.reason && res.byProvider.reason.message);
      }

      // --- 失败 Header 提示 ---
      if (anyFail) {
        state.consecutiveFails++;
        showHeaderNotice('部分数据加载失败，将在下次刷新时重试', 'warn');
      } else {
        state.consecutiveFails = 0;
        hideHeaderNotice();
      }
    }).catch(function (err) {
      // 编排层异常兜底
      state.inFlight = false;
      state.consecutiveFails++;
      showHeaderNotice('刷新失败：' + ((err && err.message) || '未知错误'), 'warn');
    });
  }

  function handleTrend(dailyResult) {
    if (dailyResult.status === 'fulfilled') {
      var rows = dailyResult.value.data || [];
      state.cache.trend = rows;
      renderTrendChart(rows);
    } else {
      setCardState($('card-trend'), 'error', dailyResult.reason && dailyResult.reason.message);
    }
  }

  function handleHourly(hourlyResult) {
    if (hourlyResult && hourlyResult.status === 'fulfilled') {
      var rows = hourlyResult.value.data || [];
      state.cache.hourly = rows;
      renderHourlyChart(rows);
    } else {
      setCardState($('card-hourly'), 'error', hourlyResult && hourlyResult.reason && hourlyResult.reason.message);
    }
  }

  // ---------- 图表渲染 ----------
  function fmt() {
    return {
      abbrev: function (v) { return F.abbrev(v, state.cfg.numberStyle); },
      fullNumber: F.fullNumber, shortDate: F.shortDate, hourLabel: F.hourLabel, hitRate: F.hitRate
    };
  }

  function renderTrendChart(rows) {
    var card = $('card-trend');
    if (!rows.length) { setCardState(card, 'empty'); return; }
    setCardState(card, 'ready');
    var chart = CH.init('trend', $('chart-trend'));
    if (chart) chart.setOption(CH.trendOption(rows, fmt()));
  }

  function renderHourlyChart(rows) {
    var card = $('card-hourly');
    if (!rows.length) { setCardState(card, 'empty'); return; }
    setCardState(card, 'ready');
    var chart = CH.init('hourly', $('chart-hourly'));
    if (chart) chart.setOption(CH.hourlyOption(rows, fmt()));
  }

  function renderModelChart(list) {
    var card = $('card-model');
    if (!list.length) { setCardState(card, 'empty'); return; }
    setCardState(card, 'ready');
    var chart = CH.init('model', $('chart-model'));
    if (chart) chart.setOption(CH.modelBarOption(list, fmt()));
  }

  function renderProviderChart(list) {
    var card = $('card-provider');
    if (!list.length) { setCardState(card, 'empty'); return; }
    setCardState(card, 'ready');
    var chart = CH.init('provider', $('chart-provider'));
    if (chart) chart.setOption(CH.providerDonutOption(list, fmt()));
  }

  /** 主题切换后用缓存数据重建图表 */
  function renderCachedCharts() {
    if (state.cache.trend) renderTrendChart(state.cache.trend);
    if (state.cache.hourly && state.period === 'today') renderHourlyChart(state.cache.hourly);
    if (state.cache.model) renderModelChart(state.cache.model);
    if (state.cache.provider) renderProviderChart(state.cache.provider);
  }

  // ---------- 可用模型目录（/v1/models） ----------
  /** 落库模型目录并构建 Credit 映射（models: [{id, credit, creditHistory}]） */
  function setModelCatalog(models) {
    state.modelCatalog = models;
    var cur = {}, hist = {};
    models.forEach(function (m) {
      if (m && m.id) { cur[m.id] = m.credit; hist[m.id] = m.creditHistory || []; }
    });
    state.creditMap = cur;
    state.creditHistMap = hist;
  }

  /** 目录表系数单元格 tooltip：版本历史逐行 'YYYY-MM-DD 起 x.xx' */
  function creditHistoryTip(m) {
    var hist = m.creditHistory || [];
    if (!hist.length) return '';
    return 'Credit 系数生效历史：\n' + hist.map(function (e) {
      return e.from + ' 起 ' + Number(e.credit).toFixed(2);
    }).join('\n');
  }

  /** 目录表：三对"模型 | Credit 系数"列紧凑排布；系数缺失显示 --，悬停看版本历史 */
  function renderModelCatalog(models) {
    $('catalog-count').textContent = models.length ? '（' + models.length + ' 个）' : '';
    var tbody = $('catalog-tbody');
    tbody.innerHTML = '';
    if (!models.length) {
      var tr0 = document.createElement('tr');
      var c0 = td('暂无可用模型');
      c0.colSpan = 6;
      tr0.appendChild(c0);
      tbody.appendChild(tr0);
      return;
    }
    var PER_ROW = 3;
    for (var i = 0; i < models.length; i += PER_ROW) {
      var tr = document.createElement('tr');
      for (var j = 0; j < PER_ROW; j++) {
        var m = models[i + j];
        if (m) {
          tr.appendChild(td(m.id, 'mono'));
          var cell = td(m.credit === null || m.credit === undefined ? '--' : Number(m.credit).toFixed(2), 'num');
          var tip = creditHistoryTip(m);
          if (tip) cell.title = tip;
          tr.appendChild(cell);
        } else {
          tr.appendChild(td(''));
          tr.appendChild(td(''));
        }
      }
      tbody.appendChild(tr);
    }
  }

  // ---------- 明细表 ----------
  var SORT_KEYS = {
    model: function (r) { return r.model; },
    request_count: function (r) { return r.request_count; },
    input_uncached: function (r) { return r._uncached; },
    cached_tokens: function (r) { return r.cached_tokens; },
    rsp_tokens: function (r) { return r.rsp_tokens; },
    total_tokens: function (r) { return r.total_tokens; },
    cache_hit_rate: function (r) { return r._cacheRate; },
    credit: function (r) { return r._credit; },
    share: function (r) { return r.share; }
  };

  function renderTable(list) {
    var card = $('card-table');
    if (!list.length) { setCardState(card, 'empty'); renderTbody([]); return; }
    setCardState(card, 'ready');
    // by-model 已返回 cached_tokens：拆 输入(未命中) = req - cached，命中率逐模型可算；
    // Credit 按日分段：Σ 当日总Tokens × 当日生效系数 ÷ 1e6（无 daily/系数时降级，见 modelCreditUsage）
    var rows = list.map(function (r) {
      var c = Object.assign({}, r);
      var cached = r.cached_tokens || 0;
      c._uncached = Math.max((r.req_tokens || 0) - cached, 0);
      c._cacheRate = r.req_tokens > 0 ? cached / r.req_tokens : null;
      c._credit = modelCreditUsage(r);
      return c;
    });
    state.tableRows = rows;
    sortAndRender();
  }

  function sortAndRender() {
    var key = state.tableSort.key, dir = state.tableSort.dir;
    var getter = SORT_KEYS[key] || SORT_KEYS.total_tokens;
    var rows = state.tableRows.slice().sort(function (a, b) {
      var va = getter(a), vb = getter(b);
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === 'string') return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });
    renderTbody(rows);
    // 更新列头排序指示
    var ths = document.querySelectorAll('#model-table th[data-key]');
    Array.prototype.forEach.call(ths, function (th) {
      th.classList.remove('sort-asc', 'sort-desc');
      if (th.getAttribute('data-key') === key) {
        th.classList.add(dir === 1 ? 'sort-asc' : 'sort-desc');
      }
    });
  }

  function renderTbody(rows) {
    var tbody = $('model-tbody');
    tbody.innerHTML = '';
    rows.forEach(function (r) {
      var tr = document.createElement('tr');
      tr.appendChild(td(r.model));
      tr.appendChild(td(F.fullNumber(r.request_count), 'num'));
      tr.appendChild(td(F.fullNumber(r._uncached), 'num'));
      tr.appendChild(td(F.fullNumber(r.cached_tokens || 0), 'num'));
      tr.appendChild(td(F.fullNumber(r.rsp_tokens), 'num'));
      tr.appendChild(td(F.credit(r._credit), 'num'));
      tr.appendChild(td(r._cacheRate === null ? '--' : F.hitRate(r._cacheRate), 'num'));
      tr.appendChild(td(F.hitRate(r.share), 'num'));
      tbody.appendChild(tr);
    });
  }

  function td(text, cls) {
    var el = document.createElement('td');
    el.textContent = text;
    if (cls) el.className = cls;
    return el;
  }

  // ---------- CSV 导出 ----------
  function exportCsv() {
    if (!state.tableRows.length) return;
    var header = ['模型', '请求数', '输入 Tokens（缓存未命中）', '输入 Tokens（缓存命中）', '输出 Tokens', 'Credit 用量（估算）', '缓存命中率', '占比'];
    var key = state.tableSort.key, dir = state.tableSort.dir;
    var getter = SORT_KEYS[key] || SORT_KEYS.total_tokens;
    var rows = state.tableRows.slice().sort(function (a, b) {
      var va = getter(a), vb = getter(b);
      if (va === null || va === undefined) return 1;
      if (vb === null || vb === undefined) return -1;
      if (typeof va === 'string') return va.localeCompare(vb) * dir;
      return (va - vb) * dir;
    });
    var lines = [header.join(',')];
    rows.forEach(function (r) {
      lines.push([
        csvEscape(r.model),
        r.request_count,
        r._uncached,
        r.cached_tokens || 0,
        r.rsp_tokens,
        r._credit === null ? '--' : r._credit.toFixed(4),
        r._cacheRate === null ? '--' : F.hitRate(r._cacheRate),
        F.hitRate(r.share)
      ].join(','));
    });
    // UTF-8 BOM 保证 Excel 打开中文不乱码
    var blob = new Blob(['\ufeff' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'usage-models-' + state.period + '-' + F.todayStr() + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 1000);
  }

  function csvEscape(s) {
    s = String(s == null ? '' : s);
    if (/[",\n]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  // ---------- 手动刷新（10 秒冷却） ----------
  function manualRefresh() {
    if (state.cooldownLeft > 0) return;
    loadAll();
    state.cooldownLeft = 10;
    var btn = $('btn-refresh');
    btn.disabled = true;
    tickCooldown();
  }

  function tickCooldown() {
    var btn = $('btn-refresh');
    if (state.cooldownLeft <= 0) {
      btn.disabled = false;
      btn.textContent = '刷新';
      return;
    }
    btn.textContent = '刷新(' + state.cooldownLeft + 's)';
    state.cooldownLeft--;
    state.cooldownTimer = setTimeout(tickCooldown, 1000);
  }

  // ---------- Header 提示 ----------
  function showHeaderNotice(msg, kind) {
    var el = $('header-notice');
    el.textContent = msg;
    el.className = 'header-notice notice-' + (kind || 'info');
    show(el);
  }
  function hideHeaderNotice() { hide($('header-notice')); }

  // ---------- 连通徽标 ----------
  /**
   * 调稳定的 /v1/models 探测连通性：
   * 成功 → 绿勾 + 消费者 ID，并落版"可用模型"目录卡；失败 → 红叉 + 未连接
   */
  function refreshConnBadge() {
    var badge = $('header-conn'), label = $('header-consumer');
    if (!badge || !state.cfg) return;
    badge.className = 'conn-badge conn-pending';
    label.textContent = '连接中…';
    badge.title = '正在调用 /v1/models 检测网关连通性…';
    API.testConnection(state.cfg).then(function (r) {
      if (r.ok) {
        state.consumer = r.consumer;
        setModelCatalog(r.models);
        badge.className = 'conn-badge conn-ok';
        label.textContent = r.consumer || '已连接';
        badge.title = '已连接网关，鉴权通过\n消费者：' + (r.consumer || '-') +
          '\n可用模型 ' + r.models.length + ' 个：' + r.modelIds.join('、');
        renderModelCatalog(r.models);
      } else {
        badge.className = 'conn-badge conn-fail';
        label.textContent = '未连接';
        badge.title = '网关连通性检测失败：' + ((r.error && r.error.message) || '未知错误');
      }
    });
  }

  // ---------- 引导视图 ----------
  function initOnboarding() {
    var keyInput = $('onboard-key');
    $('onboard-toggle-key').addEventListener('click', function () {
      var isPwd = keyInput.type === 'password';
      keyInput.type = isPwd ? 'text' : 'password';
      this.textContent = isPwd ? '隐藏' : '显示';
    });

    $('onboard-test').addEventListener('click', function () {
      var btn = this;
      var err = $('onboard-error');
      hide(err);
      var cfg = Object.assign({}, C.DEFAULTS, {
        gatewayBaseUrl: $('onboard-url').value.trim(),
        apiKey: keyInput.value.trim()
      });
      var v = C.validate(cfg);
      if (!v.ok) { err.textContent = v.errors[0]; show(err); return; }

      btn.disabled = true;
      btn.textContent = '测试中…';
      API.testConnection(cfg).then(function (r) {
        btn.disabled = false;
        btn.textContent = '测试连接';
        if (r.ok) {
          state.cfg = cfg;
          state.consumer = r.consumer;
          setModelCatalog(r.models);
          // 询问是否记住到 localStorage
          if (confirm('连接成功！网关鉴权通过\n消费者：' + (r.consumer || '-') +
            '\n可用模型 ' + r.models.length + ' 个：' + r.modelIds.join('、') +
            '\n\n是否将配置保存到浏览器 localStorage？\n（下次打开免输入；选择"取消"则仅本次会话生效）')) {
            C.saveLocal(cfg);
          }
          enterPanel();
        } else {
          var e = r.error || {};
          if (e.code === 'unauthorized') {
            err.textContent = 'API Key 无效（401），请检查后重试';
          } else if (e.code === 'network' || e.code === 'timeout') {
            err.textContent = e.message + '。若通过 file:// 打开，请确认网关已放行 CORS（Access-Control-Allow-Origin: *）';
          } else {
            err.textContent = e.message || '连接失败';
          }
          show(err);
        }
      });
    });
  }

  function enterPanel() {
    switchView('panel');
    applyTheme(false);
    refreshConnBadge();
    loadAll();
  }

  // ---------- 设置抽屉 ----------
  function openDrawer() {
    var cfg = state.cfg || C.load();
    $('set-url').value = cfg.gatewayBaseUrl || '';
    $('set-key').value = cfg.apiKey || '';
    $('set-trenddays').value = cfg.trendDays || 14;
    $('set-theme').value = cfg.theme || 'auto';
    $('set-numstyle').value = cfg.numberStyle || 'wan';
    $('set-masked').textContent = cfg.apiKey ? '当前 Key：' + F.maskKey(cfg.apiKey) : '';
    hide($('set-message'));
    show($('drawer-mask'));
    show($('drawer'));
  }

  function closeDrawer() {
    hide($('drawer-mask'));
    hide($('drawer'));
  }

  function drawerCollect() {
    return {
      gatewayBaseUrl: $('set-url').value.trim(),
      apiKey: $('set-key').value.trim(),
      trendDays: Number($('set-trenddays').value),
      theme: $('set-theme').value,
      numberStyle: $('set-numstyle').value
    };
  }

  function drawerMessage(msg, ok) {
    var el = $('set-message');
    el.textContent = msg;
    el.className = 'drawer-message ' + (ok ? 'msg-ok' : 'msg-error');
    show(el);
  }

  function initDrawer() {
    $('btn-settings').addEventListener('click', openDrawer);
    $('drawer-close').addEventListener('click', closeDrawer);
    $('drawer-mask').addEventListener('click', closeDrawer);

    var keyInput = $('set-key');
    $('set-toggle-key').addEventListener('click', function () {
      var isPwd = keyInput.type === 'password';
      keyInput.type = isPwd ? 'text' : 'password';
      this.textContent = isPwd ? '隐藏' : '显示';
    });

    $('set-test').addEventListener('click', function () {
      var cfg = drawerCollect();
      var v = C.validate(cfg);
      if (!v.ok) { drawerMessage(v.errors[0]); return; }
      var btn = this;
      btn.disabled = true;
      btn.textContent = '测试中…';
      API.testConnection(cfg).then(function (r) {
        btn.disabled = false;
        btn.textContent = '测试连接';
        if (r.ok) {
          drawerMessage('连接成功 · 消费者 ' + (r.consumer || '-') +
            ' · 可用模型 ' + r.models.length + ' 个：' + r.modelIds.join('、'), true);
        } else {
          drawerMessage((r.error && r.error.message) || '连接失败');
        }
      });
    });

    $('set-save').addEventListener('click', function () {
      var cfg = drawerCollect();
      var v = C.validate(cfg);
      if (!v.ok) { drawerMessage(v.errors[0]); return; }
      C.saveLocal(cfg);
      state.cfg = cfg;
      applyTheme(true);
      refreshConnBadge();
      drawerMessage('已保存到浏览器 localStorage', true);
      setTimeout(function () { closeDrawer(); loadAll(); }, 600);
    });

    $('set-clear').addEventListener('click', function () {
      C.clearLocal();
      drawerMessage('已清除浏览器中保存的配置（config.js 仍生效）', true);
    });
  }
  // ---------- 启动 ----------
  function init() {
    // http:// 协议打开的黄色警告横幅（file:// 与 https:// 不提示）
    if (location.protocol === 'http:') show($('insecure-banner'));

    // 周期切换
    Array.prototype.forEach.call(document.querySelectorAll('#period-seg button'), function (btn) {
      btn.addEventListener('click', function () {
        var p = this.getAttribute('data-period');
        if (p === state.period) return;
        state.period = p;
        Array.prototype.forEach.call(document.querySelectorAll('#period-seg button'), function (b) {
          b.classList.toggle('active', b.getAttribute('data-period') === p);
        });
        loadAll();
      });
    });

    // 主题切换
    ['light', 'dark', 'auto'].forEach(function (t) {
      $('theme-' + t).addEventListener('click', function () { setTheme(t); });
    });

    $('btn-refresh').addEventListener('click', manualRefresh);
    $('btn-export').addEventListener('click', exportCsv);

    // 表格排序
    Array.prototype.forEach.call(document.querySelectorAll('#model-table th[data-key]'), function (th) {
      th.addEventListener('click', function () {
        var key = this.getAttribute('data-key');
        if (state.tableSort.key === key) state.tableSort.dir *= -1;
        else state.tableSort = { key: key, dir: key === 'model' ? 1 : -1 };
        sortAndRender();
      });
    });

    initOnboarding();
    initDrawer();
    applyTheme(false);

    // 配置加载与校验：localStorage > config.js
    var cfg = C.load();
    var v = C.validate(cfg);
    if (v.ok) {
      state.cfg = {
        gatewayBaseUrl: cfg.gatewayBaseUrl.trim().replace(/\/+$/, ''),
        apiKey: cfg.apiKey.trim(),
        trendDays: cfg.trendDays !== undefined ? Number(cfg.trendDays) : 14,
        theme: cfg.theme || 'auto',
        numberStyle: cfg.numberStyle || 'wan'
      };
      enterPanel();
    } else {
      // 预填已有值，展示首个错误原因
      $('onboard-url').value = cfg.gatewayBaseUrl || '';
      $('onboard-key').value = cfg.apiKey || '';
      if (cfg.gatewayBaseUrl || cfg.apiKey) {
        var err = $('onboard-error');
        err.textContent = '配置校验未通过：' + v.errors[0];
        show(err);
      }
      switchView('onboarding');
    }
  }

  // ECharts 未加载成功时进入面板会报错，这里兜底提示
  if (!window.echarts) {
    window.addEventListener('load', function () {
      if (!window.echarts) {
        var err = $('onboard-error');
        if (err) { err.textContent = 'ECharts 加载失败（CDN 不可达），图表将无法显示'; }
      }
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
