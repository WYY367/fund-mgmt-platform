/**
 * 运行时验证：用 jsdom 真实加载页面，模拟后端接口，
 * 跑完整初始化流程，检查渲染结果与运行时错误。
 *
 * 用法（需设置 NODE_PATH 指向已安装 jsdom 的目录）：
 *   NODE_PATH=... node runtime-verify.js
 */
const fs = require('fs');
const path = require('path');
const { JSDOM, VirtualConsole } = require('jsdom');

const WS = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(WS, 'public', 'index.html'), 'utf8');

let pass = 0, fail = 0;
const results = [];
function check(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' → ' + detail : '')); }
  results.push({ name, ok: !!cond });
}

/* ---------- 构造模拟数据 ---------- */
const d = (s) => new Date(s + 'T00:00:00').getTime();
const DEMO_POINTS = [];
// 生成 500 个交易日（从 2024-09 到 2026-09），净值在 2.0~3.2 之间波动
let nav = 3.2;
for (let i = 0, t = d('2024-09-02'); t <= d('2026-09-11'); t += 24 * 3600 * 1000) {
  const wd = new Date(t).getDay();
  if (wd === 0 || wd === 6) continue;
  nav = Math.max(1.5, nav + (Math.sin(i / 7) * 0.012 - 0.0009));
  // ac = 累计净值：这里让「累计每份分红」恒定 0.5，用于走通分红修正分支且不影响原口径期望值
  DEMO_POINTS.push({
    ts: t,
    nav: Number(nav.toFixed(4)),
    daily: Number((Math.sin(i / 3) * 1.2).toFixed(2)),
    ac: Number((nav + 0.5).toFixed(4))
  });
  i++;
}
const LAST = DEMO_POINTS[DEMO_POINTS.length - 1];

const FUND_DETAIL = {
  ok: true,
  data: {
    code: '110022',
    name: '易方达消费行业股票',
    points: DEMO_POINTS,
    updatedAt: LAST.ts,
    inceptionTs: DEMO_POINTS[0].ts,
    full: true,
    divDays: 0
  }
};
const SEARCH_RESULT = { ok: true, data: [{ code: '110022', name: '易方达消费行业股票' }] };

/* ---------- 捕获运行时错误 ---------- */
const errors = [];
const vc = new VirtualConsole();
vc.on('jsdomError', (e) => errors.push('jsdomError: ' + (e.message || e)));
vc.on('error', (...a) => errors.push('console.error: ' + a.join(' ')));
vc.on('warn', () => {});
vc.on('log', () => {});
vc.on('info', () => {});
vc.on('debug', () => {});

/* ---------- 模拟 fetch ----------
   记录走 /api/store（含 rev 并发校验），净值缓存走 /api/nav（单只增量写入） */
function makeFetch(storeRef, navRef) {
  return function (url, opts) {
    const u = String(url);
    const method = (opts && opts.method) || 'GET';

    if (u.indexOf('/api/store') === 0 && method === 'GET') {
      return Promise.resolve(jsonRes({ ok: true, rev: storeRef.rev || 0, data: storeRef.data }));
    }
    if (u.indexOf('/api/store') === 0 && method === 'POST') {
      try {
        const body = JSON.parse(opts.body);
        if (typeof body.rev === 'number' && typeof storeRef.rev === 'number' && body.rev !== storeRef.rev) {
          return Promise.resolve(jsonRes({ ok: false, conflict: true, rev: storeRef.rev, data: storeRef.data }));
        }
        storeRef.data = body;
        storeRef.rev = (storeRef.rev || 0) + 1;
      } catch (e) {}
      return Promise.resolve(jsonRes({ ok: true, rev: storeRef.rev }));
    }
    if (u.indexOf('/api/nav') === 0) {
      const qm = u.match(/code=(\d+)/);
      if (method === 'GET') {
        return Promise.resolve(jsonRes({ ok: true, data: { funds: navRef.funds } }));
      }
      if (method === 'POST') {
        const body = JSON.parse(opts.body);
        if (qm) navRef.funds[qm[1]] = body;
        else navRef.funds = body.funds || {};
        return Promise.resolve(jsonRes({ ok: true }));
      }
      if (method === 'DELETE') {
        if (qm) delete navRef.funds[qm[1]];
        else navRef.funds = {};
        return Promise.resolve(jsonRes({ ok: true }));
      }
    }
    if (u.indexOf('/api/fund/search') === 0) {
      return Promise.resolve(jsonRes(SEARCH_RESULT));
    }
    if (u.indexOf('/api/fund/nav') === 0) {
      return Promise.resolve(jsonRes(FUND_DETAIL));
    }
    return Promise.resolve(jsonRes({ ok: false, error: '未模拟的接口: ' + u }));
  };
}
function jsonRes(obj) {
  return { ok: true, status: 200, json: () => Promise.resolve(obj) };
}

/* ---------- 启动 jsdom ---------- */
const storeRef = { data: null, rev: 0 };   // 记录文件（服务端初始为空）
const navRef = { funds: {} };              // 净值缓存文件（服务端初始为空）

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://127.0.0.1:8765/',
  virtualConsole: vc,
  beforeParse(window) {
    window.fetch = makeFetch(storeRef, navRef);
    window.AbortController = window.AbortController || function () {
      this.signal = {}; this.abort = function () {};
    };
    // 模拟 matchMedia
    window.matchMedia = window.matchMedia || function () {
      return { matches: false, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} };
    };
  }
});

const { window } = dom;
const doc = window.document;

/* ---------- 等待初始化完成 ---------- */
function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

(async function main() {
  console.log('\n' + '='.repeat(58));
  console.log('  运行时验证（jsdom 真实加载）');
  console.log('='.repeat(58));

  // 等待 boot() 的 Promise 链完成（Store.init → save → refreshAll → loadFundNav）
  await wait(1500);

  console.log('\n【1】初始化与首屏渲染');

  check('document.readyState = complete', doc.readyState === 'complete', doc.readyState);

  const todayZone = doc.getElementById('todayZone');
  check('todayZone 有内容（非空白首屏）',
        todayZone && todayZone.innerHTML.trim().length > 0,
        'len=' + (todayZone ? todayZone.innerHTML.length : 'null'));

  const recRows = doc.querySelectorAll('#recBody tr');
  check('买入记录表已渲染（示例数据）', recRows.length > 0, 'rows=' + recRows.length);

  const recCount = doc.getElementById('recCount');
  check('记录数文案已更新', recCount && /\d+\s*笔/.test(recCount.textContent),
        recCount ? recCount.textContent : 'null');

  check('示例数据已写入存储（含 5 条：4 买 1 卖）',
        storeRef.data && storeRef.data.records && storeRef.data.records.length === 5 &&
        storeRef.data.records.filter(function (r) { return r.type === 'sell'; }).length === 1,
        storeRef.data && storeRef.data.records ? 'records=' + storeRef.data.records.length : 'no store');

  const fundMeta = doc.getElementById('fundMeta');
  check('基金信息条已显示', fundMeta && (fundMeta.getAttribute('class') || '').indexOf('show') >= 0);

  console.log('\n【1b】我的基金表格');

  const fundRows = doc.querySelectorAll('#fundBody tr');
  check('基金表格行已渲染（示例基金）', fundRows.length >= 1, 'rows=' + fundRows.length);
  if (fundRows.length) {
    const rowText = fundRows[0].textContent;
    check('行含基金名与代码',
          rowText.indexOf('易方达消费行业股票') >= 0 && rowText.indexOf('110022') >= 0,
          rowText.slice(0, 80));
    check('当前基金行高亮',
          (fundRows[0].getAttribute('class') || '').indexOf('current') >= 0,
          fundRows[0].getAttribute('class'));
    check('行含百分比数值（盈亏/回撤）', /[-+]?\d+(\.\d+)?%/.test(rowText), rowText.slice(0, 100));
    check('行可拖拽（手动排序模式）', fundRows[0].getAttribute('draggable') === 'true');
  }
  const fundHead = doc.querySelector('#fundTable thead');
  check('表头含浮动盈亏与最大回撤列',
        !!fundHead && fundHead.textContent.indexOf('浮动盈亏') >= 0 &&
        fundHead.textContent.indexOf('成立以来最大回撤') >= 0,
        fundHead ? fundHead.textContent.slice(0, 80) : 'null');
  check('启动自动升级标记已写入净值缓存',
        !!(navRef.funds['110022'] && navRef.funds['110022'].full === true),
        navRef.funds['110022'] ? 'full=' + navRef.funds['110022'].full : 'no fund');
  check('记录文件只存记录，不再夹带净值缓存',
        !!(storeRef.data && !storeRef.data.funds && Array.isArray(storeRef.data.records)),
        storeRef.data ? Object.keys(storeRef.data).join(',') : 'no store');
  check('净值缓存已写入服务端（含累计净值字段），且数据量不落 localStorage',
        !!(navRef.funds['110022'] && navRef.funds['110022'].points.length > 0 &&
           navRef.funds['110022'].points[0].ac != null),
        navRef.funds['110022'] ? JSON.stringify(navRef.funds['110022'].points[0]) : 'no points');
  {
    const ls = window.localStorage.getItem('wb_fund_workbench_records_v2');
    let lsObj = null;
    try { lsObj = ls ? JSON.parse(ls) : null; } catch (e) {}
    check('localStorage 兜底只存记录（体积可控）',
          !!(lsObj && Array.isArray(lsObj.records) && !lsObj.funds),
          ls ? 'len=' + ls.length : 'empty');
  }

  console.log('\n【2】图表渲染');

  const chartSvg = doc.getElementById('chartSvg');
  const chartEmpty = doc.getElementById('chartEmpty');
  const svgCls = chartSvg ? (chartSvg.getAttribute('class') || '') : '';
  check('图表 SVG 未隐藏', svgCls.indexOf('hidden') < 0, svgCls);
  check('图表 viewBox 已紧凑化（320）',
        (chartSvg.getAttribute('viewBox') || '').indexOf('900 320') >= 0,
        chartSvg.getAttribute('viewBox'));
  const empCls = chartEmpty ? (chartEmpty.getAttribute('class') || '') : '';
  check('空状态已隐藏', empCls.indexOf('hidden') >= 0, empCls);

  const paths = doc.querySelectorAll('#chartSvg path');
  check('净值曲线 path 已绘制', paths.length >= 2, 'paths=' + paths.length);

  const markers = doc.querySelectorAll('#chartSvg [data-marker]');
  check('买入点标记已绘制', markers.length > 0, 'markers=' + markers.length);

  const texts = doc.querySelectorAll('#chartSvg text');
  check('轴刻度与标签已绘制', texts.length >= 8, 'texts=' + texts.length);

  // 检查标注文字里是否有百分比
  let svgText = '';
  texts.forEach((t) => { svgText += t.textContent + '|'; });
  check('买入点标注含涨跌幅百分比', /[-+]?\d+(\.\d+)?%/.test(svgText) || /基准/.test(svgText),
        svgText.slice(0, 120));

  const legend = doc.getElementById('chartLegend');
  check('图例已渲染', legend && legend.textContent.indexOf('基金净值') >= 0,
        legend ? legend.textContent.slice(0, 60) : 'null');
  check('图例含均线与卖出点',
        legend && legend.textContent.indexOf('15日均线') >= 0 &&
        legend.textContent.indexOf('60日均线') >= 0 && legend.textContent.indexOf('卖出点') >= 0,
        legend ? legend.textContent.slice(0, 120) : 'null');

  const ma15Path = doc.querySelector('#chartSvg path[stroke="#ffb020"]');
  const ma60Path = doc.querySelector('#chartSvg path[stroke="#b57bff"]');
  check('MA15 均线已绘制（琥珀色虚线）', !!ma15Path && (ma15Path.getAttribute('stroke-dasharray') || '') !== '');
  check('MA60 均线已绘制（紫色虚线）', !!ma60Path && (ma60Path.getAttribute('stroke-dasharray') || '') !== '');
  const sellMarker = doc.querySelector('#chartSvg rect[data-marker]');
  check('卖出点以菱形标记绘制', !!sellMarker);

  console.log('\n【3】数据概览');

  const statCards = doc.querySelectorAll('#statGrid .stat');
  check('概览卡片 3 张（已精简）', statCards.length === 3, 'cards=' + statCards.length);
  if (statCards.length === 3) {
    const vals = [];
    statCards.forEach((c) => vals.push(c.textContent.replace(/\s+/g, ' ').trim()));
    console.log('     ' + vals.join('\n     '));
    check('无持有市值卡片', vals.join(' ').indexOf('持有市值') < 0);
    check('投入本金已计算（含 ¥）', /¥[\d,]+/.test(vals[1]));
    check('浮动盈亏显示百分比', /[-+]?\d+(\.\d+)?%/.test(vals[2]), vals[2]);
    check('浮动盈亏不显示金额（无 ¥）', vals[2].indexOf('¥') < 0, vals[2]);
  }

  console.log('\n【4】运行时错误');

  const realErrors = errors.filter((e) =>
    !/Not implemented|Could not parse CSS|css parsing/i.test(e));
  check('无 JS 运行时异常', realErrors.length === 0,
        realErrors.length ? realErrors.slice(0, 3).join(' || ') : '');

  console.log('\n【5】交互：切换区间');

  const rangeBtns = doc.querySelectorAll('.range-btn');
  check('区间按钮 8 个（近1月~近10年+全部）', rangeBtns.length === 8, 'btns=' + rangeBtns.length);

  const btn90 = doc.querySelector('.range-btn[data-range="90"]');
  if (btn90) {
    btn90.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(120);
    check('切换近3月后按钮 active 状态正确',
          (btn90.getAttribute('class') || '').indexOf('active') >= 0, btn90.getAttribute('class'));
    const markers90 = doc.querySelectorAll('#chartSvg [data-marker]');
    console.log('     近3月标记数:', markers90.length, '（全周期:', markers.length, '）');
    check('切换区间后图表重新渲染未报错',
          doc.querySelectorAll('#chartSvg path').length >= 2);
  }

  console.log('\n【6】交互：添加买入记录');

  const before = doc.querySelectorAll('#recBody tr').length;
  const dateInput = doc.getElementById('recDate');
  const amountInput = doc.getElementById('recAmount');
  const noteInput = doc.getElementById('recNote');
  const addBtn = doc.getElementById('btnAddRec');

  if (dateInput && amountInput && addBtn) {
    dateInput.value = '2026-06-15';
    amountInput.value = '1500';
    noteInput.value = '运行时测试';
    addBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(300);

    const after = doc.querySelectorAll('#recBody tr').length;
    check('添加记录后表格行数 +1', after === before + 1, 'before=' + before + ' after=' + after);
    check('新记录已持久化到存储',
          storeRef.data && storeRef.data.records.some((r) => r.note === '运行时测试'));

    // 表格按日期倒序，新记录（2026-06-15）应在 09-02 那笔之后，逐行查找
    let allRowsText = '';
    doc.querySelectorAll('#recBody tr').forEach((tr) => { allRowsText += tr.textContent + '\n'; });
    check('新记录行存在于表格中', allRowsText.indexOf('运行时测试') >= 0,
          'rows=' + after);
    check('新记录行包含日期', allRowsText.indexOf('2026-06-15') >= 0);
    check('新记录行包含金额', /1,?500/.test(allRowsText));
    check('新记录行带买入类型徽章', allRowsText.indexOf('买入') >= 0);
    check('新记录行含涨跌幅标注', /[-+]?\d+(\.\d+)?%/.test(allRowsText) || /基准/.test(allRowsText));

    // 倒序校验：第一行应为日期最大那条（09-02 示例数据）
    const firstRow = doc.querySelector('#recBody tr');
    const firstDate = firstRow ? (firstRow.querySelector('td') || {}).textContent : '';
    check('表格倒序（首行为最新日期）', /^2026-09-/.test(String(firstDate).trim()),
          'firstDate=' + firstDate);
  } else {
    check('表单元素齐全', false, 'missing inputs');
  }

  console.log('\n【7】交互：切换基金（不同基金记录隔离）');

  const fundInput = doc.getElementById('fundInput');
  const loadBtn = doc.getElementById('btnLoadFund');
  if (fundInput && loadBtn) {
    // 模拟加载同一只基金（接口固定返回 110022）
    fundInput.value = '110022';
    loadBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(500);
    check('重新加载基金未报错',
          doc.querySelectorAll('#chartSvg path').length >= 2);
    check('重新加载后仍无 JS 异常',
          errors.filter((e) => !/Not implemented|Could not parse CSS/i.test(e)).length === 0);
  }

  console.log('\n【7b】批量管理');

  const btnBatchMode = doc.getElementById('btnBatchMode');
  check('批量管理按钮存在', !!btnBatchMode);
  if (btnBatchMode) {
    btnBatchMode.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(150);

    check('批量面板显示', (doc.getElementById('batchPane').getAttribute('class') || '').indexOf('hidden') < 0);
    check('普通表格隐藏', (doc.getElementById('recTableWrap').getAttribute('class') || '').indexOf('hidden') >= 0);
    check('录入表单隐藏', (doc.getElementById('recFormRow').getAttribute('class') || '').indexOf('hidden') >= 0);

    const totalRecs = storeRef.data.records.length;
    const batchRows = doc.querySelectorAll('#batchBody tr');
    check('批量表格列出全部基金记录', batchRows.length === totalRecs,
          'rows=' + batchRows.length + ' records=' + totalRecs);
    const bRow0 = batchRows[0];
    check('批量表格行含类型徽章', !!bRow0 && /买入|卖出/.test(bRow0.textContent),
          bRow0 ? bRow0.textContent.slice(0, 60) : 'null');

    const cb = batchRows[0] ? batchRows[0].querySelector('input[type="checkbox"]') : null;
    check('复选框存在', !!cb);
    if (cb) {
      cb.checked = true;
      cb.dispatchEvent(new window.Event('change', { bubbles: true }));
      await wait(80);
      check('勾选后计数为 1', doc.getElementById('batchCount').textContent === '1',
            doc.getElementById('batchCount').textContent);
      check('批量操作按钮激活', doc.getElementById('btnBatchDel').disabled === false);
    }

    const filter = doc.getElementById('batchFilter');
    check('筛选下拉含全部基金选项', filter && filter.options.length >= 2,
          filter ? 'options=' + filter.options.length : 'null');

    doc.getElementById('btnBatchAll').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(80);
    check('全选后计数=总记录数',
          parseInt(doc.getElementById('batchCount').textContent, 10) === totalRecs,
          doc.getElementById('batchCount').textContent);

    doc.getElementById('btnBatchNone').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(80);
    check('清除选择后计数为 0', doc.getElementById('batchCount').textContent === '0');
    check('无选择时批量按钮禁用', doc.getElementById('btnBatchDel').disabled === true);

    btnBatchMode.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(120);
    check('退出批量后普通表格恢复', (doc.getElementById('recTableWrap').getAttribute('class') || '').indexOf('hidden') < 0);
    check('退出批量后录入表单恢复', (doc.getElementById('recFormRow').getAttribute('class') || '').indexOf('hidden') < 0);
  }

  console.log('\n【7c】批量新增（多基金批量买入/卖出）');

  const btnBulkMode = doc.getElementById('btnBulkMode');
  check('批量新增按钮存在', !!btnBulkMode);
  if (btnBulkMode) {
    btnBulkMode.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(150);
    check('批量新增面板显示', (doc.getElementById('bulkPane').getAttribute('class') || '').indexOf('hidden') < 0);
    check('普通表格隐藏', (doc.getElementById('recTableWrap').getAttribute('class') || '').indexOf('hidden') >= 0);

    let fundCbs = doc.querySelectorAll('#bulkFundChecks input[type="checkbox"]');
    const bulkSel = fundCbs.length;
    check('基金勾选列表已渲染', bulkSel >= 1, 'n=' + bulkSel);

    const beforeBulkBuy = storeRef.data.records.length;
    fundCbs.forEach((cb) => { cb.checked = true; cb.dispatchEvent(new window.Event('change', { bubbles: true })); });
    await wait(80);
    check('已选计数=基金数', doc.getElementById('bulkCount').textContent === String(bulkSel),
          doc.getElementById('bulkCount').textContent);

    doc.getElementById('bulkDate').value = '2026-06-20';
    doc.getElementById('bulkAmount').value = '200';
    doc.getElementById('btnBulkSubmit').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(350);
    check('批量买入：记录数 +基金数',
          storeRef.data.records.length === beforeBulkBuy + bulkSel,
          'before=' + beforeBulkBuy + ' after=' + storeRef.data.records.length);
    const addedBuy = storeRef.data.records.filter((r) => r.date === '2026-06-20' && r.amount === 200);
    check('批量买入：新记录类型/金额正确',
          addedBuy.length === bulkSel && addedBuy.every((r) => r.type === 'buy'));

    // 切换为批量卖出再提交一次
    fundCbs = doc.querySelectorAll('#bulkFundChecks input[type="checkbox"]');
    fundCbs.forEach((cb) => { cb.checked = true; cb.dispatchEvent(new window.Event('change', { bubbles: true })); });
    const sellSegBtn = doc.querySelector('#bulkTypeSeg .seg-btn[data-type="sell"]');
    sellSegBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(60);
    check('切换到批量卖出态', sellSegBtn.classList.contains('active'));
    doc.getElementById('bulkDate').value = '2026-06-21';
    doc.getElementById('bulkAmount').value = '100';
    doc.getElementById('btnBulkSubmit').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(350);
    const addedSell = storeRef.data.records.filter((r) => r.date === '2026-06-21' && r.amount === 100);
    check('批量卖出：新记录类型/金额正确',
          addedSell.length === bulkSel && addedSell.every((r) => r.type === 'sell'),
          'sellAdded=' + addedSell.length);

    btnBulkMode.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(120);
    check('退出批量新增后普通表格恢复', (doc.getElementById('recTableWrap').getAttribute('class') || '').indexOf('hidden') < 0);
  }

  console.log('\n【8】内存与性能');

  check('净值点数在合理范围（<1500）', DEMO_POINTS.length < 1500, 'points=' + DEMO_POINTS.length);
  const svgLen = chartSvg ? chartSvg.innerHTML.length : 0;
  check('SVG 体积合理（<400KB）', svgLen < 400000, 'svgLen=' + svgLen);

  console.log('\n【9】批量删除全流程');

  const delModeBtn = doc.getElementById('btnBatchMode');
  const before9 = storeRef.data.records.length;
  delModeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(150);
  const rows9 = doc.querySelectorAll('#batchBody tr');
  const cb9 = rows9[0] ? rows9[0].querySelector('input[type="checkbox"]') : null;
  check('批量模式可再进入且有待删记录', !!cb9);
  if (cb9) {
    cb9.checked = true;
    cb9.dispatchEvent(new window.Event('change', { bubbles: true }));
    await wait(80);
    doc.getElementById('btnBatchDel').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(120);
    check('删除前弹出二次确认',
          (doc.getElementById('modalLayer').getAttribute('class') || '').indexOf('show') >= 0);
    doc.getElementById('modalConfirm').dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
    await wait(350);
    check('确认后记录数 -1', storeRef.data.records.length === before9 - 1,
          'before=' + before9 + ' after=' + storeRef.data.records.length);
    check('批量表格行数同步', doc.querySelectorAll('#batchBody tr').length === before9 - 1);
    check('删除后计数归零', doc.getElementById('batchCount').textContent === '0');
  }
  delModeBtn.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(120);

  console.log('\n' + '='.repeat(58));
  console.log('  运行时验证：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('='.repeat(58) + '\n');

  window.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => {
  console.error('验证脚本异常:', e);
  process.exit(1);
});
