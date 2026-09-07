/**
 * ECharts 封装：初始化、深浅主题、resize、销毁重建
 * 深色用 ECharts 内置 dark 主题；主题切换时 dispose 后重新 init
 */
(function () {
  'use strict';

  var instances = {}; // name -> echarts instance

  function isDark() {
    return document.documentElement.getAttribute('data-theme') === 'dark';
  }

  /** 初始化（已存在则先销毁）。返回实例或 null（DOM 不存在时） */
  function init(name, el) {
    if (!el) return null;
    dispose(name);
    var chart = window.echarts.init(el, isDark() ? 'dark' : null, { renderer: 'canvas' });
    instances[name] = chart;
    return chart;
  }

  function dispose(name) {
    if (instances[name]) {
      instances[name].dispose();
      delete instances[name];
    }
  }

  /** 销毁全部图表（主题切换时调用） */
  function disposeAll() {
    Object.keys(instances).forEach(dispose);
  }

  function resizeAll() {
    Object.keys(instances).forEach(function (k) { instances[k].resize(); });
  }

  // 窗口尺寸变化时统一 resize（防抖）
  var resizeTimer = null;
  window.addEventListener('resize', function () {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(resizeAll, 150);
  });

  // ---- 公共配色（两套主题下都清晰可读）----
  var COLOR_UNCACHED = '#4c9aff';  // 输入·缓存未命中
  var COLOR_CACHED = '#9254de';    // 输入·缓存命中
  var COLOR_RSP = '#36cfc9';       // 输出 tokens
  var COLOR_LINE = '#f7b500';      // 请求数折线
  var PALETTE = ['#4c9aff', '#36cfc9', '#f7b500', '#ff7a45', '#9254de', '#73d13d', '#ff85c0', '#40a9ff'];

  function baseTooltip() {
    return {
      trigger: 'axis',
      backgroundColor: isDark() ? '#2b2f36' : '#fff',
      borderColor: isDark() ? '#444' : '#ddd',
      textStyle: { color: isDark() ? '#e8e8e8' : '#333', fontSize: 12 }
    };
  }

  /**
   * token 三类堆叠柱 + 请求数折线（副轴）的通用 option
   * items: [{ label, tipTitle, uncached, cached, rsp, cnt, complete }]
   * 未完结桶（complete=false）柱子降透明度
   */
  function stackOption(items, fmt) {
    var labels = [], uncached = [], cached = [], rsp = [], cnt = [];
    items.forEach(function (it) {
      labels.push(it.label);
      var barStyle = it.complete === false ? { opacity: 0.45 } : undefined;
      uncached.push({ value: it.uncached, itemStyle: barStyle });
      cached.push({ value: it.cached, itemStyle: barStyle });
      rsp.push({ value: it.rsp, itemStyle: barStyle });
      cnt.push(it.cnt);
    });
    return {
      color: [COLOR_UNCACHED, COLOR_CACHED, COLOR_RSP, COLOR_LINE],
      tooltip: Object.assign(baseTooltip(), {
        formatter: function (params) {
          var idx = params[0].dataIndex;
          var it = items[idx];
          var html = it.tipTitle + (it.complete === false ? '（进行中）' : '') + '<br/>';
          params.forEach(function (p) {
            html += p.marker + p.seriesName + '：' + fmt.fullNumber(p.value) + '<br/>';
          });
          var totalIn = it.uncached + it.cached;
          html += '输入合计：' + fmt.fullNumber(totalIn)
            + '（缓存命中 ' + fmt.hitRate(totalIn > 0 ? it.cached / totalIn : null) + '）';
          return html;
        }
      }),
      legend: { data: ['输入（缓存未命中）', '输入（缓存命中）', '输出 Tokens', '请求数'], top: 0 },
      grid: { left: 60, right: 56, top: 36, bottom: 28 },
      xAxis: { type: 'category', data: labels, axisTick: { alignWithLabel: true } },
      yAxis: [
        { type: 'value', name: 'Tokens', axisLabel: { formatter: function (v) { return fmt.abbrev(v); } } },
        { type: 'value', name: '请求数', splitLine: { show: false }, axisLabel: { formatter: function (v) { return fmt.abbrev(v); } } }
      ],
      series: [
        { name: '输入（缓存未命中）', type: 'bar', stack: 'tokens', data: uncached, barMaxWidth: 32 },
        { name: '输入（缓存命中）', type: 'bar', stack: 'tokens', data: cached, barMaxWidth: 32 },
        { name: '输出 Tokens', type: 'bar', stack: 'tokens', data: rsp, barMaxWidth: 32 },
        { name: '请求数', type: 'line', yAxisIndex: 1, data: cnt, smooth: true, symbolSize: 6, lineStyle: { width: 2 } }
      ]
    };
  }

  /**
   * 每日用量趋势：输入拆分为 缓存未命中/缓存命中（OpenAI 规范 req 含命中），
   * 与输出三类堆叠 + 请求数折线
   */
  function trendOption(rows, fmt) {
    var items = rows.map(function (r) {
      var cached = r.cached_tokens || 0;
      return {
        label: fmt.shortDate(r.date),
        tipTitle: r.date,
        uncached: Math.max((r.req_tokens || 0) - cached, 0),
        cached: cached,
        rsp: r.rsp_tokens || 0,
        cnt: r.request_count || 0,
        complete: r.complete
      };
    });
    return stackOption(items, fmt);
  }

  /** 今日分时：整点小时桶，当前未完结小时降透明度 */
  function hourlyOption(rows, fmt) {
    var items = rows.map(function (r) {
      var cached = r.cached_tokens || 0;
      return {
        label: fmt.hourLabel(r.ts),
        tipTitle: fmt.hourLabel(r.ts) + ' - ' + fmt.hourLabel(r.ts + 3600),
        uncached: Math.max((r.req_tokens || 0) - cached, 0),
        cached: cached,
        rsp: r.rsp_tokens || 0,
        cnt: r.request_count || 0,
        complete: r.complete
      };
    });
    return stackOption(items, fmt);
  }

  /** 模型分布：横向条形图，Top 10，其余合并"其他"；按 total_tokens 降序 */
  function modelBarOption(list, fmt) {
    var sorted = list.slice().sort(function (a, b) { return b.total_tokens - a.total_tokens; });
    var top = sorted.slice(0, 10);
    var rest = sorted.slice(10);
    if (rest.length) {
      top.push({
        model: '其他（' + rest.length + ' 个模型）',
        total_tokens: rest.reduce(function (s, r) { return s + r.total_tokens; }, 0),
        req_tokens: rest.reduce(function (s, r) { return s + (r.req_tokens || 0); }, 0),
        rsp_tokens: rest.reduce(function (s, r) { return s + (r.rsp_tokens || 0); }, 0),
        cached_tokens: rest.reduce(function (s, r) { return s + (r.cached_tokens || 0); }, 0),
        request_count: rest.reduce(function (s, r) { return s + r.request_count; }, 0)
      });
    }
    var names = top.map(function (r) { return r.model; }).reverse();
    var values = top.map(function (r) { return r.total_tokens; }).reverse();
    return {
      color: [COLOR_UNCACHED],
      tooltip: {
        trigger: 'item',
        backgroundColor: isDark() ? '#2b2f36' : '#fff',
        borderColor: isDark() ? '#444' : '#ddd',
        textStyle: { color: isDark() ? '#e8e8e8' : '#333', fontSize: 12 },
        formatter: function (p) {
          var d = top[top.length - 1 - p.dataIndex];
          var cached = d.cached_tokens || 0;
          return p.name
            + '<br/>输入（缓存未命中）：' + fmt.fullNumber(Math.max((d.req_tokens || 0) - cached, 0))
            + '<br/>输入（缓存命中）：' + fmt.fullNumber(cached)
            + '<br/>输出：' + fmt.fullNumber(d.rsp_tokens || 0)
            + '<br/>请求数：' + fmt.fullNumber(d.request_count || 0);
        }
      },
      grid: { left: 8, right: 60, top: 8, bottom: 8, containLabel: true },
      xAxis: { type: 'value', axisLabel: { formatter: function (v) { return fmt.abbrev(v); } } },
      yAxis: { type: 'category', data: names, axisLabel: { width: 130, overflow: 'truncate' } },
      series: [{
        type: 'bar', data: values, barMaxWidth: 18,
        label: { show: true, position: 'right', formatter: function (p) { return fmt.abbrev(p.value); } },
        itemStyle: { borderRadius: [0, 4, 4, 0] }
      }]
    };
  }

  /** 供应商分布：环形图，中心显示总请求数 */
  function providerDonutOption(list, fmt) {
    var totalReq = list.reduce(function (s, r) { return s + (r.request_count || 0); }, 0);
    var data = list.map(function (r) {
      return { name: r.provider, value: r.total_tokens, requestCount: r.request_count, share: r.share };
    });
    return {
      color: PALETTE,
      tooltip: {
        trigger: 'item',
        backgroundColor: isDark() ? '#2b2f36' : '#fff',
        borderColor: isDark() ? '#444' : '#ddd',
        textStyle: { color: isDark() ? '#e8e8e8' : '#333', fontSize: 12 },
        formatter: function (p) {
          var d = p.data;
          return d.name + '<br/>Tokens：' + fmt.fullNumber(d.value)
            + '<br/>请求数：' + fmt.fullNumber(d.requestCount)
            + '<br/>占比：' + fmt.hitRate(d.share);
        }
      },
      legend: { bottom: 0, type: 'scroll' },
      title: {
        text: fmt.fullNumber(totalReq),
        subtext: '总请求数',
        left: 'center', top: '38%',
        textStyle: { fontSize: 20, fontWeight: 600, color: isDark() ? '#e8e8e8' : '#222' },
        subtextStyle: { fontSize: 12, color: isDark() ? '#999' : '#888' }
      },
      series: [{
        type: 'pie', radius: ['52%', '72%'], center: ['50%', '46%'],
        avoidLabelOverlap: true,
        label: { show: false },
        emphasis: { label: { show: true, formatter: '{b}\n{d}%', fontSize: 13 } },
        data: data
      }]
    };
  }

  window.BRU = window.BRU || {};
  window.BRU.charts = {
    init: init,
    dispose: dispose,
    disposeAll: disposeAll,
    resizeAll: resizeAll,
    trendOption: trendOption,
    hourlyOption: hourlyOption,
    modelBarOption: modelBarOption,
    providerDonutOption: providerDonutOption,
    isDark: isDark
  };
})();
