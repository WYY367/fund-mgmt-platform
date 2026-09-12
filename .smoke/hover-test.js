/**
 * 悬停交互专项测试 v1.3：十字准线 + 浮层（日期/净值/区间最大回撤/均线/买卖点）
 * 数据相对「今天」生成：70 个铺垫日 + 最近 4 个关键日（3 买 1 卖），
 * 保证「近1月」区间能覆盖关键日。
 * 用法：NODE_PATH=... node hover-test.js
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

const DAY = 24 * 3600 * 1000;
const NOW = new Date();
const localDate = (ts) => {
  const d = new Date(ts);
  const m = d.getMonth() + 1, day = d.getDate();
  return d.getFullYear() + '-' + (m < 10 ? '0' + m : m) + '-' + (day < 10 ? '0' + day : day);
};

// 70 个铺垫日（今天-74 ~ 今天-5）：1.0 缓涨到 1.9（都低于高点 2.2）
const POINTS = [];
for (let i = 74; i >= 5; i--) {
  const ts = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - i).getTime();
  const nv = 1.0 + ((74 - i) / 69) * 0.9;
  POINTS.push({ ts: ts, nav: Number(nv.toFixed(4)), daily: 0.5 });
}
// 关键 4 日：今天-4 买入基准 2.0 / 今天-3 区间新高 2.2 / 今天-2 回撤 1.65 / 今天-1 最新 2.2（卖出日）
const KEY = [
  { off: 4, nav: 2.0, daily: 1.0 },
  { off: 3, nav: 2.2, daily: 10.0 },
  { off: 2, nav: 1.65, daily: -25.0 },
  { off: 1, nav: 2.2, daily: 33.3 }
];
for (const k of KEY) {
  const ts = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - k.off).getTime();
  POINTS.push({ ts: ts, nav: k.nav, daily: k.daily });
}
POINTS.sort((a, b) => a.ts - b.ts);
const LAST = POINTS[POINTS.length - 1];

const keyDate = (off) => localDate(new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate() - off).getTime());
const D_BASE = keyDate(4), D_HIGH = keyDate(3), D_LOW = keyDate(2), D_SELL = keyDate(1);
const MID_DATE = keyDate(40); // 铺垫区间中段

const FUND = {
  ok: true,
  data: { code: '888888', name: '回撤测试基金', points: POINTS, acPoints: [], updatedAt: LAST.ts, full: true }
};

const store = {
  version: 1,
  funds: { '888888': { code: '888888', name: '回撤测试基金', points: POINTS, full: true } },
  records: [
    { id: 'b1', code: '888888', type: 'buy', date: D_BASE, amount: 1000, note: '基准', createdAt: 1 },
    { id: 'b2', code: '888888', type: 'buy', date: D_HIGH, amount: 1000, note: '高点买入', createdAt: 2 },
    { id: 'b3', code: '888888', type: 'buy', date: D_LOW, amount: 1000, note: '回撤买入', createdAt: 3 },
    { id: 's1', code: '888888', type: 'sell', date: D_SELL, amount: 800, note: '部分止盈', createdAt: 4 }
  ],
  currentCode: '888888'
};

const vc = new VirtualConsole();
vc.on('jsdomError', () => {});
['warn', 'log', 'info', 'debug', 'error'].forEach((k) => vc.on(k, () => {}));

const dom = new JSDOM(html, {
  runScripts: 'dangerously',
  pretendToBeVisual: true,
  url: 'http://127.0.0.1:8765/',
  virtualConsole: vc,
  beforeParse(window) {
    window.fetch = function (url, o) {
      const u = String(url);
      const m = (o && o.method) || 'GET';
      if (u.indexOf('/api/store') === 0 && m === 'GET')
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, data: store }) });
      if (u.indexOf('/api/store') === 0 && m === 'POST')
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      if (u.indexOf('/api/fund/nav') === 0)
        return Promise.resolve({ ok: true, json: () => Promise.resolve(FUND) });
      return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true, data: [] }) });
    };
    window.AbortController = window.AbortController || function () { this.signal = {}; this.abort = function () {}; };
  }
});

(async function main() {
  console.log('\n' + '='.repeat(58));
  console.log('  悬停交互专项测试 v1.3（十字准线 + 回撤 + 均线 + 买卖点）');
  console.log('='.repeat(58));
  await wait(1300);

  const { window } = dom;
  const doc = window.document;
  const svg = doc.getElementById('chartSvg');
  const popup = doc.getElementById('popup');

  svg.getBoundingClientRect = function () {
    return { left: 0, top: 0, width: 900, height: 320, right: 900, bottom: 320 };
  };

  const padL = 62, plotW = 812;
  const tsMin = POINTS[0].ts, tsMax = LAST.ts;
  // rangeDays=null 用全区间；否则按 sliceByRange 的切法推算该区间的 tsMin/tsMax
  function xOfDateIn(ds, rangeDays) {
    let lo = tsMin, hi = tsMax;
    if (rangeDays != null) {
      const cutoff = Date.now() - rangeDays * DAY;
      const inRange = POINTS.filter((p) => p.ts >= cutoff);
      const use = inRange.length >= 2 ? inRange : POINTS.slice(-2);
      lo = use[0].ts;
      hi = use[use.length - 1].ts;
    }
    return padL + ((new Date(ds + 'T00:00:00').getTime() - lo) / (hi - lo)) * plotW;
  }

  function move(ds, clientY) {
    svg.dispatchEvent(new window.MouseEvent('mousemove', {
      bubbles: true, clientX: xOfDateIn(ds, null), clientY: clientY == null ? 100 : clientY
    }));
  }
  function moveIn(ds, rangeDays, clientY) {
    svg.dispatchEvent(new window.MouseEvent('mousemove', {
      bubbles: true, clientX: xOfDateIn(ds, rangeDays), clientY: clientY == null ? 100 : clientY
    }));
  }

  /* ---- 1. 绘制层：均线 / 卖出标记 ---- */
  console.log('\n【1】绘制层');
  const ma15Path = doc.querySelector('#chartSvg path[stroke="#ffb020"]');
  const ma60Path = doc.querySelector('#chartSvg path[stroke="#b57bff"]');
  check('MA15 琥珀色虚线已绘制', !!ma15Path && (ma15Path.getAttribute('stroke-dasharray') || '') !== '');
  check('MA60 紫色虚线已绘制', !!ma60Path && (ma60Path.getAttribute('stroke-dasharray') || '') !== '');
  check('卖出菱形标记已绘制', !!doc.querySelector('#chartSvg rect[data-marker]'));
  check('买入圆点标记 3 个', doc.querySelectorAll('#chartSvg circle[data-marker]').length === 3,
        'n=' + doc.querySelectorAll('#chartSvg circle[data-marker]').length);

  /* ---- 2. 悬停普通净值点（区间回撤 + 均线） ---- */
  console.log('\n【2】悬停普通点（日期/净值/区间回撤/均线）');
  move(MID_DATE);
  await wait(50);
  check('浮层已显示', popup.classList.contains('show'));
  let h = popup.innerHTML;
  check('显示日期 ' + MID_DATE, h.indexOf(MID_DATE) >= 0, h.slice(0, 160));
  check('显示最大回撤行', h.indexOf('最大回撤') >= 0);
  check('显示 15日均线行', h.indexOf('15日均线') >= 0);
  check('显示 60日均线行', h.indexOf('60日均线') >= 0);
  // 中段处 MA15 已成线；MA60 窗口（60 日）尚不足 → 显示 —（正确行为）
  check('MA15 值有数值', /15日均线<\/span><span class="popup-val">\d/.test(h), h.slice(-260));
  check('MA60 窗口不足时显示 —', /60日均线<\/span><span class="popup-val">—/.test(h), h.slice(-260));

  /* ---- 3. 区间回撤语义：区间高点处 0，跌 25% 处 -25% ---- */
  console.log('\n【3】区间回撤计算');
  move(D_HIGH);
  await wait(50);
  h = popup.innerHTML;
  check('区间新高(' + D_HIGH + ')处回撤 = 0.00%',
        /最大回撤<\/span><span class="popup-val val-\w+">0\.00%/.test(h), h.slice(-260));
  move(D_LOW);
  await wait(50);
  h = popup.innerHTML;
  check('回撤 -25.00% 处正确', h.indexOf('-25.00%') >= 0, h.slice(-260));

  /* ---- 4. 悬停卖出点 ---- */
  console.log('\n【4】悬停卖出点');
  move(D_SELL);
  await wait(50);
  h = popup.innerHTML;
  check('识别为卖出点', h.indexOf('卖出点') >= 0);
  check('显示卖出金额 ¥800', /¥800(\.00)?/.test(h), h.slice(0, 200));
  check('显示剩余份额', h.indexOf('剩余份额') >= 0);
  check('含最大回撤与均线', h.indexOf('最大回撤') >= 0 && h.indexOf('15日均线') >= 0);

  /* ---- 5. 移出 / 离开 ---- */
  console.log('\n【5】移出与离开');
  move(MID_DATE);
  await wait(30);
  svg.dispatchEvent(new window.MouseEvent('mousemove', { bubbles: true, clientX: 10, clientY: 100 }));
  await wait(30);
  check('移出绘图区浮层隐藏', !popup.classList.contains('show'));
  move(MID_DATE);
  await wait(30);
  svg.dispatchEvent(new window.MouseEvent('mouseleave', { bubbles: false }));
  await wait(30);
  check('mouseleave 后浮层隐藏', !popup.classList.contains('show'));

  /* ---- 6. 切换区间后回撤按新区间重算 ---- */
  console.log('\n【6】切换区间后回撤重算');
  const btn30 = doc.querySelector('.range-btn[data-range="30"]');
  btn30.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(150);
  // 近1月：用该区间自己的坐标映射悬停（切区间后 tsMin/tsMax 变了）
  moveIn(D_HIGH, 30);
  await wait(50);
  h = popup.innerHTML;
  check('近1月区间下高点回撤仍为 0.00%',
        /最大回撤<\/span><span class="popup-val val-\w+">0\.00%/.test(h), h.slice(-300));
  moveIn(D_LOW, 30);
  await wait(50);
  h = popup.innerHTML;
  check('近1月区间下回撤仍为 -25.00%', h.indexOf('-25.00%') >= 0, h.slice(-300));
  check('近1月区间下 MA60 有数值', /60日均线<\/span><span class="popup-val">\d/.test(h), h.slice(-300));
  const btnAll = doc.querySelector('.range-btn[data-range="all"]');
  btnAll.dispatchEvent(new window.MouseEvent('click', { bubbles: true }));
  await wait(120);

  console.log('\n' + '='.repeat(58));
  console.log('  悬停交互测试：通过 ' + pass + ' 项，失败 ' + fail + ' 项');
  console.log('='.repeat(58) + '\n');
  window.close();
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('测试异常:', e); process.exit(1); });
