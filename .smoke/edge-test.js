/**
 * 边界与压力测试：极端数据、日期边界、数据损坏恢复、大数据量。
 * 用法：NODE_PATH=... node edge-test.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const WS = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(WS, 'public', 'index.html'), 'utf8');

let pass = 0, fail = 0;
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' → ' + detail : '')); }
}
function wait(ms) { return new Promise((r) => setTimeout(r, ms)); }

/* 生成指定日期区间、指定净值序列的基金数据 */
function makeFund(points) {
  return { ok: true, data: { code: '999999', name: '测试基金', points, acPoints: [], updatedAt: points.length ? points[points.length - 1].ts : null } };
}
const ts = (s) => new Date(s + 'T00:00:00').getTime();

/* 启动一个 jsdom 实例 */
function boot(opts) {
  const storeRef = { data: opts.store || null, rev: 0 };
  const navRef = { funds: (opts.nav && opts.nav.funds) || {} };
  const errors = [];
  const vc = new VirtualConsole();
  vc.on('jsdomError', (e) => errors.push(String(e.message || e)));
  vc.on('error', (...a) => errors.push(a.join(' ')));
  ['warn', 'log', 'info', 'debug'].forEach((k) => vc.on(k, () => {}));

  const fundResp = opts.fund || makeFund([]);
  const failing = opts.failApi;
  const corrupt = !!opts.corrupt;

  const dom = new JSDOM(html, {
    runScripts: 'dangerously',
    pretendToBeVisual: true,
    url: 'http://127.0.0.1:8765/',
    virtualConsole: vc,
    beforeParse(window) {
      window.fetch = function (url, o) {
        const u = String(url);
        const method = (o && o.method) || 'GET';
        if (failing) return Promise.reject(new Error('模拟网络故障'));
        if (u.indexOf('/api/store') === 0 && method === 'GET') {
          // 模拟服务端：记录文件损坏 → 返回 corrupt 标记（文件已在服务端隔离保留）
          if (corrupt) {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({
              ok: false, corrupt: true, backup: 'records.json.corrupt-20260912-220000.bak',
              rev: 0, data: { version: 2, rev: 0, records: [], currentCode: '', fundOrder: [], fundPinned: {}, fundSort: { key: '', dir: 'desc' } }
            }) });
          }
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, rev: storeRef.rev, data: storeRef.data }) });
        }
        if (u.indexOf('/api/store') === 0 && method === 'POST') {
          try { storeRef.data = JSON.parse(o.body); storeRef.rev++; } catch (e) { }
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, rev: storeRef.rev }) });
        }
        if (u.indexOf('/api/nav') === 0) {
          const qm = u.match(/code=(\d+)/);
          if (method === 'GET') {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, data: { funds: navRef.funds } }) });
          }
          if (method === 'POST') {
            try {
              const body = JSON.parse(o.body);
              if (qm) navRef.funds[qm[1]] = body; else navRef.funds = body.funds || {};
            } catch (e) { }
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
          }
          if (method === 'DELETE') {
            if (qm) delete navRef.funds[qm[1]];
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
          }
        }
        if (u.indexOf('/api/fund/search') === 0)
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, data: [{ code: '999999', name: '测试基金' }] }) });
        if (u.indexOf('/api/fund/nav') === 0)
          return Promise.resolve({ ok: true, json: () => Promise.resolve(fundResp) });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      };
      window.AbortController = window.AbortController || function () { this.signal = {}; this.abort = function () {}; };
      window.matchMedia = window.matchMedia || function () { return { matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }; };
    }
  });
  return { dom, window: dom.window, doc: dom.window.document, storeRef, navRef, errors };
}

(async function main() {
  console.log('\n' + '='.repeat(58));
  console.log('  边界与压力测试');
  console.log('='.repeat(58));

  /* ---------- 1. 空存储：首次打开不崩 ---------- */
  console.log('\n【1】空存储首次打开');
  {
    const { doc, errors, window, storeRef } = boot({ store: null });
    await wait(1200);
    check('页面正常渲染', doc.getElementById('todayZone').innerHTML.length > 0);
    check('自动预置示例数据', storeRef.data && storeRef.data.records && storeRef.data.records.length === 5,
          storeRef.data ? 'records=' + (storeRef.data.records || []).length : 'null');
    const realErr = errors.filter((e) => !/Not implemented|Could not parse CSS/i.test(e));
    check('无运行时异常', realErr.length === 0, realErr.slice(0, 2).join(' | '));
    window.close();
  }

  /* ---------- 2. 净值数据为空 ---------- */
  console.log('\n【2】基金无净值数据（接口返回空序列）');
  {
    const { doc, window, errors } = boot({
      store: {
        version: 1,
        funds: { '999999': { code: '999999', name: '测试基金', points: [] } },
        records: [{ id: 'r1', code: '999999', date: '2026-01-05', amount: 1000, note: '', createdAt: 1 }],
        currentCode: '999999'
      },
      fund: { ok: true, data: { code: '999999', name: '测试基金', points: [], acPoints: [], updatedAt: null } }
    });
    await wait(1200);
    check('图表显示空状态而非崩溃',
          (doc.getElementById('chartSvg').getAttribute('class') || '').indexOf('hidden') >= 0,
          doc.getElementById('chartSvg').getAttribute('class'));
    check('空状态提示可见',
          (doc.getElementById('chartEmpty').getAttribute('class') || '').indexOf('hidden') < 0);
    check('表格仍渲染记录', doc.querySelectorAll('#recBody tr').length === 1);
    check('表格净值列显示"待加载"', doc.body.textContent.indexOf('待加载') >= 0);
    const gridTxt = doc.getElementById('statGrid').textContent;
    check('概览无 NaN', gridTxt.indexOf('NaN') < 0, gridTxt.replace(/\s+/g,' ').slice(0,100));
    check('概览无双破折号', gridTxt.indexOf('— —') < 0 && gridTxt.indexOf('¥—') < 0);
    const realErr = errors.filter((e) => !/Not implemented|Could not parse CSS/i.test(e));
    check('无运行时异常', realErr.length === 0, realErr.slice(0, 2).join(' | '));
    window.close();
  }

  /* ---------- 3. 日期边界：跨月/跨年/闰年 ---------- */
  console.log('\n【3】日期边界');
  {
    const pts = [
      { ts: ts('2025-12-31'), nav: 1.5 },
      { ts: ts('2026-01-01'), nav: 1.6 },
      { ts: ts('2026-01-31'), nav: 1.7 },
      { ts: ts('2026-02-01'), nav: 1.8 },
      { ts: ts('2024-02-29'), nav: 1.2 }
    ];
    const recs = [
      { id: 'a', code: '999999', date: '2024-02-29', amount: 1000, note: '', createdAt: 1 },
      { id: 'b', code: '999999', date: '2025-12-31', amount: 1000, note: '', createdAt: 2 },
      { id: 'c', code: '999999', date: '2026-01-01', amount: 1000, note: '', createdAt: 3 },
      { id: 'd', code: '999999', date: '2026-01-31', amount: 1000, note: '', createdAt: 4 },
      { id: 'e', code: '999999', date: '2026-02-01', amount: 1000, note: '', createdAt: 5 }
    ];
    const { doc, window, errors } = boot({
      store: { version: 1, funds: { '999999': { code: '999999', name: '测试基金', points: pts } }, records: recs, currentCode: '999999' },
      fund: makeFund(pts)
    });
    await wait(1300);
    const rows = doc.querySelectorAll('#recBody tr');
    check('5 条记录全部渲染', rows.length === 5, 'rows=' + rows.length);
    const bodyRenderTxt = doc.getElementById('recBody').textContent + doc.getElementById('statGrid').textContent + doc.getElementById('chartLegend').textContent;
    check('跨月渲染无 NaN', bodyRenderTxt.indexOf('NaN') < 0);
    // 闰年 2/29 应匹配到 2024-02-29 净值 1.2
    check('闰年 2024-02-29 正确匹配',
          doc.body.textContent.indexOf('1.2000') >= 0 || doc.body.textContent.indexOf('1.2') >= 0);
    const realErr = errors.filter((e) => !/Not implemented|Could not parse CSS/i.test(e));
    check('无运行时异常', realErr.length === 0, realErr.slice(0, 2).join(' | '));
    window.close();
  }

  /* ---------- 4. 非交易日顺延 ---------- */
  console.log('\n【4】非交易日顺延（周末/节假日）');
  {
    // 2026-01-05 是周一，2026-01-03 是周六（无净值）
    const pts = [
      { ts: ts('2026-01-02'), nav: 2.0 },
      { ts: ts('2026-01-05'), nav: 2.1 }
    ];
    const { doc, window } = boot({
      store: {
        version: 1,
        funds: { '999999': { code: '999999', name: '测试基金', points: pts } },
        records: [{ id: 'x', code: '999999', date: '2026-01-03', amount: 1000, note: '周末买入', createdAt: 1 }],
        currentCode: '999999'
      },
      fund: makeFund(pts)
    });
    await wait(1200);
    check('周末买入取前一日净值 2.0000',
          doc.body.textContent.indexOf('2.0000') >= 0);
    check('非交易日标记 * 出现', doc.body.textContent.indexOf('*') >= 0);
    window.close();
  }

  /* ---------- 5. 早于净值区间 ---------- */
  console.log('\n【5】买入日早于净值区间起点');
  {
    const pts = [{ ts: ts('2026-06-01'), nav: 3.0 }, { ts: ts('2026-06-02'), nav: 3.1 }];
    const { doc, window, errors } = boot({
      store: {
        version: 1,
        funds: { '999999': { code: '999999', name: '测试基金', points: pts } },
        records: [{ id: 'y', code: '999999', date: '2020-01-01', amount: 1000, note: '太早', createdAt: 1 }],
        currentCode: '999999'
      },
      fund: makeFund(pts)
    });
    await wait(1200);
    check('页面未崩溃', doc.getElementById('todayZone').innerHTML.length > 0);
    check('早于区间记录显示待加载', doc.body.textContent.indexOf('待加载') >= 0);
    const rt2 = doc.getElementById('recBody').textContent + doc.getElementById('statGrid').textContent;
    check('渲染区域无 NaN', rt2.indexOf('NaN') < 0);
    const realErr = errors.filter((e) => !/Not implemented|Could not parse CSS/i.test(e));
    check('无运行时异常', realErr.length === 0, realErr.slice(0, 2).join(' | '));
    window.close();
  }

  /* ---------- 6. 数据损坏与异常结构 ---------- */
  console.log('\n【6】存储数据损坏 / 结构异常');
  {
    // 6a) 服务端明确返回「文件损坏」→ 页面降级，且绝不用示例数据覆盖
    const a = boot({ corrupt: true });
    await wait(1200);
    check('损坏时页面未崩溃', a.doc.getElementById('todayZone').innerHTML.length > 0);
    check('明确提示已隔离保留（含备份文件名）',
          a.doc.getElementById('todayZone').textContent.indexOf('隔离保留') >= 0 &&
          a.doc.getElementById('todayZone').textContent.indexOf('.bak') >= 0,
          a.doc.getElementById('todayZone').textContent.slice(0, 90));
    check('损坏时不再写入（不覆盖、不预置示例数据）',
          a.storeRef.data === null,
          a.storeRef.data ? 'records=' + (a.storeRef.data.records || []).length : 'null');
    a.window.close();

    // 6b) 服务端返回结构异常但可解析 → 页面按空数据处理，仍可用
    const b = boot({ store: { version: 1, funds: 'THIS_IS_NOT_AN_OBJECT', records: null, currentCode: 12345 } });
    await wait(1200);
    check('异常结构未导致崩溃', b.doc.getElementById('todayZone').innerHTML.length > 0);
    check('异常结构按空数据处理并预置示例',
          b.storeRef.data && Array.isArray(b.storeRef.data.records) && b.storeRef.data.records.length === 5,
          b.storeRef.data ? String(b.storeRef.data.records && b.storeRef.data.records.length) : 'null');
    b.window.close();
  }

  /* ---------- 7. 大数据量（1000 条记录 + 1200 净值点） ---------- */
  console.log('\n【7】大数据量压力');
  {
    const pts = [];
    let n = 3.0;
    for (let i = 0, t = ts('2021-09-01'); t <= ts('2026-09-11'); t += 86400000) {
      const wd = new Date(t).getDay();
      if (wd === 0 || wd === 6) continue;
      n = Math.max(1.0, n + Math.sin(i / 9) * 0.008);
      pts.push({ ts: t, nav: Number(n.toFixed(4)) });
      i++;
    }
    const recs = [];
    for (let i = 0; i < 1000; i++) {
      recs.push({
        id: 'r' + i, code: '999999',
        date: '202' + (2 + (i % 5)) + '-0' + (1 + (i % 9)) + '-1' + (i % 9),
        amount: 100 + i, note: 'n' + i, createdAt: i
      });
    }
    const t0 = Date.now();
    const { doc, window, errors } = boot({
      store: { version: 1, funds: { '999999': { code: '999999', name: '测试基金', points: pts } }, records: recs, currentCode: '999999' },
      fund: makeFund(pts)
    });
    await wait(2500);
    const elapsed = Date.now() - t0;
    const bootMs = elapsed - 2500; // 剔除测试固定等待，度量真实页面加载
    check('1000 条记录全部渲染', doc.querySelectorAll('#recBody tr').length === 1000,
          'rows=' + doc.querySelectorAll('#recBody tr').length);
    check('1200+ 净值点曲线已绘制',
          doc.querySelectorAll('#chartSvg path').length >= 2, 'points=' + pts.length);
    check('页面加载耗时 < 5 秒（不含固定等待）', bootMs < 5000, bootMs + 'ms');
    const realErr = errors.filter((e) => !/Not implemented|Could not parse CSS/i.test(e));
    check('无运行时异常', realErr.length === 0, realErr.slice(0, 2).join(' | '));
    console.log('     净值点数: ' + pts.length + '，页面加载耗时(不含固定等待): ' + bootMs + 'ms');
    window.close();
  }

  /* ---------- 8. 接口故障降级 ---------- */
  console.log('\n【8】接口故障降级');
  {
    const { doc, window, storeRef, errors } = boot({ store: null, failApi: true });
    await wait(1500);
    check('接口全挂时页面仍可用', doc.getElementById('todayZone').innerHTML.length > 0);
    let lsSaved = null;
    try { lsSaved = JSON.parse(window.localStorage.getItem('wb_fund_workbench_records_v2') || 'null'); } catch (e) {}
    check('接口故障时 localStorage 兜底保存成功', !!(lsSaved && lsSaved.records && lsSaved.records.length === 5),
          lsSaved ? 'records=' + (lsSaved.records || []).length : 'null');
    check('兜底数据不含净值缓存（体积可控）', !!(lsSaved && !lsSaved.funds));
    check('HTTP 模式标记为本地模式',
          (doc.getElementById('syncText') || {}).textContent === '本地模式',
          (doc.getElementById('syncText') || {}).textContent);
    check('未抛未捕获异常',
          errors.filter((e) => /Unhandled|uncaught/i.test(e)).length === 0);
    window.close();
  }

  /* ---------- 9. 单笔极端值 ---------- */
  console.log('\n【9】极端数值');
  {
    const pts = [{ ts: ts('2026-01-01'), nav: 0.0001 }, { ts: ts('2026-09-11'), nav: 9999 }];
    const { doc, window } = boot({
      store: {
        version: 1,
        funds: { '999999': { code: '999999', name: '测试基金', points: pts } },
        records: [
          { id: 'p', code: '999999', date: '2026-01-01', amount: 0.01, note: '极小', createdAt: 1 },
          { id: 'q', code: '999999', date: '2026-09-11', amount: 99999999, note: '极大', createdAt: 2 }
        ],
        currentCode: '999999'
      },
      fund: makeFund(pts)
    });
    await wait(1300);
    const extTxt = doc.getElementById('statGrid').textContent + doc.getElementById('recBody').textContent;
    check('极端净值未导致 Infinity/NaN', extTxt.indexOf('Infinity') < 0 && extTxt.indexOf('NaN') < 0,
          extTxt.replace(/\s+/g,' ').slice(0,120));
    check('极端值已压缩显示（含 亿/倍）', /亿|倍/.test(extTxt));
    check('超大金额格式化正常（含千分位）',
          /99,999,999/.test(doc.body.textContent));
    window.close();
  }

  console.log('\n' + '='.repeat(58));
  console.log('  边界测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('='.repeat(58) + '\n');
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('测试脚本异常:', e);
  process.exit(1);
});
