/**
 * 基金买入工作台 - 本地服务
 *
 * 职责：
 *   1. 托管 public/ 下的静态页面
 *   2. 代理天天基金（东方财富）公开接口，绕过浏览器 CORS 限制
 *   3. 提供本地持久化存储（data/store.json），保证重启不丢
 *
 * 启动：node server.js  （Windows 下可双击 启动.cmd）
 * 访问：http://127.0.0.1:8765
 */

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

const PORT = 8765;
const HOST = '127.0.0.1';
const ROOT = __dirname;
const PUBLIC_DIR = path.join(ROOT, 'public');
const DATA_DIR = path.join(ROOT, 'data');
const STORE_FILE = path.join(DATA_DIR, 'store.json');

/* ------------------------------------------------------------------ */
/* 数据持久化                                                          */
/* ------------------------------------------------------------------ */

function ensureDataDir() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
}

function readStore() {
  ensureDataDir();
  try {
    if (!fs.existsSync(STORE_FILE)) return null;
    const raw = fs.readFileSync(STORE_FILE, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    console.error('[store] 读取失败：', e.message);
    return null;
  }
}

function writeStore(obj) {
  ensureDataDir();
  try {
    // 原子写入：先写临时文件再改名，避免写一半崩溃导致数据损坏
    const tmp = STORE_FILE + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf8');
    fs.renameSync(tmp, STORE_FILE);
    return true;
  } catch (e) {
    console.error('[store] 写入失败：', e.message);
    return false;
  }
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
 * 拉取基金完整信息（名称 / 净值序列）
 * 上游文件形如 JS 变量赋值：var fS_name = "..."; var Data_netWorthTrend = [...];
 */
async function getFundDetail(code) {
  const target = 'https://fund.eastmoney.com/pingzhongdata/' + code + '.js';
  const raw = await fetchText(target, 'https://fund.eastmoney.com/' + code + '.html');

  // 基金名称
  let name = '';
  const nameMatch = raw.match(/var\s+fS_name\s*=\s*"([^"]*)"/);
  if (nameMatch) name = nameMatch[1];

  // 单位净值序列：[{x: 毫秒时间戳, y: 单位净值, equityReturn: 日涨跌幅%}]
  let trend = [];
  const trendMatch = raw.match(/var\s+Data_netWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
  if (trendMatch) {
    const parsed = JSON.parse(trendMatch[1]);
    trend = parsed
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
  }

  // 累计净值（备用，便于核对分红）
  let acTrend = [];
  const acMatch = raw.match(/var\s+Data_ACWorthTrend\s*=\s*(\[[\s\S]*?\]);/);
  if (acMatch) {
    try {
      acTrend = JSON.parse(acMatch[1]).map(function (pair) {
        return { ts: pair[0], nav: pair[1] };
      });
    } catch (e) {
      acTrend = [];
    }
  }

  if (!name || trend.length === 0) {
    throw new Error('未查到该基金代码的净值数据，请确认代码是否正确');
  }

  // 返回成立以来的全部历史净值（"全部"区间与"成立以来最大回撤"依赖完整数据）
  return {
    code: code,
    name: name,
    points: trend,
    // 便于前端做分红/复权核对
    acPoints: acTrend.length ? acTrend.slice(-trend.length) : [],
    inceptionTs: trend[0].ts,
    full: true,
    updatedAt: trend[trend.length - 1].ts,
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
      if (size > 10 * 1024 * 1024) {
        reject(new Error('请求体过大'));
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
  let rel = pathname === '/' ? '/index.html' : pathname;
  // 防目录穿越
  const safe = path.normalize(rel).replace(/^(\.\.[/\\])+/, '');
  const filePath = path.join(PUBLIC_DIR, safe);

  if (!filePath.startsWith(PUBLIC_DIR)) {
    res.writeHead(403);
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
/* 路由                                                                */
/* ------------------------------------------------------------------ */

const server = http.createServer(async function (req, res) {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname || '/';
  const method = req.method || 'GET';

  // 允许本机页面直接调用
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');

  if (method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  try {
    /* ---------- 本地数据读写 ---------- */
    if (pathname === '/api/store' && method === 'GET') {
      const data = readStore();
      return sendJson(res, 200, { ok: true, data: data });
    }

    if (pathname === '/api/store' && method === 'POST') {
      const body = await readBody(req);
      let obj;
      try {
        obj = JSON.parse(body);
      } catch (e) {
        return sendJson(res, 400, { ok: false, error: '数据格式错误' });
      }
      if (!obj || typeof obj !== 'object') {
        return sendJson(res, 400, { ok: false, error: '数据为空' });
      }
      const ok = writeStore(obj);
      return sendJson(res, ok ? 200 : 500, {
        ok: ok,
        error: ok ? null : '写入本地文件失败',
      });
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
      return sendJson(res, 200, { ok: true, service: 'fund-workbench' });
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
  console.log('\n' + line);
  console.log('  基金买入工作台 已启动');
  console.log(line);
  console.log('  访问地址：http://' + HOST + ':' + PORT);
  console.log('  数据文件：' + STORE_FILE);
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
