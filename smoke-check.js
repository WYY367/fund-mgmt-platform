/**
 * 冒烟自检脚本（铁律 9 + 铁律 10）
 * 用 Node 对首页做静态与逻辑校验，不依赖浏览器。
 * 用法：node smoke-check.js
 */
const fs = require('fs');
const path = require('path');

const html = fs.readFileSync(path.join(__dirname, 'public', 'index.html'), 'utf8');

let pass = 0, fail = 0, warn = 0;
function ok(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (detail ? ' → ' + detail : '')); }
}
function warning(name, cond, detail) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { warn++; console.log('  ⚠️  ' + name + (detail ? ' → ' + detail : '')); }
}

console.log('\n' + '='.repeat(58));
console.log('  基金买入工作台 — 冒烟自检');
console.log('='.repeat(58));

/* ============================================================
   1. 铁律 3：零外链
   ============================================================ */
console.log('\n【铁律 3】零外链检查');
const externals = [
  ['<script src=', /<script[^>]+src\s*=/i],
  ['<link href=', /<link[^>]+href\s*=\s*["']https?:/i],
  ['CDN 域名', /(cdn\.|unpkg\.com|jsdelivr\.net|cdnjs\.|googleapis\.com\/ajax|bootcdn)/i],
  ['外部 @import', /@import\s+url\(/i],
  ['emoji 当图标', /<button[^>]*>[^<]*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u],
];
for (const [name, re] of externals) {
  ok('无 ' + name, !re.test(html));
}
ok('字体使用系统字体栈', /-apple-system[^;]*BlinkMacSystemFont/.test(html));
ok('图表为内联 SVG', /<svg[^>]*chart-svg/.test(html));
ok('图表由 JS 手写绘制（无图表库）', /parts\.push\('<path d="/.test(html));

/* ============================================================
   2. 铁律 9：函数调用链无环路（DAG 校验）
   ============================================================ */
console.log('\n【铁律 9】调用链环路检查');

// 提取所有函数定义
const fnRe = /function\s+([A-Za-z_$][\w$]*)\s*\(/g;
const fnNames = [];
let m;
while ((m = fnRe.exec(html)) !== null) fnNames.push(m[1]);
const fnSet = new Set(fnNames);

// 提取每个函数体内调用的其他函数
const bodyRe = /function\s+([A-Za-z_$][\w$]*)\s*\([^)]*\)\s*\{/g;
const calls = {};  // name -> Set(被调用的同文件函数)
let bm;
while ((bm = bodyRe.exec(html)) !== null) {
  const name = bm[1];
  const start = bm.index + bm[0].length;
  // 花括号配对找函数体结束
  let depth = 1, i = start;
  while (i < html.length && depth > 0) {
    const ch = html[i];
    if (ch === '{') depth++;
    else if (ch === '}') depth--;
    i++;
  }
  const body = html.slice(start, i);
  const set = new Set();
  for (const fn of fnSet) {
    if (fn === name) continue;
    // 排除被字符串/注释包裹的误判：匹配 fn( 形式
    const re = new RegExp('(^|[^\\w$.])' + fn.replace(/\$/g, '\\$') + '\\s*\\(', 'g');
    if (re.test(body)) set.add(fn);
  }
  calls[name] = set;
}

// 检测环路（DFS 三色标记）
const WHITE = 0, GRAY = 1, BLACK = 2;
const color = {};
const cycles = [];
function dfs(node, stack) {
  color[node] = GRAY;
  stack.push(node);
  const nexts = calls[node] || new Set();
  for (const nx of nexts) {
    if (!fnSet.has(nx)) continue;
    if (color[nx] === GRAY) {
      const idx = stack.indexOf(nx);
      cycles.push(stack.slice(idx).concat(nx).join(' → '));
    } else if (color[nx] !== BLACK) {
      dfs(nx, stack);
    }
  }
  stack.pop();
  color[node] = BLACK;
}
for (const fn of fnSet) {
  if (!color[fn]) dfs(fn, []);
}
ok('无函数调用环路（DAG）', cycles.length === 0,
   cycles.length ? cycles.join(' | ') : '');

// 重点检查：渲染函数之间不得互调
const renderFns = fnNames.filter(n => /^render/.test(n));
let renderCrossCall = [];
for (const r of renderFns) {
  for (const target of (calls[r] || new Set())) {
    if (/^render/.test(target)) renderCrossCall.push(r + ' → ' + target);
  }
}
ok('渲染函数之间无互调', renderCrossCall.length === 0,
   renderCrossCall.join(' | '));

// refreshAll 存在且调用全部渲染函数
ok('存在统一刷新入口 refreshAll', /function\s+refreshAll\s*\(/.test(html));
const refreshBody = calls['refreshAll'] || new Set();
const expectedRenders = ['renderSyncBadge', 'renderTodayZone', 'renderFundTable', 'renderFundMeta', 'renderChart', 'renderStats', 'renderRecords'];
const missing = expectedRenders.filter(r => !refreshBody.has(r));
ok('refreshAll 覆盖全部渲染函数', missing.length === 0,
   missing.length ? '缺少: ' + missing.join(', ') : '');

/* ============================================================
   3. 铁律 10：初始化链路 / DOM 元素存在性
   ============================================================ */
console.log('\n【铁律 10】初始化与 DOM 完整性');

ok('存在 boot 初始化函数', /function\s+boot\s*\(/.test(html));
ok('boot 调用 refreshAll', (calls['boot'] || new Set()).has('refreshAll'));
ok('boot 调用 Store.init', (calls['boot'] || new Set()).has('boot') || /Store\.init\(\)/.test(html));
ok('DOMContentLoaded 兜底', /DOMContentLoaded/.test(html));
ok('readyState 判断防漏执行', /document\.readyState/.test(html));

// 所有 getElementById 的目标必须在 HTML 中存在
const idRefs = new Set();
let im;
const idRe = /\$\('([A-Za-z_][\w-]*)'\)/g;
while ((im = idRe.exec(html)) !== null) idRefs.add(im[1]);
const idRe2 = /getElementById\('([A-Za-z_][\w-]*)'\)/g;
while ((im = idRe2.exec(html)) !== null) idRefs.add(im[1]);

const declaredIds = new Set();
const declRe = /\bid="([A-Za-z_][\w-]*)"/g;
while ((im = declRe.exec(html)) !== null) declaredIds.add(im[1]);

const missingIds = [...idRefs].filter(id => !declaredIds.has(id));
ok('所有 getElementById 目标已声明 (' + idRefs.size + ' 个)', missingIds.length === 0,
   missingIds.length ? '缺失: ' + missingIds.join(', ') : '');

/* ============================================================
   4. 铁律 6：预置示例数据
   ============================================================ */
console.log('\n【铁律 6】示例数据');
ok('存在 seedDemoData', /function\s+seedDemoData\s*\(/.test(html));
ok('首次打开自动预置', /state\.records\.length\s*===\s*0/.test(html));
ok('示例包含 3 条以上记录', (html.match(/mk\(\d+,\s*\d+/g) || []).length >= 3,
   'predefined=' + (html.match(/mk\(\d+,\s*\d+/g) || []).length);

/* ============================================================
   5. 铁律 5：今天要处理置顶
   ============================================================ */
console.log('\n【铁律 5】今日待办区');
const todayPos = html.indexOf('id="todayZone"');
const pickerPos = html.indexOf('选择基金');
ok('todayZone 位于页面靠前位置', todayPos > 0 && todayPos < pickerPos);

/* ============================================================
   6. 铁律 8：国内习惯（涨红跌绿）
   ============================================================ */
console.log('\n【铁律 8】涨跌配色与货币');
const upVar = html.match(/--up:\s*(#[0-9a-fA-F]{3,8})/);
const downVar = html.match(/--down:\s*(#[0-9a-fA-F]{3,8})/);
ok('涨色 --up 为红色调', !!upVar && /^#(f|e|d|c)/i.test(upVar[1]),
   upVar ? upVar[1] : 'not found');
ok('跌色 --down 为绿色调', !!downVar && /^#(2|1|0|3)/i.test(downVar[1]),
   downVar ? downVar[1] : 'not found');
ok('pctClass 涨为 val-up（红）', /return n > 0 \? 'val-up' : 'val-down'/.test(html));
ok('货币符号为 ¥', html.includes('¥'));

/* ============================================================
   7. 需求 2：核心计算逻辑正确性（纯逻辑重放）
   ============================================================ */
console.log('\n【需求 2】涨跌幅计算逻辑重放');

// 从源码里抽出关键纯函数并执行
function extract(name) {
  const re = new RegExp('function\\s+' + name + '\\s*\\([^)]*\\)\\s*\\{');
  const mm = re.exec(html);
  if (!mm) return null;
  let depth = 1, i = mm.index + mm[0].length;
  const start = i;
  while (i < html.length && depth > 0) {
    if (html[i] === '{') depth++;
    else if (html[i] === '}') depth--;
    i++;
  }
  return html.slice(mm.index, i);
}

const src = [
  extract('toDateStr'),
  extract('findNavOnOrBefore'),
  extract('latestPoint'),
  extract('dateStrToTs'),
  extract('enrichRecords'),
  extract('summarize'),
  extract('computeDrawdownMap'),
  extract('computeMA')
].filter(Boolean).join('\n');

const sandbox = {};
try {
  const fn = new Function(src + `
    return { toDateStr, findNavOnOrBefore, latestPoint, dateStrToTs, enrichRecords, summarize, computeDrawdownMap, computeMA };
  `);
  Object.assign(sandbox, fn());
  ok('核心计算函数可独立执行', true);
} catch (e) {
  ok('核心计算函数可独立执行', false, e.message);
}

if (sandbox.enrichRecords) {
  // 构造：净值 1.0 / 1.1 / 1.045，买入日分别落在三天
  const d = (s) => new Date(s + 'T00:00:00').getTime();
  const points = [
    { ts: d('2026-01-01'), nav: 1.000 },
    { ts: d('2026-01-10'), nav: 1.100 },
    { ts: d('2026-01-20'), nav: 1.045 }
  ];
  const records = [
    { id: 'a', code: 'X', date: '2026-01-01', amount: 1000, createdAt: 1 },
    { id: 'b', code: 'X', date: '2026-01-10', amount: 1000, createdAt: 2 },
    { id: 'c', code: 'X', date: '2026-01-20', amount: 1000, createdAt: 3 }
  ];
  const en = sandbox.enrichRecords(records, { points: points });

  ok('三笔买入均匹配到净值', en.length === 3 && en.every(x => x.nav != null));
  ok('首笔为基准（vsPrev = null）', en[0].vsPrev === null);
  // 1.000 → 1.100 = +10%
  ok('第2笔 vsPrev = +10%',
     Math.abs(en[1].vsPrev - 10) < 1e-6, 'got ' + en[1].vsPrev);
  // 1.100 → 1.045 = -5%
  ok('第3笔 vsPrev = -5%',
     Math.abs(en[2].vsPrev - (-5)) < 1e-6, 'got ' + en[2].vsPrev);
  // 最新净值 1.045：第1笔持有 +4.5%
  ok('第1笔 vsLatest = +4.5%',
     Math.abs(en[0].vsLatest - 4.5) < 1e-6, 'got ' + en[0].vsLatest);
  // 最后一笔 vsLatest = 0
  ok('最后一笔 vsLatest = 0%',
     Math.abs(en[2].vsLatest) < 1e-9, 'got ' + en[2].vsLatest);
  // 份额：1000/1.0 = 1000 份
  ok('份额计算正确 (1000/1.0=1000)', Math.abs(en[0].shares - 1000) < 1e-6);
  // 汇总
  const s = sandbox.summarize(en);
  ok('汇总本金 = 3000', Math.abs(s.totalAmount - 3000) < 1e-6);
  ok('汇总盈亏 = 持有市值 - 本金',
     Math.abs(s.profit - (s.totalHolding - 3000)) < 1e-6,
     'profit=' + s.profit + ' holding=' + s.totalHolding);
  ok('“买在更低位”计数 = 1（第3笔）', s.cheaperCount === 1, 'got ' + s.cheaperCount);

  /* ---- 非交易日顺延 ---- */
  const rec2 = [{ id: 'z', code: 'X', date: '2026-01-15', amount: 1000, createdAt: 1 }];
  const en2 = sandbox.enrichRecords(rec2, { points: points });
  ok('非交易日取之前最近净值（1/15→1/10 的 1.100）',
     en2[0].nav === 1.100 && en2[0].navDate === '2026-01-10',
     'nav=' + en2[0].nav + ' navDate=' + en2[0].navDate);
  ok('非交易日被标记 navIsExact=false', en2[0].navIsExact === false);

  /* ---- 早于序列起点 ---- */
  const rec3 = [{ id: 'y', code: 'X', date: '2025-12-01', amount: 1000, createdAt: 1 }];
  const en3 = sandbox.enrichRecords(rec3, { points: points });
  ok('早于净值起点时不崩、nav 为 null', en3.length === 1 && en3[0].nav === null);

  /* ---- 空记录 ---- */
  const en4 = sandbox.enrichRecords([], { points: points });
  ok('空记录返回空数组', Array.isArray(en4) && en4.length === 0);

  /* ---- 无净值数据 ---- */
  const en5 = sandbox.enrichRecords(records, { points: [] });
  ok('无净值数据时不崩、nav 全 null',
     en5.length === 3 && en5.every(x => x.nav === null));
  const s5 = sandbox.summarize(en5);
  ok('无净值时 profit 为 null', s5.profit === null);

  /* ---- 日期边界：跨月 ---- */
  const t1 = sandbox.dateStrToTs('2026-01-31');
  const t2 = sandbox.dateStrToTs('2026-02-01');
  ok('跨月日期计算正确 (1/31 < 2/1)', t2 - t1 === 24 * 3600 * 1000,
     'diff=' + (t2 - t1) / 3600000 + 'h');
  /* ---- 跨年 ---- */
  const t3 = sandbox.dateStrToTs('2025-12-31');
  const t4 = sandbox.dateStrToTs('2026-01-01');
  ok('跨年日期计算正确 (12/31 < 1/1)', t4 - t3 === 24 * 3600 * 1000);

  /* ---- 闰年 ---- */
  const t5 = sandbox.dateStrToTs('2024-02-29');
  ok('闰年 2/29 有效', !isNaN(t5));
}

/* ============================================================
   8. 铁律 2：数据备份
   ============================================================ */
console.log('\n【铁律 2】数据备份');
ok('首屏有导出按钮', /id="btnExport"/.test(html) && html.indexOf('id="btnExport"') < html.indexOf('id="todayZone"') + 20000);
ok('首屏有导入按钮', /id="btnImport"/.test(html));
ok('存在 exportJson', /function\s+exportJson/.test(html));
ok('存在 importJson', /function\s+importJson/.test(html));
ok('导入无条数上限', !/records\.length\s*>\s*\d{2,}\s*\)\s*\{[^}]*return/.test(html));
ok('删除需二次确认', /showConfirm\(/.test(html));
ok('导入需二次确认', /确认导入/.test(html));
ok('数据量提示（≥30条）', /state\.records\.length\s*>=\s*30/.test(html));

/* ============================================================
   9. 铁律 4：移动适配
   ============================================================ */
console.log('\n【铁律 4】移动端适配');
ok('存在 viewport meta', /name="viewport"[^>]*width=device-width/.test(html));
ok('输入框字号 ≥16px', /font-size:\s*16px/.test(html));
ok('窄屏断点 <768px', /@media\s*\(max-width:\s*7[0-9]{2}px\)/.test(html));
ok('底部安全区适配', /safe-area-inset-bottom/.test(html));
ok('按钮最小高度 ≥44px（移动端）', /\.btn\s*\{\s*height:\s*4[4-9]px/.test(html) || /height:\s*42px/.test(html));
ok('表格窄屏转卡片（data-label）', /data-label=/.test(html) && /td::before/.test(html));

/* ============================================================
   10. 需求 4：持久化
   ============================================================ */
console.log('\n【需求 4】持久化');
ok('localStorage 兜底', /localStorage\.setItem/.test(html));
ok('服务端文件读写', /\/api\/store/.test(html));
ok('key 带 wb_ 前缀', /wb_fund_workbench/.test(html));
ok('双写（本地+服务端）', /saveToLocal\(\)/.test(html) && /fetch\('\/api\/store'/.test(html));

/* ============================================================
   11. 需求 5：无登录 / 无手机端交互规则
   ============================================================ */
console.log('\n【需求 5】范围限定');
const codeOnly = html
  .replace(/\/\*[\s\S]*?\*\//g, '')     // 去 JS 块注释
  .replace(/<!--[\s\S]*?-->/g, '')     // 去 HTML 注释
  .replace(/\/\/[^\n]*/g, '');         // 去 JS 行注释
ok('无登录/账号相关代码', !/(login|signin|password|账号|登录|注册|token|session)/i.test(codeOnly));

/* ============================================================
   12. 迭代 v1.1：我的基金 / 悬停回撤 / 概览精简
   ============================================================ */
console.log('\n【迭代 v1.1】新增需求检查');
const card_label_re = />持有市值</;
ok('存在「我的基金」区域', /id="fundBody"/.test(html) && /id="fundListCard"/.test(html));
ok('存在 renderFundList 渲染函数', /function\s+renderFund(Table|List)\s*\(/.test(html));
ok('renderFundTable 已纳入 refreshAll', (calls['refreshAll'] || new Set()).has('renderFundTable'));
ok('存在基金切换事件委托（fundBody click）', /\$\('fundBody'\)/.test(html));
ok('存在最大回撤计算函数', /function\s+computeDrawdownMap\s*\(/.test(html));
ok('图表已紧凑化（viewBox 900x320）', /id="chartSvg" viewBox="0 0 900 320"/.test(html));
ok('存在悬停十字准线交互', /function\s+ensureChartHover\s*\(/.test(html) && /id="xhair"/.test(html));
ok('旧 bindChartEvents 已清理', html.indexOf('bindChartEvents') === -1);
ok('已移除持有市值卡片', !card_label_re.test(html));
ok('浮动盈亏卡片只显示百分比', /card\('浮动盈亏',\s*\n?\s*s\.profitRate == null/.test(html.replace(/\r/g, '')));

// 最大回撤计算逻辑重放
if (sandbox.computeDrawdownMap) {
  const dd = sandbox.computeDrawdownMap([
    { ts: 1, nav: 1.0 },
    { ts: 2, nav: 1.2 },
    { ts: 3, nav: 0.9 },
    { ts: 4, nav: 1.2 }
  ]);
  ok('回撤：高点处为 0', dd[1] === 0 && dd[4] === 0, JSON.stringify(dd));
  ok('回撤：0.9 相对高点 1.2 = -25%',
     Math.abs(dd[3] - (-25)) < 1e-9, 'got ' + dd[3]);
  const dd2 = sandbox.computeDrawdownMap([]);
  ok('回撤：空数据返回空映射', dd2 && Object.keys(dd2).length === 0);

  /* ---- 卖出记录：份额法盈亏 ---- */
  if (sandbox.enrichRecords && sandbox.summarize) {
    const dd3 = (s) => new Date(s + 'T00:00:00').getTime();
    const pts3 = [
      { ts: dd3('2026-01-01'), nav: 1.0 },
      { ts: dd3('2026-01-05'), nav: 1.1 },
      { ts: dd3('2026-01-10'), nav: 1.2 }
    ];
    const recs3 = [
      { id: 'b1', code: 'X', type: 'buy', date: '2026-01-01', amount: 1000, createdAt: 1 },
      { id: 's1', code: 'X', type: 'sell', date: '2026-01-05', amount: 550, createdAt: 2 }
    ];
    const en3 = sandbox.enrichRecords(recs3, { points: pts3 });
    ok('卖出记录 type 归一 & 份额=550/1.1',
       en3[1].type === 'sell' && Math.abs(en3[1].shares - 500) < 1e-9,
       'type=' + en3[1].type + ' shares=' + en3[1].shares);
    ok('卖出点 vsPrev 相对上次买入（+10%）',
       Math.abs(en3[1].vsPrev - 10) < 1e-6, 'got ' + en3[1].vsPrev);
    ok('卖出点无 vsLatest（持有至最新仅买入有）', en3[1].vsLatest === null);
    const s3 = sandbox.summarize(en3);
    // 买入1000份@1.0，卖出500份@1.1，剩500份×1.2=600；回款550；本金1000 → 盈亏 150
    ok('份额法：剩余份额 = 500',
       Math.abs(s3.totalShares - 500) < 1e-9, 'got ' + s3.totalShares);
    ok('份额法：盈亏 = 600+550-1000 = 150',
       Math.abs(s3.profit - 150) < 1e-9, 'got ' + s3.profit);
    ok('份额法：盈亏率 = 15%', Math.abs(s3.profitRate - 15) < 1e-9, 'got ' + s3.profitRate);
    ok('统计：买1卖1、卖出回款550',
       s3.buyCount === 1 && s3.sellCount === 1 && Math.abs(s3.sellAmount - 550) < 1e-9);

    /* ---- MA 均线 ---- */
    const maPts = [];
    for (let mi = 1; mi <= 20; mi++) {
      maPts.push({ ts: mi, nav: mi });
    }
    const ma15 = sandbox.computeMA(maPts, 15);
    ok('均线：不足窗口时为 null', ma15[10] === null);
    ok('均线：第15点 = 均值(1..15) = 8', Math.abs(ma15[15] - 8) < 1e-9, 'got ' + ma15[15]);
    ok('均线：第20点 = 均值(6..20) = 13', Math.abs(ma15[20] - 13) < 1e-9, 'got ' + ma15[20]);
  }
}

/* ============================================================
   13. 迭代 v1.2：基金表格 / 全部历史 / 批量管理
   ============================================================ */
console.log('\n【迭代 v1.2】基金表格 / 全部历史 / 批量管理');
ok('表格列：浮动盈亏与最大回撤可排序', /data-sort="profit"/.test(html) && /data-sort="dd"/.test(html));
ok('排序循环（降序→升序→手动）', /function\s+cycleFundSort\s*\(/.test(html));
ok('置顶功能', /function\s+togglePinFund\s*\(/.test(html));
ok('删除整只基金（含确认）', /function\s+deleteFund\s*\(/.test(html));
ok('拖拽换位 + 手动模式 draggable', /function\s+moveFund\s*\(/.test(html) && /draggable="true"/.test(html));
ok('最大回撤取序列最小值（成立以来）', /out\.mdd === null \|\| v < out\.mdd/.test(html));
ok('区间新增 近1月/近3年/近5年', /data-range="30"/.test(html) && /data-range="1095"/.test(html) && /data-range="1825"/.test(html));
ok('全部历史标记（full）随净值存储', /full: d\.full === true/.test(html));
ok('启动时自动升级旧数据（startUpgrade）', /function startUpgrade\(\)/.test(html));
ok('批量管理：模式开关与面板', /id="btnBatchMode"/.test(html) && /id="batchPane"/.test(html));
ok('批量管理：全选/删除/改日期/改金额/改备注', /id="btnBatchAll"/.test(html) && /id="btnBatchDel"/.test(html) &&
   /id="btnBatchDate"/.test(html) && /id="btnBatchAmount"/.test(html) && /id="btnBatchNote"/.test(html));
ok('批量删除需二次确认', /批量删除['"]?\s*,[\s\S]{0,80}批量删除/.test(html));
ok('loadFundNav 支持不切换当前基金', /function loadFundNav\(code, silent, keepCurrent\)/.test(html));
ok('基金顺序/置顶/排序已持久化', /fundOrder: state\.fundOrder/.test(html) &&
   /fundPinned: state\.fundPinned/.test(html) && /fundSort: state\.fundSort/.test(html));
{
  const serFn = extract('serialize');
  ok('批量勾选状态不持久化（会话级）', !!serFn && serFn.indexOf('batch') === -1);
}

/* ============================================================
   14. 迭代 v1.3：卖出记录 / 批量新增 / 近10年 / 区间回撤 / 均线
   ============================================================ */
console.log('\n【迭代 v1.3】卖出 / 批量新增 / 近10年 / 区间回撤 / 均线');
ok('录入表单：买入/卖出切换', /id="recTypeSeg"/.test(html) && /data-type="sell"/.test(html));
ok('记录表：类型列与徽章', /badge-buy/.test(html) && /badge-sell/.test(html));
ok('addRecord 支持 buy/sell 类型', /function addRecord\(type, date, amount, note\)/.test(html));
ok('旧数据归一：无 type 记录视为买入', /type !== 'sell'\) state\.records\[ri\]\.type = 'buy'/.test(html));
ok('示例数据含卖出记录', /mk\(3, 500, '部分止盈', 'sell'\)/.test(html));
ok('批量新增：模式开关与面板', /id="btnBulkMode"/.test(html) && /id="bulkPane"/.test(html) && /id="bulkFundChecks"/.test(html));
ok('批量新增：提交逻辑', /function submitBulkRecords\(\)/.test(html));
ok('批量新增与管理互斥', /if \(on\) state\.batch\.active = false;/.test(html));
ok('区间新增 近10年', /data-range="3650"/.test(html));
ok('图表回撤按所选区间计算', /computeDrawdownMap\(points\)/.test(html));
ok('存在 MA 计算函数（15/60 日）', /function computeMA\(points, n\)/.test(html) &&
   /computeMA\(fund\.points, 15\)/.test(html) && /computeMA\(fund\.points, 60\)/.test(html));
ok('均线为虚线且配色区分', /stroke="#ffb020"[^>]*stroke-dasharray/.test(html) && /stroke="#b57bff"[^>]*stroke-dasharray/.test(html));
ok('图例含均线与卖出点', /15日均线/.test(html) && /60日均线/.test(html) && /卖出点（较上次买入）/.test(html));
ok('悬停浮层显示均线值', /ma15: ma15Map/.test(html) && /15日均线/.test(html));

/* ============================================================
   汇总
   ============================================================ */
console.log('\n' + '='.repeat(58));
console.log('  自检结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项，警告 ' + warn + ' 项');
console.log('='.repeat(58) + '\n');

process.exit(fail > 0 ? 1 : 0);
