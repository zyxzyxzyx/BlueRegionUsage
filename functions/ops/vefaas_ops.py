"""
VeFaaS Web 应用函数: BlueRegion Usage 个人用量查询 API (/v1/usage/*)

链路与鉴权 (2026-09-05 经 /v1/echo 实测确认):
  用户请求 → APIG(key-auth 校验, 注入 X-Forward-Consumer 身份头) → 本函数 → VMP
  - 无 Key / 错 Key: 网关直接 401, 请求不到达函数;
  - X-Forward-Consumer 由网关注入, 客户端伪造的同名头会被覆盖为真实身份, 可信任;
  - Authorization 透传到函数, 但网关上 Key 是 UUID 形式, 不等于 consumer 名, 不能用作身份;
    (仅本地开发可用 "Authorization: Bearer api-key-xxxxxx" 直连函数模拟身份)
  - 函数到 VMP 走平台服务间授权 (平台自动注入 X-Faas-* 临时凭证), 无需配置固定 AK/SK。
  函数只读取 X-Forward-Consumer 作为 PromQL 的 consumer 过滤值, 用户天然只能查到自己的数据。

VMP 指标口径 (指标由网关访问日志经日志服务 TLS 定时 SQL 每分钟聚合写入):
  - 6 个 Gauge: req_tokens / rsp_tokens / req_cached_tokens / request_count / ttft_avg_ms / tpot_avg_ms,
    每点是该分钟窗口的聚合增量, 带 consumer / provider / model 三个 label;
  - 总量查询必须用 sum_over_time(), 不能用 increase()/rate();
  - 天级聚合必须用 instant query (/api/v1/query) + sum_over_time(metric[1d]) + time 参数,
    不要用 query_range + step=1d (VMP 大 step 降采样会丢数据);
  - provider label 直接是中文名 (火山/智谱/百炼/稀宇/腾讯/百度), 无需函数侧映射;
  - ttft_avg_ms 是每分钟均值, 窗口聚合为按分钟等权平均 (avg_over_time),
    按请求加权需 VMP recording rule (二期); tpot_avg_ms 当前全 0 (WASM 未记录)。

响应形状与面板 (panel/) 契约对齐:
  summary     {object:"usage_summary", date, timezone, consumer,
               data:{req_tokens,rsp_tokens,total_tokens,cached_tokens,cache_hit_rate,request_count},
               compare:{window:"yesterday"|"prev_week"|"prev_month", req_tokens,rsp_tokens,cached_tokens,request_count},
               as_of, data_freshness_sec}
  daily       {object:"list", timezone, retention_days,
               data:[{date,req_tokens,rsp_tokens,cached_tokens,cache_hit_rate,request_count,complete}]}
  hourly      {object:"list", hours, timezone,
               data:[{ts,req_tokens,rsp_tokens,cached_tokens,request_count,complete}]}
               (整点桶, 默认今日 00:00(UTC+8)->当前小时逐桶补零; hours=N 为近 N 小时滚动)
  by-model    {object:"list", window, data:[{model,req_tokens,rsp_tokens,cached_tokens,total_tokens,request_count,share,
               daily:[{date,req_tokens,rsp_tokens,total_tokens}]}]}
               (daily = 窗口内逐日明细, 供面板按日生效的 Credit 系数分段计量)
  by-provider {object:"list", window, data:[{provider,req_tokens,rsp_tokens,cached_tokens,total_tokens,request_count,share}]}
  performance {object:"list", hours, data:[{model,ttft_avg_ms,samples_min}]}
  token 口径: req_tokens 为输入总量 (OpenAI 规范, 含缓存命中), 面板拆分为
              输入(缓存未命中) = req_tokens - cached_tokens, 输入(缓存命中) = cached_tokens,
              输出 = rsp_tokens, 三者分别计量;
  mock 模式下各响应额外带 "mock": true, 便于确认连的是哪个环境。

环境变量:
  VEFAAS_PORT           监听端口 (默认 8000)
  OPS_CONSUMER_HEADER   网关注入消费者 ID 的头名 (默认 X-Forward-Consumer, 回退 Authorization)
  VMP_QUERY_URL         VMP 查询地址, 形如 https://<query-host>/workspaces/<id> (非 mock 必填;
                        内部地址严禁提交入库, 只配在函数侧环境变量)
  VMP_BASIC_AUTH_USER   VMP Basic Auth 用户名 (可选, 仅本地开发回退用;
                        生产无需配置: 函数绑定 IAM 角色 (需 VMPQueryAccess 权限)
                        后平台自动注入 X-Faas-Access-Key-Id / -Secret-Access-Key /
                        -Session-Token 临时凭证, 函数以 V4 签名 (service=vmp) 访问 VMP)
  VMP_BASIC_AUTH_PASS   VMP Basic Auth 密码 (可选, 同上)
  VEFAAS_OPS_CACHE_TTL  查询结果缓存秒数 (默认 60, 0 关闭)
  OPS_CORS_ORIGIN       CORS 允许来源 (默认 *)
  VEFAAS_OPS_MOCK       设为 1 启用内置模拟数据, 便于无 VMP 环境本地开发
                        (mock 模式额外提供 GET /v1/models 模拟 models 函数, 含 credit_history)

接口:
  GET /v1/usage/summary?window=today|week|month      (period 参数同义, 默认 today; 均为 UTC+8 日历对齐)
  GET /v1/usage/daily?days=1..31                     (默认 7)
  GET /v1/usage/hourly[?hours=1..72]                 (默认今日 00:00 -> 当前小时整点桶)
  GET /v1/usage/by-model?window=today|week|month     (默认 today; data 每行含 daily 逐日明细)
  GET /v1/usage/by-provider?window=today|week|month  (默认 today)
  GET /v1/usage/performance?hours=1..744&group_by=model|provider (默认 24/model)
"""

import hashlib
import hmac
import json
import os
import re
import threading
import time
import urllib.error
import urllib.parse
import urllib.request
from base64 import b64encode
from calendar import monthrange
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone
from http.server import BaseHTTPRequestHandler, HTTPServer

TZ = timezone(timedelta(hours=8))  # 所有"日"均按 UTC+8 切分
TZ_NAME = "Asia/Shanghai"

CONSUMER_PATTERN = re.compile(r"^api-key-[A-Za-z0-9]{6,32}$")  # 实测含大写 (如 zWX 段)
# 网关注入身份头候选。注意: 只放"由网关注入且客户端伪造会被覆盖"的头,
# 普通自定义头(如 X-Consumer-Id)在火山 APIG 上会被原样透传, 不可信, 勿加入。
# 火山 APIG 实测 (2026-09-05): X-Forward-Consumer 由 key-auth 插件注入, 伪造值会被覆盖。
CONSUMER_HEADER_CANDIDATES = [
    "X-Forward-Consumer",
]

VMP_TIMEOUT_SEC = 6
STALE_TOLERANCE_SEC = 300  # VMP 故障时容忍返回最长 5 分钟前的缓存
RETENTION_DAYS = 31  # daily 端点最多返回天数 (月视图最多 31 天; VMP 实际保留不足时早期天为 0)
WINDOW_CHOICES = ("today", "week", "month")
MAX_PERFORMANCE_HOURS = 744  # 月视图 TTFT 窗口最长 31*24
DAILY_QUERY_WORKERS = 8  # daily 端点按 (天 × 指标) 并发查 VMP

VMP_QUERY_URL = os.environ.get("VMP_QUERY_URL", "").rstrip("/")
BASIC_USER = os.environ.get("VMP_BASIC_AUTH_USER", "")
BASIC_PASS = os.environ.get("VMP_BASIC_AUTH_PASS", "")
CACHE_TTL = int(os.environ.get("VEFAAS_OPS_CACHE_TTL", "60"))
CORS_ORIGIN = os.environ.get("OPS_CORS_ORIGIN", "*")
MOCK_MODE = os.environ.get("VEFAAS_OPS_MOCK", "") == "1"

# 响应字段名 -> VMP Gauge 指标名 (白名单; 口径见模块 docstring)
METRICS = [
    ("req_tokens", "req_tokens"),
    ("rsp_tokens", "rsp_tokens"),
    ("cached_tokens", "req_cached_tokens"),
    ("request_count", "request_count"),
]
TTFT_METRIC = "ttft_avg_ms"


class ApiError(Exception):
    def __init__(self, status, message, code, err_type="invalid_request_error"):
        super().__init__(message)
        self.status = status
        self.message = message
        self.code = code
        self.err_type = err_type


# ---------------------------------------------------------------- 工具函数


def now_ts():
    return int(time.time())


def esc(value):
    """PromQL label 值转义 (consumer 已过正则白名单, 此为双保险)"""
    return value.replace("\\", "\\\\").replace('"', '\\"')


def today_start_ts(ts=None):
    """UTC+8 当日零点 (epoch 秒)"""
    d = datetime.fromtimestamp(ts or now_ts(), tz=TZ)
    return int(datetime(d.year, d.month, d.day, tzinfo=TZ).timestamp())


def fmt_date(ts):
    return datetime.fromtimestamp(ts, TZ).strftime("%Y-%m-%d")


def _span_since(start_ts):
    """start_ts -> 当前时刻的动态 PromQL duration, 格式如 2d17h30m; 下限 1m"""
    minutes = max((now_ts() - start_ts) // 60, 1)
    d, rem = divmod(minutes, 1440)
    h, m = divmod(rem, 60)
    out = ""
    if d:
        out += f"{d}d"
    if h:
        out += f"{h}h"
    if m or not out:
        out += f"{m}m"
    return out


def today_span():
    """当日动态窗口: 当日 0 点 -> 当前时刻, 格式如 9h30m; 0 点刚过时下限 1m"""
    return _span_since(today_start_ts())


def week_start_ts(ts=None):
    """UTC+8 本周一零点 (epoch 秒)"""
    d0 = today_start_ts(ts)
    return d0 - datetime.fromtimestamp(d0, tz=TZ).weekday() * 86400


def month_start_ts(ts=None):
    """UTC+8 本月 1 日零点 (epoch 秒)"""
    d = datetime.fromtimestamp(ts or now_ts(), tz=TZ)
    return int(datetime(d.year, d.month, 1, tzinfo=TZ).timestamp())


def window_span(window):
    """窗口 -> PromQL duration。today/week/month 均为 UTC+8 日历对齐动态窗口"""
    if window == "today":
        return today_span()
    if window == "week":
        return _span_since(week_start_ts())
    if window == "month":
        return _span_since(month_start_ts())
    raise ApiError(400, "window 必须是: today, week, month", "invalid_window")


def window_day_starts(window):
    """窗口覆盖的本地日零点序列 (升序, 含当日): today=当日; week=周一至今; month=1日至今"""
    today0 = today_start_ts()
    if window == "today":
        start0 = today0
    elif window == "week":
        start0 = week_start_ts()
    elif window == "month":
        start0 = month_start_ts()
    else:
        raise ApiError(400, "window 必须是: today, week, month", "invalid_window")
    days = []
    d = start0
    while d <= today0:
        days.append(d)
        d += 86400
    return days


def get_window(params, default="today"):
    """window / period 参数同义"""
    raw = params.get("window", params.get("period", [default]))
    value = (raw[0] or default).strip()
    return value or default


def parse_int(params, name, default, low, high):
    raw = params.get(name, [str(default)])[0]
    try:
        value = int(raw)
    except (ValueError, TypeError):
        raise ApiError(400, f"{name} 必须是整数", f"invalid_{name}")
    if not low <= value <= high:
        raise ApiError(400, f"{name} 必须在 {low}..{high} 之间", f"invalid_{name}")
    return value


def mask_consumer(consumer):
    """日志脱敏: api-key-abcd1234 -> api-k...d1234"""
    if len(consumer) <= 10:
        return "***"
    return f"{consumer[:5]}...{consumer[-5:]}"


# ---------------------------------------------------------------- 身份解析


def normalize_consumer(raw):
    """剥离 Bearer 前缀/空白/尾逗号并校验格式, 不合法返回 None"""
    if not raw:
        return None
    candidate = raw.strip().split(",")[0].strip()
    if candidate.lower().startswith("bearer "):
        candidate = candidate[7:].strip()
    return candidate if CONSUMER_PATTERN.match(candidate) else None


def resolve_consumer(handler):
    """身份解析, fail-closed: 取不到合法身份返回 None (调用方回 401)"""
    forced = os.environ.get("OPS_CONSUMER_HEADER", "").strip()
    if forced:
        cid = normalize_consumer(handler.headers.get(forced))
        if cid:
            return cid
        # 显式指定了头但取不到, 不再回退, 防止配置错误时静默降级
        return None

    for header in CONSUMER_HEADER_CANDIDATES:
        cid = normalize_consumer(handler.headers.get(header))
        if cid:
            return cid

    # 本地开发回退: 直连函数时用 Bearer api-key-xxx 模拟身份。
    # 网关上该头是 UUID 形式的 Key, 过不了 CONSUMER_PATTERN, 不会误认。
    auth = handler.headers.get("Authorization", "")
    if auth:
        return normalize_consumer(auth)
    return None


# ---------------------------------------------------------------- VMP 客户端


def sts_credentials_from_headers(handler):
    """平台按 IAM 角色注入的 STS 临时凭证 (Web 应用注入请求头, 见火山引擎文档:
    函数服务通过调用 IAM 角色访问其它云服务)。返回 {'ak','sk','token'} 或 None。
    凭证只用于 V4 签名访问 VMP, 禁止写入日志/响应。"""
    ak = handler.headers.get("X-Faas-Access-Key-Id", "").strip()
    sk = handler.headers.get("X-Faas-Secret-Access-Key", "").strip()
    token = handler.headers.get("X-Faas-Session-Token", "").strip()
    if not (ak and sk):
        return None
    return {"ak": ak, "sk": sk, "token": token}


def _v4_quote(value):
    return urllib.parse.quote(str(value), safe="")


def _vmp_region():
    m = re.search(r"prometheus-([a-z0-9-]+)\.", VMP_QUERY_URL)
    return m.group(1) if m else "cn-beijing"


def _sign_v4_get(full_path, params, creds):
    """火山引擎 V4 (HMAC-SHA256) 签名 GET 请求, 返回 (url, headers)。
    VMP 查询端点的 AK/SK 鉴权方式 (service=vmp), 官方支持临时凭证:
    sessionToken 放 X-Security-Token 头并参与签名。永久凭证走同一路径 (无 token)。"""
    parts = urllib.parse.urlsplit(VMP_QUERY_URL)
    host = parts.netloc
    region = _vmp_region()
    now = time.gmtime()
    x_date = time.strftime("%Y%m%dT%H%M%SZ", now)
    scope = f"{x_date[:8]}/{region}/vmp/request"
    # canonical query: RFC3986 编码 + ASCII 排序, 与实际发送字节完全一致
    qs = "&".join(f"{_v4_quote(k)}={_v4_quote(v)}" for k, v in sorted(params.items()))
    headers = {"host": host, "x-date": x_date}
    if creds["token"]:
        headers["x-security-token"] = creds["token"]
    signed_headers = ";".join(sorted(headers))
    canonical_headers = "".join(f"{k}:{headers[k]}\n" for k in sorted(headers))
    canonical_request = "\n".join([
        "GET", full_path, qs, canonical_headers, signed_headers,
        hashlib.sha256(b"").hexdigest(),
    ])
    string_to_sign = "\n".join([
        "HMAC-SHA256", x_date, scope,
        hashlib.sha256(canonical_request.encode()).hexdigest(),
    ])

    def _hmac(key, msg):
        return hmac.new(key, msg.encode(), hashlib.sha256).digest()

    k_signing = _hmac(_hmac(_hmac(_hmac(creds["sk"].encode(), x_date[:8]), region), "vmp"), "request")
    signature = hmac.new(k_signing, string_to_sign.encode(), hashlib.sha256).hexdigest()
    out = {
        "X-Date": x_date,
        "Authorization": (
            f"HMAC-SHA256 Credential={creds['ak']}/{scope}, "
            f"SignedHeaders={signed_headers}, Signature={signature}"
        ),
    }
    if creds["token"]:
        out["X-Security-Token"] = creds["token"]
    return f"{parts.scheme}://{host}{full_path}?{qs}", out


def _vmp_get(path, params, auth=None):
    """调用 VMP, 返回 data.result; 失败抛 ApiError。网络错误/5xx/429 重试一次
    auth: sts_credentials_from_headers() 的凭证 → V4 签名 (生产路径);
    缺省回退环境变量 BASIC 永久凭证 (本地开发用)"""
    if not VMP_QUERY_URL:
        raise ApiError(502, "VMP_QUERY_URL 未配置", "vmp_unavailable", "upstream_error")
    if auth:
        url, vmp_headers = _sign_v4_get(urllib.parse.urlsplit(VMP_QUERY_URL).path.rstrip("/") + path, params, auth)
    else:
        url = VMP_QUERY_URL + path + "?" + urllib.parse.urlencode(params)
        vmp_headers = {}
        if BASIC_USER or BASIC_PASS:
            token = b64encode(f"{BASIC_USER}:{BASIC_PASS}".encode()).decode()
            vmp_headers["Authorization"] = f"Basic {token}"
    vmp_headers["User-Agent"] = "blueregion-usage/1.1"
    req = urllib.request.Request(url, headers=vmp_headers)
    last_err = None
    for _ in range(2):
        try:
            with urllib.request.urlopen(req, timeout=VMP_TIMEOUT_SEC) as resp:
                body = json.loads(resp.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code == 429 or e.code >= 500:
                last_err = ApiError(502, f"vmp http {e.code}", "vmp_unavailable", "upstream_error")
                time.sleep(0.3)
                continue
            raise ApiError(502, f"vmp http {e.code}", "vmp_unavailable", "upstream_error")
        except (urllib.error.URLError, TimeoutError, OSError, json.JSONDecodeError) as e:
            last_err = ApiError(502, f"vmp 请求失败: {e}", "vmp_unavailable", "upstream_error")
            time.sleep(0.3)
            continue
        if body.get("status") != "success":
            raise ApiError(
                502, f"vmp error: {body.get('error', 'unknown')}", "vmp_unavailable", "upstream_error"
            )
        return body.get("data", {}).get("result", [])
    raise last_err


def vmp_instant(promql, ts=None, auth=None):
    """instant query; ts 为空时由 VMP 取当前时刻"""
    params = {"query": promql}
    if ts:
        params["time"] = str(ts)
    return _vmp_get("/api/v1/query", params, auth)


def vmp_query_range(promql, start, end, step, auth=None):
    """range query。仅配合 sum_over_time 子查询使用: 每个 step 独立聚合完整子窗口,
    不依赖原始采样点密度, 不存在大 step 降采样丢数据问题"""
    params = {"query": promql, "start": str(start), "end": str(end), "step": str(step)}
    return _vmp_get("/api/v1/query_range", params, auth)


def _vector_value(result):
    return sum(float(r["value"][1]) for r in result)


def _vector_by(result, label):
    out = {}
    for r in result:
        key = r.get("metric", {}).get(label, "unknown")
        out[key] = out.get(key, 0.0) + float(r["value"][1])
    return out


# ---------------------------------------------------------------- PromQL 查询编排


def vmp_totals(consumer, window, auth=None):
    """窗口合计: 四类 token + 请求数 (Gauge 用 sum_over_time)"""
    w = window_span(window)
    totals = {}
    for key, metric in METRICS:
        q = f'sum(sum_over_time({metric}{{consumer="{esc(consumer)}"}}[{w}]))'
        totals[key] = _vector_value(vmp_instant(q, auth=auth))
    return totals


COMPARE_LABEL = {"today": "yesterday", "week": "prev_week", "month": "prev_month"}


def _prev_eval_ts(window):
    """环比基准时刻: today -> 昨日同刻; week -> 上周同刻; month -> 上月同刻
    (日号超出上月天数时钳到上月末, 如 3/31 -> 2/28)"""
    now = now_ts()
    if window == "today":
        return now - 86400
    if window == "week":
        return now - 7 * 86400
    d = datetime.fromtimestamp(now, tz=TZ)
    y, m = (d.year - 1, 12) if d.month == 1 else (d.year, d.month - 1)
    day = min(d.day, monthrange(y, m)[1])
    return int(datetime(y, m, day, d.hour, d.minute, d.second, tzinfo=TZ).timestamp())


def vmp_totals_prev(consumer, window, auth=None):
    """上一等长日历周期合计 (环比基准): 窗口宽相同, 评估点回移一个周期。
    today → 昨日同时段; week → 上周同时段; month → 上月同时段"""
    w = window_span(window)
    ts = _prev_eval_ts(window)
    totals = {}
    for key, metric in METRICS:
        q = f'sum(sum_over_time({metric}{{consumer="{esc(consumer)}"}}[{w}]))'
        totals[key] = _vector_value(vmp_instant(q, ts, auth))
    return totals


def _daily_one(consumer, day_start_ts, eval_ts, window, key, metric, auth):
    """单日单指标: sum_over_time 在 VMP 服务端聚合 (不用 query_range 大 step)"""
    q = f'sum(sum_over_time({metric}{{consumer="{esc(consumer)}"}}[{window}]))'
    return day_start_ts, key, _vector_value(vmp_instant(q, eval_ts, auth))


def vmp_daily(consumer, days, auth=None):
    """近 N 个本地日桶。历史天: [1d]@次日零点; 当日: [至今]@now (部分数据)"""
    now = now_ts()
    today0 = today_start_ts(now)
    day_starts = [today0 - i * 86400 for i in range(days - 1, -1, -1)]
    results = {}
    with ThreadPoolExecutor(max_workers=DAILY_QUERY_WORKERS) as pool:
        futs = []
        for ds in day_starts:
            # 当日传 eval_ts=None + 动态窗口; 历史天传次日零点 + [1d]
            eval_ts, window = (None, today_span()) if ds == today0 else (ds + 86400, "1d")
            for key, metric in METRICS:
                futs.append(pool.submit(_daily_one, consumer, ds, eval_ts, window, key, metric, auth))
        for f in futs:
            ds, key, val = f.result()
            results[(ds, key)] = val

    rows = []
    for ds in day_starts:
        req = results.get((ds, "req_tokens"), 0.0)
        cached = results.get((ds, "cached_tokens"), 0.0)
        rows.append({
            "date": fmt_date(ds),
            "req_tokens": round(req),
            "rsp_tokens": round(results.get((ds, "rsp_tokens"), 0.0)),
            "cached_tokens": round(cached),
            "cache_hit_rate": round(cached / req, 4) if req else None,
            "request_count": round(results.get((ds, "request_count"), 0.0)),
            "complete": ds < today0,  # 当日未完结标记 (面板据此降透明度)
        })
    return rows


def vmp_breakdown(consumer, window, label, auth=None):
    """by-model / by-provider 拆分。provider label 直接是中文名, 无需映射
    cached_tokens: 输入中的缓存命中部分 (OpenAI 规范 req_tokens 含缓存命中),
    面板据此拆出 输入(未命中) = req_tokens - cached_tokens 分别计量"""
    w = window_span(window)
    base = f'{{consumer="{esc(consumer)}"}}[{w}]'
    req = _vector_by(vmp_instant(f"sum by ({label}) (sum_over_time(req_tokens{base}))", auth=auth), label)
    rsp = _vector_by(vmp_instant(f"sum by ({label}) (sum_over_time(rsp_tokens{base}))", auth=auth), label)
    cached = _vector_by(vmp_instant(f"sum by ({label}) (sum_over_time(req_cached_tokens{base}))", auth=auth), label)
    count = _vector_by(vmp_instant(f"sum by ({label}) (sum_over_time(request_count{base}))", auth=auth), label)
    # 多模型无数据时返回空序列, data 为空, 面板显示"暂无调用记录"
    keys = sorted(set(req) | set(rsp), key=lambda k: req.get(k, 0) + rsp.get(k, 0), reverse=True)
    grand = sum(req.get(k, 0) + rsp.get(k, 0) for k in keys)
    return [
        {
            label: k,
            "req_tokens": round(req.get(k, 0)),
            "rsp_tokens": round(rsp.get(k, 0)),
            "cached_tokens": round(cached.get(k, 0)),
            "total_tokens": round(req.get(k, 0) + rsp.get(k, 0)),
            "request_count": round(count.get(k, 0)),
            "share": round((req.get(k, 0) + rsp.get(k, 0)) / grand, 4) if grand > 0 else None,
        }
        for k in keys
    ]


def _model_daily_one(consumer, ds, eval_ts, window, key, metric, auth):
    """单日单指标按 model 拆分 (instant + sum_over_time, 口径同 vmp_daily)"""
    q = f'sum by (model) (sum_over_time({metric}{{consumer="{esc(consumer)}"}}[{window}]))'
    return ds, key, _vector_by(vmp_instant(q, eval_ts, auth), "model")


def vmp_model_daily(consumer, window, auth=None):
    """窗口内 逐日 × 逐模型 的 req/rsp tokens (面板 Credit 按日生效系数分段计量用)。
    历史天 [1d]@次日零点; 当日 [至今]@now; 无流量日补 0, 日期逐日连续。"""
    today0 = today_start_ts()
    day_starts = window_day_starts(window)
    metrics = [(k, m) for k, m in METRICS if k in ("req_tokens", "rsp_tokens")]
    cells = {}  # model -> {day_start -> {key: value}}
    with ThreadPoolExecutor(max_workers=DAILY_QUERY_WORKERS) as pool:
        futs = []
        for ds in day_starts:
            eval_ts, w = (None, today_span()) if ds == today0 else (ds + 86400, "1d")
            for key, metric in metrics:
                futs.append(pool.submit(_model_daily_one, consumer, ds, eval_ts, w, key, metric, auth))
        for f in futs:
            ds, key, by_model = f.result()
            for model, val in by_model.items():
                cells.setdefault(model, {}).setdefault(ds, {})[key] = val
    out = {}
    for model, days in cells.items():
        rows = []
        for ds in day_starts:
            cell = days.get(ds, {})
            req, rsp = cell.get("req_tokens", 0.0), cell.get("rsp_tokens", 0.0)
            rows.append({
                "date": fmt_date(ds),
                "req_tokens": round(req),
                "rsp_tokens": round(rsp),
                "total_tokens": round(req + rsp),
            })
        out[model] = rows
    return out


def vmp_ttft(consumer, hours, group_by, auth=None):
    """per-model/provider TTFT。ttft_avg_ms 是每分钟均值, 窗口内按分钟等权平均;
    samples_min = 分钟样本数。按请求加权需 VMP recording rule (二期)"""
    base = f'{{consumer="{esc(consumer)}"}}[{hours}h]'
    ttft = _vector_by(
        vmp_instant(f"sum by ({group_by}) (avg_over_time({TTFT_METRIC}{base}))", auth=auth), group_by
    )
    samples = _vector_by(
        vmp_instant(f"sum by ({group_by}) (count_over_time({TTFT_METRIC}{base}))", auth=auth), group_by
    )
    return [
        {group_by: k, "ttft_avg_ms": round(v, 1), "samples_min": int(samples.get(k, 0))}
        for k, v in sorted(ttft.items(), key=lambda kv: kv[1])
    ]


def vmp_hourly(consumer, hours, auth=None):
    """近 N 个小时桶 (整点对齐) + 当前未完结小时。每桶 = 该小时四指标合计。
    历史整点桶用 query_range sum_over_time([1h]) step=1h (每步独立全窗口聚合);
    当前未完结小时用动态窗口 instant 补; 无流量小时补 0, 保证横轴逐小时连续"""
    now = now_ts()
    hour0 = now - (now % 3600)  # 当前小时起点
    start = hour0 - (hours - 1) * 3600  # 最早桶起点
    buckets = {}
    if hour0 >= start + 3600:
        for key, metric in METRICS:
            q = f'sum(sum_over_time({metric}{{consumer="{esc(consumer)}"}}[1h]))'
            result = vmp_query_range(q, start + 3600, hour0, 3600, auth)
            values = result[0].get("values", []) if result else []
            for ts, val in values:
                buckets.setdefault(int(float(ts)) - 3600, {})[key] = float(val)
    span_min = max((now - hour0) // 60, 1)
    if span_min > 1:  # 整点刚过 1 分钟内不补, 避免空桶
        for key, metric in METRICS:
            q = f'sum(sum_over_time({metric}{{consumer="{esc(consumer)}"}}[{span_min}m]))'
            buckets.setdefault(hour0, {})[key] = _vector_value(vmp_instant(q, auth=auth))
    rows = []
    bs = start
    while bs <= hour0:  # 从最早桶到当前小时逐桶输出 (缺失置 0)
        b = buckets.get(bs, {})
        rows.append({
            "ts": bs,
            "req_tokens": round(b.get("req_tokens", 0.0)),
            "rsp_tokens": round(b.get("rsp_tokens", 0.0)),
            "cached_tokens": round(b.get("cached_tokens", 0.0)),
            "request_count": round(b.get("request_count", 0.0)),
            "complete": bs < hour0,  # 当前小时未完结标记
        })
        bs += 3600
    return rows


# ---------------------------------------------------------------- 缓存


class TTLCache:
    def __init__(self, ttl):
        self.ttl = ttl
        self._store = {}  # key -> (updated_ts, payload)

    def get_fresh(self, key):
        item = self._store.get(key)
        if item and time.time() - item[0] < self.ttl:
            return item[1]
        return None

    def get_stale(self, key):
        item = self._store.get(key)
        if item and time.time() - item[0] < STALE_TOLERANCE_SEC:
            return item[1]
        return None

    def set(self, key, payload):
        if len(self._store) > 2000:  # 容量上限, 防内存膨胀
            self._store.clear()
        self._store[key] = (time.time(), payload)


CACHE = TTLCache(CACHE_TTL) if CACHE_TTL > 0 else None


# ---------------------------------------------------------------- Mock 数据
# 数值量级与 2026-09-05 线上 B 版快照一致, 模型/供应商名贴合真实目录

MOCK_MODELS = [
    # (model, provider, req_tokens, rsp_tokens, request_count, ttft_ms, samples_min, cached_tokens)
    ("deepseek-v4-pro", "火山", 1667833, 556665, 194, 676.7, 341, 620412),
    ("doubao-seed-2.1-pro", "火山", 1221504, 421027, 189, 303.3, 578, 356008),
    ("glm-5.2", "智谱", 925708, 198445, 50, 959.8, 318, 184930),
    ("qwen3.7-max", "百炼", 281275, 114634, 161, 1342.5, 79, 52310),
    ("MiniMax-M3", "稀宇", 180253, 40469, 88, 812.4, 120, 27460),
]

MOCK_DAILY_BASE = {
    "req_tokens": 1_050_000,
    "rsp_tokens": 430_000,
    "req_cached_tokens": 360_000,
    "request_count": 160,
}


def _mock_day_value(metric, day_ts):
    """某天某指标的总量 (按天确定性抖动 ±20%)"""
    jitter = ((day_ts // 86400) % 5 - 2) * 0.1
    return MOCK_DAILY_BASE[metric] * (1 + jitter)


def _mock_window_days(q):
    """PromQL 动态窗口 [XdYhZm] -> 天数 (浮点, 下限 1 分钟); 无动态窗口返回 None"""
    span = re.search(r"\[(?:(\d+)d)?(?:(\d+)h)?(?:(\d+)m)?\]", q)  # 形如 4d17h30m / 9h30m / 45m
    if not span or not any(span.groups()):
        return None
    minutes = int(span.group(1) or 0) * 1440 + int(span.group(2) or 0) * 60 + int(span.group(3) or 0)
    return max(minutes, 1) / 1440


def _mock_vmp_get(path, params):
    """按 PromQL 形态伪造 VMP 返回 (仅供本地开发)"""
    q = params.get("query", "")
    eval_ts = int(float(params.get("time", now_ts())))
    by_provider = "by (provider)" in q
    by_label = "sum by" in q

    # TTFT: avg_over_time -> 各 label 的分钟均值; count_over_time -> 分钟样本数
    if "avg_over_time" in q or "count_over_time" in q:
        is_avg = "avg_over_time" in q
        rows = []
        if by_provider:
            agg = {}
            for _, p, _, _, _, ttft, smp, _ in MOCK_MODELS:
                n, s = agg.get(p, (0.0, 0))
                agg[p] = (n + ttft * smp, s + smp)
            for p, (n, s) in agg.items():
                v = n / s if is_avg and s else float(s)
                rows.append({"metric": {"provider": p}, "value": [eval_ts, f"{v:.1f}"]})
        else:
            for m, _, _, _, _, ttft, smp, _ in MOCK_MODELS:
                v = ttft if is_avg else float(smp)
                rows.append({"metric": {"model": m}, "value": [eval_ts, f"{v:.1f}"]})
        return rows

    metric = next((m for m in MOCK_DAILY_BASE if f"{m}{{" in q), None)
    if metric is None:
        return []

    # range query (hourly 用): 按 step 逐桶返回矩阵, 每小时确定性抖动 ±20%
    if "start" in params and "end" in params:
        start, end, step = (int(float(params[k])) for k in ("start", "end", "step"))
        values = []
        ts = start
        while ts <= end:
            jitter = ((ts // 3600) % 5 - 2) * 0.1
            values.append([ts, f"{MOCK_DAILY_BASE[metric] / 24 * (1 + jitter):.1f}"])
            ts += step
        return [{"metric": {}, "values": values}]

    # sum by (model|provider) 拆分: [1d]+time -> 历史整日 (日级抖动, 与 _mock_day_value 同步);
    # 动态窗口 -> 按窗口时长等比缩放 (窗口合计与逐日明细自洽)
    if by_label:
        if "[1d]" in q and "time" in params:
            factor = 1 + (((eval_ts - 86400) // 86400) % 5 - 2) * 0.1
        else:
            factor = _mock_window_days(q) or 1.0
        rows = []
        if by_provider:
            agg = {}
            for _, p, req, rsp, cnt, _, _, cached in MOCK_MODELS:
                slot = agg.setdefault(
                    p, {"req_tokens": 0, "rsp_tokens": 0, "request_count": 0, "req_cached_tokens": 0}
                )
                slot["req_tokens"] += req
                slot["rsp_tokens"] += rsp
                slot["request_count"] += cnt
                slot["req_cached_tokens"] += cached
            for p, vals in agg.items():
                if metric in vals:
                    rows.append({"metric": {"provider": p}, "value": [eval_ts, f"{vals[metric] * factor:.1f}"]})
        else:
            per_model = {"req_tokens": 2, "rsp_tokens": 3, "request_count": 4, "req_cached_tokens": 7}
            if metric in per_model:
                idx = per_model[metric]
                rows = [
                    {"metric": {"model": r[0]}, "value": [eval_ts, f"{r[idx] * factor:.1f}"]}
                    for r in MOCK_MODELS
                ]
        return rows

    # 单指标总量: [1d]+time -> 指定日; 其余动态窗口 (d/h/m 组合) -> 按窗口时长等比缩放
    if "[1d]" in q and "time" in params:
        return [{"metric": {}, "value": [eval_ts, f"{_mock_day_value(metric, eval_ts - 86400):.1f}"]}]
    elapsed = _mock_window_days(q)
    if elapsed is None:
        elapsed = max(now_ts() - today_start_ts(), 60) / 86400
    return [{"metric": {}, "value": [eval_ts, f"{MOCK_DAILY_BASE[metric] * elapsed:.1f}"]}]


if MOCK_MODE:
    _real_vmp_get = _vmp_get

    def _vmp_get(path, params, auth=None):  # noqa: F811
        return _mock_vmp_get(path, params)


# ---------------------------------------------------------------- 端点实现


def _maybe_mock_flag(payload):
    if MOCK_MODE:
        payload["mock"] = True
    return payload


def endpoint_summary(consumer, params, auth):
    window = get_window(params)
    window_span(window)  # 校验
    # 当前窗口与上一等长周期并发查询, 供面板展示环比
    with ThreadPoolExecutor(max_workers=2) as pool:
        f_cur = pool.submit(vmp_totals, consumer, window, auth)
        f_prev = pool.submit(vmp_totals_prev, consumer, window, auth)
        totals, prev = f_cur.result(), f_prev.result()
    req = totals.get("req_tokens", 0.0)
    cached = totals.get("cached_tokens", 0.0)
    return _maybe_mock_flag({
        "object": "usage_summary",
        "date": fmt_date(now_ts()),
        "timezone": TZ_NAME,
        "consumer": consumer,
        "data": {
            "req_tokens": round(req),
            "rsp_tokens": round(totals.get("rsp_tokens", 0.0)),
            "total_tokens": round(req + totals.get("rsp_tokens", 0.0)),
            "cached_tokens": round(cached),
            "cache_hit_rate": round(cached / req, 4) if req else None,
            "request_count": round(totals.get("request_count", 0.0)),
        },
        "compare": {
            "window": COMPARE_LABEL[window],
            "req_tokens": round(prev.get("req_tokens", 0.0)),
            "rsp_tokens": round(prev.get("rsp_tokens", 0.0)),
            "cached_tokens": round(prev.get("cached_tokens", 0.0)),
            "request_count": round(prev.get("request_count", 0.0)),
        },
        "as_of": now_ts(),
        "data_freshness_sec": CACHE_TTL,
    })


def endpoint_daily(consumer, params, auth):
    days = parse_int(params, "days", 7, 1, RETENTION_DAYS)
    return _maybe_mock_flag({
        "object": "list",
        "timezone": TZ_NAME,
        "retention_days": RETENTION_DAYS,
        "data": vmp_daily(consumer, days, auth),
    })


def endpoint_by_model(consumer, params, auth):
    window = get_window(params)
    window_span(window)  # 校验
    # 窗口合计 + 逐日明细并发: daily 供面板按日生效的 Credit 系数分段计量
    with ThreadPoolExecutor(max_workers=2) as pool:
        f_rows = pool.submit(vmp_breakdown, consumer, window, "model", auth)
        f_daily = pool.submit(vmp_model_daily, consumer, window, auth)
        rows, model_daily = f_rows.result(), f_daily.result()
    for r in rows:
        r["daily"] = model_daily.get(r["model"], [])
    return _maybe_mock_flag({
        "object": "list",
        "window": window,
        "data": rows,
    })


def endpoint_by_provider(consumer, params, auth):
    window = get_window(params)
    window_span(window)  # 校验
    return _maybe_mock_flag({
        "object": "list",
        "window": window,
        "data": vmp_breakdown(consumer, window, "provider", auth),
    })


def endpoint_performance(consumer, params, auth):
    hours = parse_int(params, "hours", 24, 1, MAX_PERFORMANCE_HOURS)
    group_by = params.get("group_by", ["model"])[0]
    if group_by not in ("model", "provider"):
        raise ApiError(400, "group_by 必须是: model, provider", "invalid_group_by")
    return _maybe_mock_flag({
        "object": "list",
        "hours": hours,
        "data": vmp_ttft(consumer, hours, group_by, auth),
    })


def endpoint_hourly(consumer, params, auth):
    # 默认: 今日 00:00 (UTC+8) -> 当前小时 (分时图口径, 横轴从左到右时间递增);
    # 显式 hours=N 时为近 N 小时滚动窗口 (调试用)
    if params.get("hours", [None])[0]:
        hours = parse_int(params, "hours", 24, 1, 72)
    else:
        now = now_ts()
        hour0 = now - (now % 3600)
        hours = int((hour0 - today_start_ts(now)) // 3600) + 1
    return _maybe_mock_flag({
        "object": "list",
        "hours": hours,
        "timezone": TZ_NAME,
        "data": vmp_hourly(consumer, hours, auth),
    })


ROUTES = {
    "/v1/usage/summary": endpoint_summary,
    "/v1/usage/daily": endpoint_daily,
    "/v1/usage/hourly": endpoint_hourly,
    "/v1/usage/by-model": endpoint_by_model,
    "/v1/usage/by-provider": endpoint_by_provider,
    "/v1/usage/performance": endpoint_performance,
}


def endpoint_mock_models(consumer, params, auth):
    """mock 模式的 /v1/models (仅本地开发, 模拟 functions/models 的响应形状)。
    qwen3.7-max 系数在 2 天前发生变更 (2.64 -> 3.60), 用于验证面板按日分段计量;
    生产环境 /v1/models 由独立的 models 函数承担, 不经过本服务"""
    change_day = fmt_date(today_start_ts() - 2 * 86400)
    today = fmt_date(now_ts())
    histories = {
        "deepseek-v4-pro": [{"from": "2026-08-01", "credit": 0.99}],
        "doubao-seed-2.1-pro": [{"from": "2026-08-01", "credit": 1.85}],
        "glm-5.2": [{"from": "2026-08-01", "credit": 1.46}],
        "qwen3.7-max": [{"from": "2026-08-01", "credit": 2.64},
                        {"from": change_day, "credit": 3.60}],
        "MiniMax-M3": [{"from": "2026-08-01", "credit": 1.47}],
    }
    data = []
    for r in MOCK_MODELS:
        hist = histories.get(r[0], [])
        cur = None
        for e in hist:
            if e["from"] <= today:
                cur = e["credit"]
        data.append({
            "id": r[0], "object": "model", "created": 1700000000,
            "owned_by": "mock", "credit": cur, "credit_history": hist,
        })
    return {"object": "list", "data": data, "consumer": consumer, "mock": True}


if MOCK_MODE:
    ROUTES["/v1/models"] = endpoint_mock_models


class Handler(BaseHTTPRequestHandler):
    server_version = "vefaas-ops/1.1"

    def _send_json(self, status, payload, extra_headers=None):
        body = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Cache-Control", "no-store")
        self.send_header("Access-Control-Allow-Origin", CORS_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        for k, v in (extra_headers or {}).items():
            self.send_header(k, v)
        self.end_headers()
        self.wfile.write(body)

    def _send_error(self, status, message, code, err_type="invalid_request_error"):
        self._send_json(
            status,
            {"error": {"message": message, "type": err_type, "code": code}},
        )

    def do_OPTIONS(self):
        self.send_response(204)
        self.send_header("Access-Control-Allow-Origin", CORS_ORIGIN)
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Authorization, Content-Type")
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path.rstrip("/"))
        endpoint = ROUTES.get(parsed.path)
        if not endpoint:
            self._send_error(404, "not found", "not_found")
            return

        consumer = resolve_consumer(self)
        if not consumer:
            self._send_error(
                401,
                "缺少或非法的消费者身份 (missing or malformed consumer identity)",
                "missing_consumer",
                "authentication_error",
            )
            return

        params = urllib.parse.parse_qs(parsed.query)
        cache_key = f"{parsed.path}?{parsed.query}#{consumer}"
        if CACHE:
            hit = CACHE.get_fresh(cache_key)
            if hit:
                self._send_json(200, hit, {"X-Cache": "HIT"})
                return

        try:
            payload = endpoint(consumer, params, sts_credentials_from_headers(self))
        except ApiError as e:
            if e.status >= 500 and CACHE:
                stale = CACHE.get_stale(cache_key)
                if stale:
                    payload = {**stale, "warning": "data_stale"}
                    self._send_json(200, payload, {"X-Cache": "STALE"})
                    return
            self._send_error(e.status, e.message, e.code, e.err_type)
            return
        except Exception as e:  # 防御性兜底, 内部细节只进函数日志
            self._send_error(500, "internal error", "internal", "internal_error")
            print(f"[error] consumer={mask_consumer(consumer)} {type(e).__name__}: {e}", flush=True)
            return

        if CACHE:
            CACHE.set(cache_key, payload)
        self._send_json(200, payload)

    def log_message(self, format, *args):
        pass


if __name__ == "__main__":
    port = int(os.environ.get("VEFAAS_PORT", "8000"))
    mode = "mock" if MOCK_MODE else ("vmp: " + (VMP_QUERY_URL or "<VMP_QUERY_URL 未配置>"))
    if not MOCK_MODE and not VMP_QUERY_URL:
        print("[warn] VMP_QUERY_URL 未配置且非 mock 模式, 所有查询将返回 502", flush=True)
    server = HTTPServer(("0.0.0.0", port), Handler)
    print(f"usage api listening on :{port} ({mode})", flush=True)
    server.serve_forever()
