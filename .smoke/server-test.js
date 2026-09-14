/**
 * 服务端契约测试（不依赖 jsdom）
 *
 * 用隔离的数据目录启动真实 server.js，验证：
 *   1. 旧版 store.json 自动拆分迁移（记录 / 净值缓存，原文件改名保留）
 *   2. rev 并发控制（rev 不匹配 → 409，不静默覆盖）
 *   3. 损坏文件被隔离保留，绝不被覆盖
 *   4. 写入前快照生成
 *   5. 访问控制（Host / Origin 校验，无通配 CORS）
 *   6. 净值缓存单只增删、静态资源防目录穿越、参数校验
 *
 * 用法：node .smoke/server-test.js
 */
const { spawn } = require('child_process');
const http = require('http');
const fs = require('fs');
const path = require('path');

const WS = path.resolve(__dirname, '..');
const PORT = 8799;
const TMP = path.join(__dirname, 'tmp-server');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' → ' + detail : '')); }
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

function req(method, pathname, body, headers) {
  return new Promise((resolve) => {
    const data = body == null ? null : (typeof body === 'string' ? body : JSON.stringify(body));
    const h = Object.assign({}, headers || {});
    if (data != null) {
      h['Content-Type'] = 'application/json';
      h['Content-Length'] = Buffer.byteLength(data);
    }
    const r = http.request({ host: '127.0.0.1', port: PORT, path: pathname, method, headers: h }, (res) => {
      let raw = '';
      res.on('data', (c) => { raw += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(raw); } catch (e) {}
        resolve({ status: res.statusCode, headers: res.headers, body: raw, json });
      });
    });
    r.on('error', (e) => resolve({ status: 0, headers: {}, body: String(e.message), json: null }));
    if (data != null) r.write(data);
    r.end();
  });
}

function rmrf(p) {
  if (!fs.existsSync(p)) return;
  fs.rmSync(p, { recursive: true, force: true });
}

(async function main() {
  console.log('\n' + '='.repeat(58));
  console.log('  服务端契约测试');
  console.log('='.repeat(58));

  rmrf(TMP);
  fs.mkdirSync(TMP, { recursive: true });

  /* ---------- 造一份旧版单文件数据 ---------- */
  const ts = (s) => new Date(s + 'T00:00:00').getTime();
  const legacy = {
    version: 1,
    funds: {
      '110022': {
        code: '110022',
        name: '易方达消费行业股票',
        points: [
          { ts: ts('2026-01-01'), nav: 1.0, daily: 0 },
          { ts: ts('2026-01-02'), nav: 1.1, daily: 10 },
        ],
        acPoints: [
          { ts: ts('2026-01-01'), nav: 1.5 },
          { ts: ts('2026-01-02'), nav: 1.6 },
        ],
        full: true,
        inceptionTs: ts('2026-01-01'),
      },
    },
    records: [
      { id: 'r1', code: '110022', type: 'buy', date: '2026-01-01', amount: 1000, note: '旧数据' },
      { id: 'r2', code: '110022', type: 'sell', date: '2026-01-02', amount: 200, note: '' },
    ],
    currentCode: '110022',
    fundOrder: ['110022'],
    fundPinned: {},
    fundSort: { key: '', dir: 'desc' },
    savedAt: Date.now(),
  };
  fs.writeFileSync(path.join(TMP, 'store.json'), JSON.stringify(legacy), 'utf8');

  /* ---------- 启动服务 ---------- */
  const child = spawn(process.execPath, [path.join(WS, 'server.js')], {
    cwd: WS,
    env: Object.assign({}, process.env, {
      FUND_WORKBENCH_PORT: String(PORT),
      FUND_WORKBENCH_DATA_DIR: TMP,
    }),
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });

  let up = false;
  for (let i = 0; i < 40; i++) {
    const r = await req('GET', '/api/ping');
    if (r.status === 200) { up = true; break; }
    await wait(150);
  }
  check('服务可启动并响应 /api/ping', up, out.slice(0, 200));
  if (!up) { child.kill(); process.exit(1); }

  /* ---------- 1. 迁移 ---------- */
  console.log('\n【1】旧版 store.json 拆分迁移');
  const recFile = path.join(TMP, 'records.json');
  const navFile = path.join(TMP, 'navCache.json');
  check('生成 records.json', fs.existsSync(recFile));
  check('生成 navCache.json', fs.existsSync(navFile));
  check('旧 store.json 已改名保留（不删除）',
        !fs.existsSync(path.join(TMP, 'store.json')) &&
        fs.readdirSync(TMP).some((f) => f.indexOf('store.json.migrated-') === 0),
        fs.readdirSync(TMP).join(','));
  const migRec = JSON.parse(fs.readFileSync(recFile, 'utf8'));
  check('记录迁移完整（2 条）', migRec.records.length === 2, 'records=' + migRec.records.length);
  check('迁移后 rev 已初始化为 1', migRec.rev === 1, 'rev=' + migRec.rev);
  const migNav = JSON.parse(fs.readFileSync(navFile, 'utf8'));
  const migFund = migNav.funds['110022'];
  check('净值迁移完整（2 个点）', migFund && migFund.points.length === 2);
  check('acPoints 已按时间戳合并为每点 ac 字段',
        !!migFund && migFund.points[0].ac === 1.5 && migFund.points[1].ac === 1.6,
        migFund ? JSON.stringify(migFund.points) : 'null');

  /* ---------- 2. rev 并发控制 ---------- */
  console.log('\n【2】rev 并发控制');
  const g1 = await req('GET', '/api/store');
  check('GET /api/store 返回 rev', g1.status === 200 && g1.json.ok === true && typeof g1.json.rev === 'number',
        JSON.stringify(g1.json && g1.json.rev));
  const curRev = g1.json.rev;

  const stale = await req('POST', '/api/store', { rev: curRev - 5, records: [] });
  check('陈旧 rev → 409 冲突（不静默覆盖）',
        stale.status === 409 && stale.json && stale.json.conflict === true,
        'status=' + stale.status + ' body=' + stale.body.slice(0, 120));
  check('冲突响应带回服务端最新数据', !!(stale.json && stale.json.data && stale.json.data.records.length === 2));

  const ok = await req('POST', '/api/store', {
    rev: curRev, records: legacy.records.slice(), currentCode: '110022',
    fundOrder: ['110022'], fundPinned: {}, fundSort: { key: '', dir: 'desc' },
    dismissedTodos: { 'stale:110022': '1757520000000' },
  });
  check('正确 rev → 保存成功且 rev+1',
        ok.status === 200 && ok.json.ok === true && ok.json.rev === curRev + 1,
        'status=' + ok.status + ' ' + ok.body.slice(0, 120));

  const bad = await req('POST', '/api/store', { records: 'not-an-array' });
  check('records 非数组 → 400', bad.status === 400, 'status=' + bad.status);

  /* ---------- 2c. 待办忽略记录（dismissedTodos） ---------- */
  console.log('\n【2c】待办忽略记录持久化');
  const g2 = await req('GET', '/api/store');
  check('保存后能读回忽略记录（白名单未丢弃）',
        !!(g2.json.data.dismissedTodos && g2.json.data.dismissedTodos['stale:110022'] === '1757520000000'),
        JSON.stringify(g2.json.data.dismissedTodos));

  const dirty = await req('POST', '/api/store', {
    rev: g2.json.rev, records: legacy.records.slice(),
    dismissedTodos: { 'stale:110022': 12345, 'dip:110022': null, '': 'x', 'notfull:110026': 'ok', n: 0 },
  });
  check('含脏值的忽略记录可保存（不报错）', dirty.status === 200, 'status=' + dirty.status);
  const g3 = await req('GET', '/api/store');
  const dt = g3.json.data.dismissedTodos || {};
  check('脏值已归一：只保留有效字符串键值（null / 空键丢弃）',
        dt['stale:110022'] === '12345' && dt['notfull:110026'] === 'ok' &&
        dt['dip:110022'] === undefined && dt[''] === undefined && dt['n'] === '0',
        JSON.stringify(dt));

  const noDt = await req('POST', '/api/store', { rev: g3.json.rev, records: legacy.records.slice() });
  const g4 = await req('GET', '/api/store');
  check('缺省时回落为空对象（旧版数据兼容）',
        noDt.status === 200 && !!g4.json.data.dismissedTodos &&
        Object.keys(g4.json.data.dismissedTodos).length === 0,
        JSON.stringify(g4.json.data.dismissedTodos));

  console.log('\n【2b】写入前快照');
  const backupDir = path.join(TMP, 'backups');
  const snaps = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((f) => f.indexOf('records-') === 0) : [];
  check('生成记录快照', snaps.length >= 1, 'backups=' + snaps.join(','));
  if (snaps.length) {
    const snap = JSON.parse(fs.readFileSync(path.join(backupDir, snaps[0]), 'utf8'));
    check('快照内容为可解析的记录数据', Array.isArray(snap.records));
  }

  /* ---------- 3. 损坏文件隔离 ---------- */
  console.log('\n【3】损坏文件隔离保留');
  fs.writeFileSync(recFile, '{"records": [ 这不是合法 JSON', 'utf8');
  const bad2 = await req('GET', '/api/store');
  check('损坏 → 返回 corrupt 标记（而不是静默重置）',
        bad2.status === 200 && bad2.json && bad2.json.corrupt === true,
        bad2.body.slice(0, 120));
  const quarantined = fs.readdirSync(TMP).filter((f) => f.indexOf('records.json.corrupt-') === 0);
  check('损坏文件被改名保留（未丢失）', quarantined.length === 1, fs.readdirSync(TMP).join(','));
  if (quarantined.length) {
    const kept = fs.readFileSync(path.join(TMP, quarantined[0]), 'utf8');
    check('保留的是原始损坏内容（未覆盖）', kept.indexOf('这不是合法 JSON') > 0);
  }
  const corruptedData = bad2.json && bad2.json.data;
  check('损坏时返回空记录骨架，供前端降级', !!(corruptedData && Array.isArray(corruptedData.records)));

  /* ---------- 4. 净值缓存 ---------- */
  console.log('\n【4】净值缓存（单只增删）');
  const fund = {
    code: '000001',
    name: '测试基金',
    points: [{ ts: ts('2026-02-01'), nav: 2.0, daily: 0, ac: 2.5 }],
    full: true, inceptionTs: ts('2026-02-01'), updatedAt: ts('2026-02-01'),
  };
  const putNav = await req('POST', '/api/nav?code=000001', fund);
  check('POST /api/nav?code= 写入单只成功', putNav.status === 200 && putNav.json.ok === true,
        putNav.body.slice(0, 120));
  const getNav = await req('GET', '/api/nav');
  check('GET /api/nav 含新写入的基金', !!(getNav.json && getNav.json.data.funds['000001']));
  check('净值点保留 ac（累计净值）字段',
        getNav.json.data.funds['000001'].points[0].ac === 2.5);
  const delNav = await req('DELETE', '/api/nav?code=000001');
  check('DELETE /api/nav?code= 删除单只成功', delNav.status === 200 && delNav.json.removed === true);
  const getNav2 = await req('GET', '/api/nav');
  check('删除后不再返回该基金', !getNav2.json.data.funds['000001']);
  const putBad = await req('POST', '/api/nav?code=abc', fund);
  check('非法代码 → 400', putBad.status === 400, 'status=' + putBad.status);

  /* ---------- 5. 访问控制 ---------- */
  console.log('\n【5】访问控制（Host / Origin / CORS）');
  const evilHost = await req('GET', '/api/store', null, { Host: 'evil.example.com' });
  check('非本机 Host → 403（防 DNS rebinding）', evilHost.status === 403, 'status=' + evilHost.status);
  const evilOrigin = await req('GET', '/api/store', null, { Origin: 'http://evil.example.com' });
  check('非本机 Origin → 403（防跨站读写持仓）', evilOrigin.status === 403, 'status=' + evilOrigin.status);
  const sameOrigin = await req('GET', '/api/ping', null, { Origin: 'http://127.0.0.1:' + PORT });
  check('本机同源 Origin → 200', sameOrigin.status === 200, 'status=' + sameOrigin.status);
  check('响应不再携带通配 CORS 头',
        !sameOrigin.headers['access-control-allow-origin'],
        String(sameOrigin.headers['access-control-allow-origin']));
  check('另起端口不算同源',
        (await req('GET', '/api/ping', null, { Origin: 'http://127.0.0.1:9999' })).status === 403);

  /* ---------- 6. 静态资源与参数校验 ---------- */
  console.log('\n【6】静态资源与参数校验');
  const idx = await req('GET', '/');
  check('首页可访问', idx.status === 200 && idx.body.indexOf('<html') >= 0);
  const trav1 = await req('GET', '/../server.js');
  check('路径穿越 /../server.js 未泄露源码',
        trav1.status !== 200 && trav1.body.indexOf('FUND_WORKBENCH_PORT') < 0,
        'status=' + trav1.status);
  const trav2 = await req('GET', '/..%2f..%2fserver.js');
  check('编码穿越 /..%2f 未泄露源码',
        trav2.status !== 200 && trav2.body.indexOf('FUND_WORKBENCH_PORT') < 0,
        'status=' + trav2.status);
  const badCode = await req('GET', '/api/fund/nav?code=abc');
  check('/api/fund/nav 代码校验 → 400', badCode.status === 400, 'status=' + badCode.status);
  const noKey = await req('GET', '/api/fund/search');
  check('/api/fund/search 缺参数 → 400', noKey.status === 400, 'status=' + noKey.status);

  /* ---------- 7. 关闭 ---------- */
  child.kill();
  await wait(300);
  check('迁移日志已打印', out.indexOf('已拆分迁移旧数据') >= 0, out.slice(0, 160));

  console.log('\n' + '='.repeat(58));
  console.log('  服务端契约测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('='.repeat(58) + '\n');

  rmrf(TMP);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('测试脚本异常:', e);
  try { rmrf(TMP); } catch (err) {}
  process.exit(1);
});
