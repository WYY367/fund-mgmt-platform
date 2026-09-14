/**
 * 基金买入工作台 - 本地服务
 *
 * 职责：
 *   1. 托管 public/ 下的静态页面
 *   2. 代理天天基金（东方财富）公开接口，绕过浏览器 CORS 限制
 *   3. 本地持久化：用户记录与净值缓存**分开存储**
 *
 * 存储设计（v2）：
 *   data/records.json    用户记录（不可再生）—— 双写 localStorage、带 rev 并发校验、写入前快照
 *   data/navCache.json   净值缓存（可再生）—— 仅本地文件，单只基金增量写入
 *   data/backups/        记录快照（自动轮转，保留最近 N 份）
 *   data/store.json      旧版单文件（首次启动自动拆分迁移，原文件改名保留）
 *
 * 安全：仅监听回环地址；校验 Host / Origin，拒绝非本机页面的跨源读写。
 *
 * 启动：node server.js  （Windows 下可双击 启动.cmd）
 * 访问：http://127.0.0.1:8765
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = Number(process.env.FUND_WORKBENCH_PORT) || 8765;
const HOST = '127.0.0.1';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
// 数据目录可通过环境变量重定向（供自动化测试使用隔离目录，避免碰真实数据）
const DATA_DIR = process.env.FUND_WORKBENCH_DATA_DIR
  ? path.resolve(process.env.FUND_WORKBENCH_DATA_DIR)
  : path.join(ROOT, 'data');
const RECORDS_FILE = path.join(DATA_DIR, 'records.json');
const NAV_FILE = path.join(DATA_DIR, 'navCache.json');
const LEGACY_FILE = path.join(DATA_DIR, 'store.json');
const BACKUP_DIR = path.join(DATA_DIR, 'backups');

const STORE_VERSION = 2;
const MAX_BACKUPS = 8;                          // 快照最多保留份数
const SNAPSHOT_MIN_INTERVAL = 5 * 60 * 1000;   // 两次快照的最小间隔（避免每次保存都占空间）
const ALLOWED_HOSTS = ['127.0.0.1', 'localhost', '::1'];

/* ------------------------------------------------------------------ */
/* 通用文件工具                                                        */
/* ------------------------------------------------------------------ */

function ensureDirs() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(BACKUP_DIR)) fs.mkdirSync(BACKUP_DIR, { recursive: true });
}

function stamp() {
  const d = new Date();
  const p = (n) => (n < 10 ? '0' + n : String(n));
  return d.getFullYear() + p(d.getMonth() + 1) + p(d.getDate()) + '-' +
         p(d.getHours()) + p(d.getMinutes()) + p(d.getSeconds());
}

/**
 * 隔离异常文件：改名保留，绝不删除 —— 损坏 ≠ 空，原文件可能是唯一副本。
 * 返回改名后的文件名（失败返回 null）。
 */
function quarantine(file, label) {
  try {
    const target = file + '.' + (label || 'corrupt') + '-' + stamp() + '.bak';
    fs.renameSync(file, target);
    console.error('[store] 已隔离并保留可疑文件 →', path.basename(target));
    return path.basename(target);
  } catch (e) {
    console.error('[store] 隔离失败：', e.message);
    return null;
  }
}

/**
 * 读取 JSON 文件
 * 返回 { missing, corrupt, data, backup }
 * corrupt 时文件已被改名保留，data 为 null
 */
function readJsonFile(file, label) {
  if (!fs.existsSync(file)) return { missing: true, corrupt: false, data: null, backup: null };
  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (e) {
    console.error('[store] 读取失败：', e.message);
    return { missing: false, corrupt: true, data: null, backup: null };
  }
  if (!raw.trim()) {
    // 空文件：保留副本后按"无数据"处理
    return { missing: false, corrupt: false, data: null, backup: quarantine(file, 'empty') };
  }
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') throw new Error('顶层不是对象');
    return { missing: false, corrupt: false, data: parsed, backup: null };
  } catch (e) {
    console.error('[store] ' + path.basename(file) + ' 解析失败：' + e.message);
    return { missing: false, corrupt: true, data: null, backup: quarantine(file, label || 'corrupt') };
  }
}

/** 原子写入：先写临时文件再改名 */
function writeJsonAtomic(file, obj) {
  ensureDirs();
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

/** 写入前快照：按时间节流 + 只保留最近 N 份 */
function snapshot(file, prefix) {
  try {
    if (!fs.existsSync(file)) return;
    ensureDirs();
    const list = () => fs.readdirSync(BACKUP_DIR)
      .filter((f) => f.indexOf(prefix + '-') === 0 && f.slice(-5) === '.json')
      .sort();

    const files = list();
    if (files.length) {
      const newest = path.join(BACKUP_DIR, files[files.length - 1]);
      if (Date.now() - fs.statSync(newest).mtimeMs < SNAPSHOT_MIN_INTERVAL) return;
    }
    fs.copyFileSync(file, path.join(BACKUP_DIR, prefix + '-' + stamp() + '.json'));
    const after = list();
    while (after.length > MAX_BACKUPS) {
      fs.unlinkSync(path.join(BACKUP_DIR, after.shift()));
    }
  } catch (e) {
    console.error('[store] 快照失败（不影响本次保存）：', e.message);
  }
}

/* ------------------------------------------------------------------ */
/* 用户记录（records.json）                                            */
/* ------------------------------------------------------------------ */

function emptyRecords() {
  return {
    version: STORE_VERSION,
    rev: 0,
    records: [],
    currentCode: '',
    fundOrder: [],
    fundPinned: {},
    fundSort: { key: '', dir: 'desc' },
    dismissedTodos: {},
    savedAt: null,
  };
}

/** 待办提醒的消除记录：{ 待办标识: 情境指纹 }，只接受字符串键值，限量防膨胀 */
function normalizeDismissedTodos(obj) {
  const out = {};
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return out;
  const keys = Object.keys(obj).slice(0, 200);
  for (const k of keys) {
    if (!k || k.length > 80) continue;
    const v = obj[k];
    if (v === null || v === undefined) continue;
    out[k] = String(v).slice(0, 80);
  }
  return out;
}

/** 规范化为前端可用的记录结构（容错，不抛错） */
function normalizeRecords(obj) {
  const out = emptyRecords();
  if (!obj || typeof obj !== 'object') return out;
  if (Array.isArray(obj.records)) out.records = obj.records;
  if (typeof obj.currentCode === 'string') out.currentCode = obj.currentCode;
  if (Array.isArray(obj.fundOrder)) out.fundOrder = obj.fundOrder;
  if (obj.fundPinned && typeof obj.fundPinned === 'object' && !Array.isArray(obj.fundPinned)) {
    out.fundPinned = obj.fundPinned;
  }
  if (obj.fundSort && typeof obj.fundSort === 'object') out.fundSort = obj.fundSort;
  out.dismissedTodos = normalizeDismissedTodos(obj.dismissedTodos);
  out.rev = typeof obj.rev === 'number' ? obj.rev : 0;
  out.savedAt = obj.savedAt || null;
  return out;
}

/**
 * 旧版单文件 data/store.json → records.json + navCache.json
 * 原文件改名为 store.json.migrated-*.bak（保留，不删）
 */
function migrateLegacyIfNeeded() {
  if (fs.existsSync(RECORDS_FILE) || fs.existsSync(NAV_FILE)) return false;
  if (!fs.existsSync(LEGACY_FILE)) return false;

  const r = readJsonFile(LEGACY_FILE, 'corrupt');
  if (r.corrupt || !r.data) return false;

  const legacy = r.data;
  try {
    ensureDirs();
    const rec = normalizeRecords({
      records: legacy.records,
      currentCode: legacy.currentCode,
      fundOrder: legacy.fundOrder,
      fundPinned: legacy.fundPinned,
      fundSort: legacy.fundSort,
      savedAt: legacy.savedAt,
    });
    rec.rev = 1;
    writeJsonAtomic(RECORDS_FILE, rec);

    const nav = { version: STORE_VERSION, funds: normalizeFunds(legacy.funds || {}) };
    writeJsonAtomic(NAV_FILE, nav);

    fs.renameSync(LEGACY_FILE, LEGACY_FILE + '.migrated-' + stamp() + '.bak');
    console.log('[store] 已拆分迁移旧数据：记录 ' + rec.records.length + ' 条 / 基金 ' +
                Object.keys(nav.funds).length + ' 只（原 store.json 已改名保留）');
    return true;
  } catch (e) {
    console.error('[store] 迁移失败：', e.message);
    return false;
  }
}

function loadRecords() {
  migrateLegacyIfNeeded();
  const r = readJsonFile(RECORDS_FILE, 'corrupt');
  if (r.corrupt) return { corrupt: true, backup: r.backup, data: emptyRecords() };
  return { corrupt: false, backup: null, data: normalizeRecords(r.data) };
}

/**
 * 保存记录：带 rev 并发校验
 *   - 客户端 rev 与服务端不一致 → conflict（绝不静默覆盖，交由用户决定）
 *   - 通过 → 先快照再写入，rev + 1
 */
function saveRecords(obj) {
  const cur = loadRecords();
  const currentRev = cur.data.rev || 0;
  if (typeof obj.rev === 'number' && obj.rev !== currentRev) {
    return { conflict: true, rev: currentRev, data: cur.data };
  }
  const next = normalizeRecords(obj);
  next.version = STORE_VERSION;
  next.rev = currentRev + 1;
  next.savedAt = Date.now();

  snapshot(RECORDS_FILE, 'records');
  writeJsonAtomic(RECORDS_FILE, next);
  return { conflict: false, rev: next.rev };
}

/* ------------------------------------------------------------------ */
/* 净值缓存（navCache.json，可再生）                                   */
/* ------------------------------------------------------------------ */

/** 把旧的 acPoints（累计净值序列）按时间戳合并进每个净值点 */
function normalizePoints(points, acPoints) {
  if (!Array.isArray(points)) return [];
  const hasAc = points.length && points[0] && points[0].ac !== undefined;
  let acMap = null;
  if (!hasAc) {
    acMap = new Map();
    if (Array.isArray(acPoints)) {
      for (let i = 0; i < acPoints.length; i++) {
        const p = acPoints[i];
        if (p && typeof p.ts === 'number') acMap.set(p.ts, p.nav);
      }
    }
  }
  const out = [];
  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (!p || typeof p.ts !== 'number' || typeof p.nav !== 'number' || !(p.nav > 0)) continue;
    let ac = null;
    if (hasAc) ac = typeof p.ac === 'number' ? p.ac : null;
    else if (acMap && acMap.has(p.ts)) ac = acMap.get(p.ts);
    out.push({
      ts: p.ts,
      nav: p.nav,
      daily: typeof p.daily === 'number' ? p.daily : null,
      ac: ac,
    });
  }
  return out;
}

function normalizeFund(raw) {
  if (!raw || typeof raw !== 'object' || !raw.code) return null;
  const points = normalizePoints(raw.points, raw.acPoints);
  if (!points.length) return null;
  return {
    code: raw.code,
    name: raw.name || raw.code,
    points: points,
    full: raw.full === true,
    inceptionTs: typeof raw.inceptionTs === 'number' ? raw.inceptionTs : points[0].ts,
    updatedAt: raw.updatedAt || null,
    fetchedAt: raw.fetchedAt || 0,
  };
}

function normalizeFunds(funds) {
  const out = {};
  if (!funds || typeof funds !== 'object') return out;
  const keys = Object.keys(funds);
  for (let i = 0; i < keys.length; i++) {
    const f = normalizeFund(funds[keys[i]]);
    if (f) out[keys[i]] = f;
  }
  return out;
}

function loadNav() {
  const r = readJsonFile(NAV_FILE, 'navcorrupt');
  const funds = r.data ? normalizeFunds(r.data.funds) : {};
  return { corrupt: r.corrupt, backup: r.backup, funds: funds };
}

function writeNav(funds) {
  writeJsonAtomic(NAV_FILE, { version: STORE_VERSION, funds: funds, savedAt: Date.now() });
}

/* ------------------------------------------------------------------ */
/* 上游请求                                                            */
/* ------------------------------------------------------------------ */

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36';

/**
 * 用 node 原生 https 拉取上游文本，自动跟随 302/301 跳转
 */
function fetchText(targetUrl, referer, redirectDepth) {
  redirectDepth = redirectDepth || 0;
  return new Promise(function (resolve, reject) {
    if (redirectDepth > 5) return reject(new Error('重定向次数过多'));

    let parsed;
    try {
      parsed = new URL(targetUrl);
    } catch (e) {
      return reject(new Error('目标地址非法'));
    }

    const opts = {
      method: 'GET',
      headers: {
        'User-Agent': UA,
        Accept: '*/*',
        'Accept-Language': 'zh-CN,zh;q=0.9',
        Referer: referer || 'https://fund.eastmoney.com/',
      },
      timeout: 15000,
    };

    const req = https.request(parsed, opts, function (res) {
      const code = res.statusCode || 0;

      if (code >= 300 && code < 400 && res.headers.location) {
        res.resume();
        const next = new URL(res.headers.location, parsed).toString();
        return resolve(fetchText(next, referer, redirectDepth + 1));
      }

      if (code !== 200) {
        res.resume();
        return reject(new Error('上游返回 HTTP ' + code));
      }

      const chunks = [];
      res.on('data', function (c) {
        chunks.push(c);
      });
      res.on('end', function () {
        resolve(Buffer.concat(chunks).toString('utf8'));
      });
    });

    req.on('timeout', function () {
      req.destroy(new Error('上游请求超时'));
    });
    req.on('error', function (e) {
      reject(e);
    });
    req.end();
  });
}

/* ------------------------------------------------------------------ */
/* 上游数据解析                                                        */
/* ------------------------------------------------------------------ */

/**
 * 拉取基金完整信息（名称 / 单位净值 / 累计净值）
 * 上游文件形如 JS 变量赋值：
 *   var fS_name = "...";
 *   var Data_netWorthTrend = [{x:时间戳, y:单位净值, equityReturn:日涨跌%}];
 *   var Data_ACWorthTrend = [[时间戳, 累计净值]];
 *
 * 累计净值 − 单位净值 = 累计每份分红（复权修正量），用于避免分红除权日
 * 被误判为"下跌/抄底"，也用于持有收益的口径修正。
 */
async function getFundDetail(code) {
  const target = 'https://fund.eastmoney.com/pingzhongdata/' + code + '.js';
  const raw = await fetchText(target, 'https://fund.eastmoney.com/' + code + '.html');

  // 基金名称
  let name = '';
  const nameMatch = raw.match(/var\s+fS_name\s*=\s*"([^"]*)"/);
  if (nameMatch) name = nameMatch[1];

  // 单位净值序列
  let trend = [];
  const trendMatch = raw.match(/var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
  if (trendMatch) {
    try {
      trend = JSON.parse(trendMatch[1])
        .map(function (item) {
          return {
            ts: item.x,
            nav: item.y,
            daily: typeof item.equityReturn === 'number' ? item.equityReturn : null,
          };
        })
        .filter(function (item) {
          return typeof item.ts === 'number' && typeof item.nav === 'number' && item.nav > 0;
        });
    } catch (e) {
      trend = [];
    }
  }

  // 累计净值：按时间戳对齐到每个净值点（不做位置切片，避免序列错位）
  let acMap = new Map();
  const acMatch = raw.match(/var\s+Data_ACWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
  if (acMatch) {
    try {
      const arr = JSON.parse(acMatch[1]);
      for (let i = 0; i < arr.length; i++) {
        const p = arr[i];
        if (Array.isArray(p) && typeof p[0] === 'number' && typeof p[1] === 'number') {
          acMap.set(p[0], p[1]);
        }
      }
    } catch (e) {
      acMap = new Map();
    }
  }
  let divDays = 0;
  for (let i = 0; i < trend.length; i++) {
    trend[i].ac = acMap.has(trend[i].ts) ? acMap.get(trend[i].ts) : null;
    if (trend[i].ac != null && trend[i].ac - trend[i].nav > 1e-9) divDays++;
  }

  if (!name || trend.length === 0) {
    throw new Error('未查到该基金代码的净值数据，请确认代码是否正确');
  }

  return {
    code: code,
    name: name,
    points: trend,
    inceptionTs: trend[0].ts,
    full: true,
    updatedAt: trend[trend.length - 1].ts,
    // 含分红的交易日数量，便于核对复权口径是否生效
    divDays: divDays,
  };
}

/**
 * 模糊搜索基金（输入代码或名称片段）
 */
async function searchFund(keyword) {
  const target =
    'https://fundsuggest.eastmoney.com/FundSearch/api/FundSearchAPI.ashx?m=1&key=' +
    encodeURIComponent(keyword);
  const raw = await fetchText(target, 'https://fund.eastmoney.com/');
  const jsonText = raw.replace(/^[^(]*\(/, '').replace(/\);\s*$/, '');
  const data = JSON.parse(jsonText);

  const list = (data && data.Datas) || [];
  return list
    .filter(function (item) {
      return item.CATEGORYDESC === '基金' || /^\d{6}$/.test(item.CODE || '');
    })
    .slice(0, 12)
    .map(function (item) {
      return {
        code: item.CODE,
        name: item.NAME,
      };
    })
    .filter(function (item) {
      return /^\d{6}$/.test(item.code || '');
    });
}

/* ------------------------------------------------------------------ */
/* HTTP 工具                                                           */
/* ------------------------------------------------------------------ */

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(body),
  });
  res.end(body);
}

function readBody(req) {
  return new Promise(function (resolve, reject) {
    const chunks = [];
    let size = 0;
    req.on('data', function (c) {
      size += c.length;
      if (size > 32 * 1024 * 1024) {
        reject(new Error('请求体过大（单次不超过 32MB）'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', function () {
      resolve(Buffer.concat(chunks).toString('utf8'));
    });
    req.on('error', reject);
  });
}

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
};

function serveStatic(res, pathname) {
  let rel = pathname;
  try {
    rel = decodeURIComponent(pathname);
  } catch (e) {
    rel = pathname;
  }
  if (rel === '/' || rel === '') rel = '/index.html';
  rel = rel.replace(/\\/g, '/');

  // 防目录穿越：归一化后把最终路径钉死在 PUBLIC_DIR 内
  const safe = path.normalize(rel).replace(/^([.][.][/\\])+/, '');
  const filePath = path.resolve(PUBLIC_DIR, '.' + (safe.charAt(0) === '/' ? safe : '/' + safe));

  if (filePath !== PUBLIC_DIR && filePath.indexOf(PUBLIC_DIR + path.sep) !== 0) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    return res.end('Forbidden');
  }

  fs.readFile(filePath, function (err, buf) {
    if (err) {
      res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end('404 Not Found');
    }
    const ext = path.extname(filePath).toLowerCase();
    res.writeHead(200, {
      'Content-Type': MIME[ext] || 'application/octet-stream',
      'Cache-Control': 'no-cache',
    });
    res.end(buf);
  });
}

/* ------------------------------------------------------------------ */
/* 访问控制：只接受本机页面                                            */
/* ------------------------------------------------------------------ */

function hostNameOf(hostHeader) {
  if (!hostHeader) return '';
  const h = String(hostHeader).trim();
  if (h.charAt(0) === '[') {
    const end = h.indexOf(']');
    return end > 0 ? h.slice(1, end) : h;
  }
  const i = h.indexOf(':');
  return i >= 0 ? h.slice(0, i) : h;
}

/**
 * 双保险：
 *   1) Host 头必须是本机回环地址 —— 防 DNS rebinding（攻击者域名解析到 127.0.0.1 时 Host 仍是其域名）
 *   2) 若带 Origin，其主机名与端口必须与本服务一致（同源 POST 也会带 Origin）
 * 返回 null 表示通过，否则返回拒绝原因
 */
function checkAccess(req) {
  const hn = hostNameOf(req.headers.host);
  if (ALLOWED_HOSTS.indexOf(hn) < 0) return '非法的 Host：' + (req.headers.host || '(空)');

  const origin = req.headers.origin;
  if (origin && origin !== 'null') {
    let o;
    try {
      o = new URL(origin);
    } catch (e) {
      return '非法的 Origin';
    }
    if (ALLOWED_HOSTS.indexOf(o.hostname) < 0) return '不允许的跨源来源：' + origin;
    const oPort = o.port || (o.protocol === 'https:' ? '443' : '80');
    if (String(oPort) !== String(PORT)) return '不允许的跨源端口：' + origin;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* 路由                                                                */
/* ------------------------------------------------------------------ */

const server = http.createServer(async function (req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';
  const method = req.method || 'GET';

  // 不下发任何跨源共享（CORS）响应头：页面与接口同源，本就不需要；
  // 一旦放开通配，任意网站都能读写你本机的持仓数据。
  const deny = checkAccess(req);
  if (deny) {
    return sendJson(res, 403, { ok: false, error: deny });
  }
  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    /* ---------- 用户记录 ---------- */
    if (pathname === '/api/store' && method === 'GET') {
      const r = loadRecords();
      if (r.corrupt) {
        return sendJson(res, 200, {
          ok: false,
          corrupt: true,
          backup: r.backup,
          rev: 0,
          data: r.data,
          error: '数据文件损坏，已隔离保留为 ' + (r.backup || '(隔离文件)') + '，未做任何覆盖',
        });
      }
      return sendJson(res, 200, { ok: true, rev: r.data.rev || 0, data: r.data });
    }

    if (pathname === '/api/store' && method === 'POST') {
      const body = await readBody(req);
      let obj;
      try {
        obj = JSON.parse(body);
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: '数据格式错误' });
      }
      if (!obj || typeof obj !== 'object' || !Array.isArray(obj.records)) {
        return sendJson(res, 400, { ok: false, error: '数据结构不合法：records 必须是数组' });
      }

      let out;
      try {
        out = saveRecords(obj);
      } catch (e) {
        console.error('[store] 写入失败：', e.message);
        return sendJson(res, 500, { ok: false, error: '写入本地文件失败：' + e.message });
      }
      if (out.conflict) {
        return sendJson(res, 409, {
          ok: false,
          conflict: true,
          rev: out.rev,
          data: out.data,
          error: '数据已被其他页面修改',
        });
      }
      return sendJson(res, 200, { ok: true, rev: out.rev });
    }

    /* ---------- 净值缓存 ---------- */
    if (pathname === '/api/nav' && method === 'GET') {
      const r = loadNav();
      if (r.corrupt) {
        return sendJson(res, 200, {
          ok: false,
          corrupt: true,
          backup: r.backup,
          data: { version: STORE_VERSION, funds: r.funds },
          error: '净值缓存损坏，已隔离保留为 ' + (r.backup || '(隔离文件)') + '（可由上游重新拉取）',
        });
      }
      return sendJson(res, 200, { ok: true, data: { version: STORE_VERSION, funds: r.funds } });
    }

    if (pathname === '/api/nav' && method === 'POST') {
      const body = await readBody(req);
      let obj;
      try {
        obj = JSON.parse(body);
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: '数据格式错误' });
      }
      const current = loadNav().funds;
      const code = (parsed.query.code || '').trim();

      if (code) {
        if (!/^\d{6}$/.test(code)) {
          return sendJson(res, 400, { ok: false, error: '基金代码必须是 6 位数字' });
        }
        const fund = normalizeFund(obj);
        if (!fund) return sendJson(res, 400, { ok: false, error: '净值数据不合法或为空' });
        current[code] = fund;
      } else {
        // 整体替换（导入备份时使用）
        if (!obj || typeof obj !== 'object' || !obj.funds) {
          return sendJson(res, 400, { ok: false, error: '缺少 funds 字段' });
        }
        const replaced = normalizeFunds(obj.funds);
        for (const k in current) delete current[k];
        for (const k2 in replaced) current[k2] = replaced[k2];
      }

      try {
        writeNav(current);
      } catch (e) {
        console.error('[nav] 写入失败：', e.message);
        return sendJson(res, 500, { ok: false, error: '写入净值缓存失败：' + e.message });
      }
      return sendJson(res, 200, { ok: true, count: Object.keys(current).length });
    }

    if (pathname === '/api/nav' && method === 'DELETE') {
      const code = (parsed.query.code || '').trim();
      const current = loadNav().funds;
      if (code) {
        if (!current[code]) return sendJson(res, 200, { ok: true, removed: false });
        delete current[code];
      } else {
        for (const k in current) delete current[k];
      }
      try {
        writeNav(current);
      } catch (e) {
        return sendJson(res, 500, { ok: false, error: '写入净值缓存失败：' + e.message });
      }
      return sendJson(res, 200, { ok: true, removed: true, count: Object.keys(current).length });
    }

    /* ---------- 基金搜索 ---------- */
    if (pathname === '/api/fund/search') {
      const key = (parsed.query.key || '').trim();
      if (!key) return sendJson(res, 400, { ok: false, error: '请输入基金代码或名称' });
      const list = await searchFund(key);
      return sendJson(res, 200, { ok: true, data: list });
    }

    /* ---------- 基金净值详情 ---------- */
    if (pathname === '/api/fund/nav') {
      const code = (parsed.query.code || '').trim();
      if (!/^\d{6}$/.test(code)) {
        return sendJson(res, 400, { ok: false, error: '基金代码必须是 6 位数字' });
      }
      const detail = await getFundDetail(code);
      return sendJson(res, 200, { ok: true, data: detail });
    }

    /* ---------- 健康检查 ---------- */
    if (pathname === '/api/ping') {
      return sendJson(res, 200, { ok: true, service: 'fund-workbench', version: STORE_VERSION });
    }

    /* ---------- 静态资源 ---------- */
    return serveStatic(res, pathname);
  } catch (e) {
    console.error('[error]', pathname, e.message);
    return sendJson(res, 500, { ok: false, error: e.message || '服务内部错误' });
  }
});

server.listen(PORT, HOST, function () {
  const line = '='.repeat(52);
  // 启动即完成旧数据迁移，避免"首次访问才发现数据在旧文件里"
  try {
    migrateLegacyIfNeeded();
  } catch (e) {
    console.error('[store] 启动迁移检查失败：', e.message);
  }
  console.log('\n' + line);
  console.log('  基金买入工作台 已启动');
  console.log(line);
  console.log('  访问地址：http://' + HOST + ':' + PORT);
  console.log('  记录文件：' + RECORDS_FILE);
  console.log('  净值缓存：' + NAV_FILE);
  console.log('  自动快照：' + BACKUP_DIR);
  console.log('  按 Ctrl + C 可停止服务');
  console.log(line + '\n');
});

server.on('error', function (e) {
  if (e.code === 'EADDRINUSE') {
    console.log('\n' + '='.repeat(52));
    console.log('  端口 ' + PORT + ' 已被占用 —— 很可能服务已经在运行了。');
    console.log('');
    console.log('  直接用浏览器打开这个地址即可使用：');
    console.log('  http://' + HOST + ':' + PORT);
    console.log('');
    console.log('  如果确认没有在运行，请关闭占用该端口的程序后重试，');
    console.log('  或修改 server.js 顶部的 PORT 换一个端口。');
    console.log('='.repeat(52) + '\n');
  } else {
    console.error('[启动失败]', e.message);
  }
  // 端口占用不算致命错误，正常退出码，避免触发启动脚本的报错分支
  process.exit(0);
});
