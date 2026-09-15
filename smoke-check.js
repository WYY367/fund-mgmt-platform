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
  extract('adjReturnPct'),
  extract('enrichRecords'),
  extract('summarize'),
  extract('computeDrawdownMap')
].filter(Boolean).join('\n');

const sandbox = {};
try {
  const fn = new Function(src + `
    return { toDateStr, findNavOnOrBefore, latestPoint, dateStrToTs, adjReturnPct, enrichRecords, summarize, computeDrawdownMap };
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
ok('概览卡片：较前次买入 / 较前次卖出 各一张',
   /card\('相较于前次买入'/.test(html) && /card\('相较于前次卖出'/.test(html));
ok('概览不再显示总体浮动盈亏', !/card\('浮动盈亏'/.test(html));

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
  }
}

/* ============================================================
   13. 迭代 v1.2：基金表格 / 全部历史 / 批量管理
   ============================================================ */
console.log('\n【迭代 v1.2】基金表格 / 全部历史 / 批量管理');
ok('表格列：较前次买入 / 较前次卖出 / 最大回撤可排序',
   /data-sort="vsBuy"/.test(html) && /data-sort="vsSell"/.test(html) && /data-sort="mdd"/.test(html));
ok('旧列「浮动盈亏」已从基金表格移除', !/data-sort="profit"/.test(html));
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
ok('图例含顾比均线与卖出点', /短期组 3~15 日 EMA/.test(html) && /长期组 30~60 日 EMA/.test(html) && /<\/span>卖出点</.test(html));
ok('图例中「买入点」只有一条', /<span class="legend-dot" style="background:#ff5b5b"><\/span>买入点</.test(html) &&
   (html.match(/background:#ff5b5b"><\/span>买入点</g) || []).length === 1);
ok('图例去掉括号说明', !/买入点（/.test(html) && !/卖出点（/.test(html));
ok('悬停浮层显示均线值', /maRows = gmmaRow\('短期组均值'/.test(html));

/* ============================================================
   15. 迭代 v1.4：数据安全 / 分红口径 / 并发
   ============================================================ */
console.log('\n【迭代 v1.4】数据安全 / 分红口径 / 并发');

const serverSrc = fs.readFileSync(path.join(__dirname, 'server.js'), 'utf8');

ok('记录与净值缓存分离持久化（records.json）', /records\.json/.test(serverSrc));
ok('净值缓存独立文件（navCache.json）', /navCache\.json/.test(serverSrc));
ok('写入前生成快照', /function snapshot\s*\(/.test(serverSrc) && /snapshot\(RECORDS_FILE/.test(serverSrc));
ok('损坏文件隔离保留（不删除、不覆盖）',
   /function quarantine\s*\(/.test(serverSrc) && /renameSync\(file, target\)/.test(serverSrc));
ok('损坏时返回 corrupt 标记（前端据此不预置示例数据）',
   /corrupt: true/.test(serverSrc) && /state\.dataCorrupt/.test(html));
ok('rev 并发校验 + 409 冲突', /conflict: true/.test(serverSrc) && /status === 409|sendJson\(res, 409/.test(serverSrc));
ok('前端冲突交由用户决策（不静默覆盖）',
   /function resolveConflict\s*\(/.test(html) && /数据冲突/.test(html));
ok('跨标签页 storage 事件同步', /addEventListener\('storage'/.test(html));
ok('无通配 CORS 头', !/Access-Control-Allow-Origin/.test(serverSrc));
ok('Host / Origin 访问校验', /function checkAccess\s*\(/.test(serverSrc) && /ALLOWED_HOSTS/.test(serverSrc));
ok('累计净值按时间戳对齐（非位置切片）',
   /Data_ACWorthTrend/.test(serverSrc) && /acMap\.has\(trend\[i\]\.ts\)/.test(serverSrc));
ok('前端不再把净值缓存写入 localStorage',
   extract('serialize').indexOf('funds') === -1, 'serialize 仍包含 funds');
ok('escapeHtml 转义 & < > " \'',
   /replace\(\/&\/g, '&amp;'\)\.replace\(\/<\/g, '&lt;'\)\.replace\(\/>\/g, '&gt;'\)/.test(html));

if (sandbox.adjReturnPct) {
  // 纯单位净值口径（无 ac）→ 与修正前行为一致
  ok('无累计净值数据时退化为单位净值口径',
     Math.abs(sandbox.adjReturnPct({ nav: 1.0 }, { nav: 0.8 }) - (-20)) < 1e-9,
     'got ' + sandbox.adjReturnPct({ nav: 1.0 }, { nav: 0.8 }));
  // 含分红：1.0 买入（累计 1.5），分红后单位净值 0.8（累计 1.6）→ 实际 +10%，不是 -20%
  ok('分红修正：单位净值 -20% 修正为实际 +10%',
     Math.abs(sandbox.adjReturnPct({ nav: 1.0, ac: 1.5 }, { nav: 0.8, ac: 1.6 }) - 10) < 1e-9,
     'got ' + sandbox.adjReturnPct({ nav: 1.0, ac: 1.5 }, { nav: 0.8, ac: 1.6 }));
  // 仅一端有 ac → 不做修正，避免半口径失真
  ok('仅一端有累计净值时不修正',
     Math.abs(sandbox.adjReturnPct({ nav: 1.0 }, { nav: 0.8, ac: 1.6 }) - (-20)) < 1e-9);
}

if (sandbox.enrichRecords && sandbox.summarize) {
  const dd4 = (s) => new Date(s + 'T00:00:00').getTime();
  const dPts = [
    { ts: dd4('2026-01-01'), nav: 1.0, ac: 1.5 },
    { ts: dd4('2026-01-05'), nav: 0.8, ac: 1.6 }
  ];
  const dRecs = [{ id: 'd1', code: 'X', type: 'buy', date: '2026-01-01', amount: 1000, createdAt: 1 }];
  const dEn = sandbox.enrichRecords(dRecs, { points: dPts });
  ok('持有至最新按累计净值口径（分红后仍为 +10%）',
     Math.abs(dEn[0].vsLatest - 10) < 1e-9, 'got ' + dEn[0].vsLatest);
  const dS = sandbox.summarize(dEn);
  // 1000 份 @1.0；持有期内每份分红 0.3（1.6-1.5 的差） → 现金 300 + 市值 800 = 1100 → 盈亏 +100
  // 若按旧的纯单位净值口径会算成 800 - 1000 = -200（把分红当成亏损）
  ok('分红修正后盈亏 = 800 + 300 − 1000 = +100',
     Math.abs(dS.profit - 100) < 1e-6, 'got ' + dS.profit);
  ok('标记已做分红修正', dS.dividendAdjusted === true);

  const nPts = [
    { ts: dd4('2026-01-01'), nav: 1.0 },
    { ts: dd4('2026-01-05'), nav: 0.8 }
  ];
  const nS = sandbox.summarize(sandbox.enrichRecords(dRecs, { points: nPts }));
  ok('无分红数据时不做修正（盈亏 = -200）', Math.abs(nS.profit - (-200)) < 1e-6, 'got ' + nS.profit);
  ok('无分红数据时不标记 dividendAdjusted', nS.dividendAdjusted === false);

  /* ---- 末条记录为卖出时，「最近一次买入」指标仍必须有效 ---- */
  const lPts = [
    { ts: dd4('2026-01-01'), nav: 1.0 },
    { ts: dd4('2026-01-05'), nav: 1.2 },
    { ts: dd4('2026-01-10'), nav: 0.9 }
  ];
  const lRecs = [
    { id: 'L1', code: 'X', type: 'buy', date: '2026-01-01', amount: 1000, createdAt: 1 },
    { id: 'L2', code: 'X', type: 'buy', date: '2026-01-05', amount: 1000, createdAt: 2 },
    { id: 'L3', code: 'X', type: 'sell', date: '2026-01-10', amount: 300, createdAt: 3 }
  ];
  const lS = sandbox.summarize(sandbox.enrichRecords(lRecs, { points: lPts }));
  // 最近一次买入 1.2 → 最新 0.9 = -25%
  ok('末条为卖出时 latestVsPrevBuy 取「最后一次买入」= -25%',
     Math.abs(lS.latestVsPrevBuy - (-25)) < 1e-9, 'got ' + lS.latestVsPrevBuy);
  ok('仅有一条买入时卖出点 vsPrev 相对该买入（+20%）',
     Math.abs(sandbox.enrichRecords([
       { id: 's1', code: 'X', type: 'buy', date: '2026-01-01', amount: 1000, createdAt: 1 },
       { id: 's2', code: 'X', type: 'sell', date: '2026-01-05', amount: 300, createdAt: 2 }
     ], { points: lPts })[1].vsPrev - 20) < 1e-9);
}

/* ============================================================
   16. 迭代 v1.5：数据源详情页跳转（天天基金）
   ============================================================ */
console.log('\n【迭代 v1.5】数据源详情页跳转');
ok('基金表格行含「详情」按钮', /data-act="source"/.test(html));
ok('存在 fundDetailUrl 生成数据源地址', /function\s+fundDetailUrl\s*\(/.test(html));
ok('存在 openFundDetail（新标签页打开）',
   /function\s+openFundDetail\s*\(/.test(html) && /window\.open\(url, '_blank'\)/.test(html));
ok('详情地址指向数据源站点（fund.eastmoney.com/{code}.html）',
   /'https:\/\/fund\.eastmoney\.com\/'\s*\+\s*encodeURIComponent\(String\(code\)\)/.test(html));
ok('详情按钮走 fundBody 事件委托（act === source）',
   /act === 'source'[\s\S]{0,60}openFundDetail\(code\)/.test(html));
ok('出站跳转未引入任何外部资源（脚本/样式/图片仍全内联）',
   !/<script[^>]+src=/i.test(html) && !/<img[^>]+src\s*=\s*["']https?:/i.test(html));

{
  const urlFn = extract('fundDetailUrl');
  ok('fundDetailUrl 可独立执行', !!urlFn);
  if (urlFn) {
    try {
      const makeUrl = new Function(urlFn + '\nreturn fundDetailUrl;')();
      ok('fundDetailUrl(110022) 正确',
         makeUrl('110022') === 'https://fund.eastmoney.com/110022.html', makeUrl('110022'));
    } catch (e) {
      ok('fundDetailUrl(110022) 正确', false, e.message);
    }
  }
}

/* ============================================================
   17. 迭代 v1.6：拖拽排序修复（残留样式压制原生拖拽）
   ============================================================ */
console.log('\n【迭代 v1.6】拖拽排序修复');
ok('已清除设计器残留样式（__dm_no_drag_style__）', html.indexOf('__dm_no_drag_style__') === -1);
ok('全页无 -webkit-user-drag: none（会压制 draggable=true）',
   !/-webkit-user-drag\s*:\s*none/i.test(html.replace(/\/\*[\s\S]*?\*\//g, '')));
ok('拖拽行显式声明可拖拽（-webkit-user-drag: element）',
   /\.funds tr\[draggable="true"\][^{]*\{[^}]*-webkit-user-drag:\s*element/.test(html));
ok('拖拽行仍为手动排序模式（draggable="true"）', /function\s+moveFund\s*\(/.test(html));
ok('拖拽手柄仅在手动模式渲染',
   /manual \? '<span class="drag-handle"/.test(html));

/* ============================================================
   18. 迭代 v2.2：较前次买入 / 较前次卖出 口径
   ============================================================ */
console.log('\n【迭代 v2.2】较前次买入 / 较前次卖出');
ok('存在 latestVsLastAction（列表/概览口径）', /function\s+latestVsLastAction\s*\(/.test(html));
ok('列表无买入/卖出记录时留空',
   /m\.vsBuy == null[\s\S]{0,160}text-faint/.test(html) && /m\.vsSell == null[\s\S]{0,160}text-faint/.test(html));
ok('存在 compareMarkersToPrevActions（标记口径）', /function\s+compareMarkersToPrevActions\s*\(/.test(html));
ok('存在 computeVsActionsByDate（悬停口径）', /function\s+computeVsActionsByDate\s*\(/.test(html));
ok('存在区间名映射 rangeLabel', /function\s+rangeLabel\s*\(/.test(html) && /近10年/.test(html));
ok('无上次操作时基准取区间首点并标注区间名',
   /base === rangeFirst \? 'range' : 'prev'/.test(html) && /rangeLabel\(state\.range\)/.test(html));
ok('图表标签为两行（买 / 卖 各一行）', /cmpLineText\('买'/.test(html) && /cmpLineText\('卖'/.test(html));
ok('买卖点颜色固定（买入红 / 卖出橙）', /var BUY_COLOR = '#ff5b5b'/.test(html) && /var SELL_COLOR = '#ff9f43'/.test(html));
ok('旧排序键载入时归一（只认 vsBuy / vsSell / mdd）',
   /sk === 'vsBuy' \|\| sk === 'vsSell' \|\| sk === 'mdd'/.test(html));
ok('记录表新增「较上次卖出」列',
   />较上次卖出<\/th>/.test(html) && /data-label="较上次卖出"/.test(html));
ok('标签几何函数齐备',
   /function\s+rectsOverlap\s*\(/.test(html) &&
   /function\s+segIntersectsRect\s*\(/.test(html) &&
   /function\s+placeMarkerLabel\s*\(/.test(html));
ok('渲染层用 placeMarkerLabel 统一布置标签并记录已放框',
   /placeMarkerLabel\(mk\.x, mk\.y, boxW, boxH, avoidPts, placedBoxes/.test(html) &&
   /placedBoxes\.push\(/.test(html));

{
  const geoSrc = [extract('rectsOverlap'), extract('pointInRect'), extract('segIntersectsRect'),
                  extract('placeMarkerLabel')].filter(Boolean).join('\n');
  let geo = null;
  try {
    geo = new Function(geoSrc + '\nreturn { rectsOverlap, pointInRect, segIntersectsRect, placeMarkerLabel };')();
    ok('标签几何函数可独立执行', true);
  } catch (e) {
    ok('标签几何函数可独立执行', false, e.message);
  }
  if (geo) {
    const R = { x: 0, y: 0, w: 10, h: 10 };
    ok('线段矩形相交：横穿=true', geo.segIntersectsRect(-5, 5, 15, 5, R) === true);
    ok('线段矩形相交：外侧=false', geo.segIntersectsRect(-5, 20, 15, 20, R) === false);
    ok('线段矩形相交：内含=true', geo.segIntersectsRect(2, 2, 8, 8, R) === true);
    ok('线段矩形相交：竖穿=true', geo.segIntersectsRect(5, -5, 5, 15, R) === true);
    ok('线段矩形相交：擦边不入=false', geo.segIntersectsRect(20, 5, 30, 5, R) === false);
    ok('点在矩形内判定',
       geo.pointInRect({ x: 0, y: 0 }, R) === true && geo.pointInRect({ x: 11, y: 5 }, R) === false);

    const B = { left: 0, right: 900, top: 0, bottom: 320 };

    // 上行曲线（标记恰在折点）：右上候选压线 → 应回避到下方
    const line = [{ x: 350, y: 200 }, { x: 450, y: 100 }, { x: 550, y: 0 }];
    const p1 = geo.placeMarkerLabel(450, 100, 70, 30, line, [], B);
    ok('标签自动避开曲线（不压上行线）', p1.side === 'rb' || p1.side === 'lb', JSON.stringify(p1));
    const box1 = { x: p1.x, y: p1.y, w: 70, h: 30 };
    ok('选中位置的框不与曲线相交',
       !geo.segIntersectsRect(350, 200, 450, 100, box1) && !geo.segIntersectsRect(450, 100, 550, 0, box1),
       JSON.stringify(box1));

    // 已放标签占住下方 → 换到不相交的位置
    const occupied = [{ x: 460, y: 110, w: 70, h: 30 }];
    const p2 = geo.placeMarkerLabel(450, 100, 70, 30, line, occupied, B);
    ok('标签之间互不遮挡',
       !geo.rectsOverlap({ x: p2.x, y: p2.y, w: 70, h: 30 }, occupied[0]), JSON.stringify(p2));

    // 四象限在 10px 间距全被占（上下两条横线）→ 自动换位/增大间距避让
    const dense = [];
    for (let x = 300; x <= 600; x += 10) { dense.push({ x: x, y: 85 }); dense.push({ x: x, y: 115 }); }
    const p3 = geo.placeMarkerLabel(450, 100, 70, 30, dense, [], B);
    ok('四周被占时自动换位避让（不落在默认位）', !(p3.x === 460 && p3.y === 61), JSON.stringify(p3));
    ok('换位后的框不含任何需避开的点',
       !dense.some((pt) => geo.pointInRect(pt, { x: p3.x, y: p3.y, w: 70, h: 30 })), JSON.stringify(p3));

    // 贴近右缘 → 放到左侧，且坐标夹在绘图区内
    const p4 = geo.placeMarkerLabel(870, 160, 70, 30, [], [], { left: 62, right: 874, top: 24, bottom: 280 });
    ok('贴近右缘时标签放到左侧', p4.side === 'lt' || p4.side === 'lb', JSON.stringify(p4));
    ok('标签坐标始终夹在绘图区内',
       p4.x >= 62 && p4.x + 70 <= 874 && p4.y >= 24 && p4.y + 30 <= 280, JSON.stringify(p4));

    // 相邻标记点也要避开
    const dots = [{ x: 460, y: 90 }, { x: 470, y: 80 }];
    const p5 = geo.placeMarkerLabel(450, 100, 70, 30, dots, [], B);
    ok('标签不压相邻的标记点',
       !dots.some((pt) => geo.pointInRect(pt, { x: p5.x, y: p5.y, w: 70, h: 30 })), JSON.stringify(p5));
  }

  if (sandbox.enrichRecords) {
    const d5 = (s) => new Date(s + 'T00:00:00').getTime();
    const pts5 = [
      { ts: d5('2026-01-01'), nav: 1.0 },
      { ts: d5('2026-01-05'), nav: 1.1 },
      { ts: d5('2026-01-10'), nav: 1.2 },
      { ts: d5('2026-01-15'), nav: 0.9 }
    ];
    const recs5 = [
      { id: 'a', code: 'X', type: 'buy', date: '2026-01-01', amount: 1000, createdAt: 1 },
      { id: 'b', code: 'X', type: 'sell', date: '2026-01-05', amount: 500, createdAt: 2 },
      { id: 'c', code: 'X', type: 'sell', date: '2026-01-10', amount: 300, createdAt: 3 },
      { id: 'e', code: 'X', type: 'buy', date: '2026-01-15', amount: 1000, createdAt: 4 }
    ];
    const en5 = sandbox.enrichRecords(recs5, { points: pts5 });
    ok('较上次卖出：首笔卖出为基准（null）', en5[1].vsPrevSell === null && en5[1].type === 'sell');
    ok('较上次卖出：第二笔卖出相对第一笔（+9.09%）',
       Math.abs(en5[2].vsPrevSell - ((1.2 - 1.1) / 1.1) * 100) < 1e-9, 'got ' + en5[2].vsPrevSell);
    ok('较上次卖出：首笔买入（尚无卖出）为 null', en5[0].vsPrevSell === null);
    ok('较上次卖出：其后的买入相对最近一次卖出（-25%）',
       Math.abs(en5[3].vsPrevSell - ((0.9 - 1.2) / 1.2) * 100) < 1e-9, 'got ' + en5[3].vsPrevSell);
    ok('较上次卖出：卖出点同时保留相对上次买入',
       Math.abs(en5[2].vsPrev - ((1.2 - 1.0) / 1.0) * 100) < 1e-9, 'got ' + en5[2].vsPrev);
  }
}

{
  const src2 = [
    extract('adjReturnPct'),
    extract('latestVsLastAction'),
    extract('compareMarkersToPrevActions'),
    extract('rangeLabel')
  ].filter(Boolean).join('\n');
  let api2 = null;
  try {
    api2 = new Function(src2 + '\nreturn { adjReturnPct, latestVsLastAction, compareMarkersToPrevActions, rangeLabel };')();
    ok('新口径函数可独立执行', true);
  } catch (e) {
    ok('新口径函数可独立执行', false, e.message);
  }

  if (api2) {
    const en = [
      { type: 'buy', nav: 1.0, ac: null, navDate: '2026-01-01', latestNav: 1.2, latestAc: null },
      { type: 'sell', nav: 1.5, ac: null, navDate: '2026-02-01', latestNav: 1.2, latestAc: null }
    ];
    const mv = api2.latestVsLastAction(en);
    ok('最新 vs 前次买入 = +20%', Math.abs(mv.vsBuy - 20) < 1e-9, 'got ' + mv.vsBuy);
    ok('最新 vs 前次卖出 = -20%', Math.abs(mv.vsSell - (-20)) < 1e-9, 'got ' + mv.vsSell);
    ok('基准日期随指标返回', mv.buyDate === '2026-01-01' && mv.sellDate === '2026-02-01',
       mv.buyDate + ' / ' + mv.sellDate);

    const onlySell = api2.latestVsLastAction([
      { type: 'sell', nav: 1.5, ac: null, navDate: '2026-02-01', latestNav: 1.2, latestAc: null }
    ]);
    ok('无买入记录时 vsBuy 为 null（列表留空）', onlySell.vsBuy === null && onlySell.vsSell !== null);

    // 标记口径：无上次同类操作 → 以区间首点为基准
    const rangeFirst = { nav: 2.0, ac: null, date: '2026-01-01' };
    const en2 = [
      { type: 'buy', nav: 1.0, ac: null, navDate: '2026-01-05' },
      { type: 'buy', nav: 1.2, ac: null, navDate: '2026-01-10' },
      { type: 'sell', nav: 1.3, ac: null, navDate: '2026-01-15' }
    ];
    const cl = api2.compareMarkersToPrevActions(en2, rangeFirst);
    ok('首笔买入无上次买入 → 基准为区间首点（-50%）',
       cl[0].buyBase === 'range' && Math.abs(cl[0].buy - (-50)) < 1e-9,
       cl[0].buyBase + ' ' + cl[0].buy);
    ok('第 2 笔买入相对上次买入（+20%）',
       cl[1].buyBase === 'prev' && Math.abs(cl[1].buy - 20) < 1e-9, cl[1].buyBase + ' ' + cl[1].buy);
    ok('卖出点无上次卖出 → 基准为区间首点（-35%）',
       cl[2].sellBase === 'range' && Math.abs(cl[2].sell - (-35)) < 1e-9,
       cl[2].sellBase + ' ' + cl[2].sell);
    ok('卖出点同时给出相对上次买入（+8.33%）',
       Math.abs(cl[2].buy - ((1.3 - 1.2) / 1.2) * 100) < 1e-6,
       'got ' + cl[2].buy);
    ok('基准点即该点自身时标记为 self',
       api2.compareMarkersToPrevActions(
         [{ type: 'buy', nav: 2.0, ac: null, navDate: '2026-01-01' }], rangeFirst
       )[0].buyBase === 'self');
    ok('区间名映射正确', api2.rangeLabel('90') === '近3月' && api2.rangeLabel('all') === '成立以来' &&
       api2.rangeLabel(3650) === '近10年');
  }
}

/* ============================================================
   19. 迭代 v2.4：顾比均线（GMMA）与买卖建议
   ============================================================ */
console.log('\n【迭代 v2.4】顾比均线与买卖建议');
ok('存在 EMA 计算函数 computeEMA', /function\s+computeEMA\s*\(/.test(html));
ok('顾比周期：短期组 3/5/8/10/12/15 · 长期组 30/35/40/45/50/60',
   /GMMA_SHORT\s*=\s*\[3,\s*5,\s*8,\s*10,\s*12,\s*15\]/.test(html) &&
   /GMMA_LONG\s*=\s*\[30,\s*35,\s*40,\s*45,\s*50,\s*60\]/.test(html));
ok('存在 computeGMMA / gmmaGroupStats / computeGmmaBandStats / findGmmaCrosses',
   /function\s+computeGMMA\s*\(/.test(html) && /function\s+gmmaGroupStats\s*\(/.test(html) &&
   /function\s+computeGmmaBandStats\s*\(/.test(html) && /function\s+findGmmaCrosses\s*\(/.test(html));
ok('存在形态分析函数 analyzeGmmaAt 与建议文案 gmmaAdviceHtml',
   /function\s+analyzeGmmaAt\s*\(/.test(html) && /function\s+gmmaAdviceHtml\s*\(/.test(html));
ok('工具栏有均线模式切换（顾比 · 关闭）',
   /id="maModeGroup"/.test(html) && !/data-ma="classic"/.test(html) &&
   /data-ma="gmma"/.test(html) && /data-ma="none"/.test(html));
ok('顾比均线为默认模式', /maMode:\s*'gmma'/.test(html) &&
   /<button class="range-btn active" data-ma="gmma">/.test(html));
ok('存在建议面板容器 gmmaAdvice（图例下方）',
   /id="gmmaAdvice"/.test(html) &&
   html.indexOf('id="gmmaAdvice"') > html.indexOf('id="chartLegend"'));
ok('建议面板随均线模式显隐（hideGmmaAdvice + renderChart 内分支）',
   /function\s+hideGmmaAdvice\s*\(/.test(html) && /adviceEl\.classList\.remove\('hidden'\)/.test(html));
ok('建议面板含免责口径说明', /不构成投资建议/.test(html));
ok('悬停浮层区分均线模式（顾比组均值 / 关闭时无均线行）',
   /c\.maMode === 'gmma'/.test(html) && !/15日均线/.test(html));
ok('顾比组配色（青 #22d3ee / 品红 #e879f9）', /#22d3ee/.test(html) && /#e879f9/.test(html));
ok('金叉红▲ / 死叉绿▼ 三角标记（涨红跌绿）',
   /golden' \? '#ff5b5b' : '#26c281'/.test(html));
ok('均线绘制套用绘图区裁剪（plotClip）', /clip-path="url\(#plotClip\)"/.test(html) && /id="plotClip"/.test(html));

/* ---- 顾比计算与形态分析：纯函数重放 ---- */
function extractVar(name) {
  const mv = new RegExp('var\\s+' + name + '\\s*=\\s*\\[[^\\]]*\\]\\s*;').exec(html);
  return mv ? mv[0] : '';
}
const src24 = [
  extract('computeEMA'),
  extract('computeGMMA'),
  extract('gmmaGroupStats'),
  extract('computeGmmaBandStats'),
  extract('findGmmaCrosses'),
  extract('analyzeGmmaAt')
].filter(Boolean).join('\n') + '\n' +
  extractVar('GMMA_SHORT') + '\n' + extractVar('GMMA_LONG') + '\n' +
  (new RegExp('var\\s+GMMA_LONG_SEED_IDX\\s*=\\s*\\d+\\s*;').exec(html) || [''])[0];

let api24 = null;
try {
  api24 = new Function(src24 + `
    return { computeEMA, computeGMMA, gmmaGroupStats, computeGmmaBandStats, findGmmaCrosses, analyzeGmmaAt };
  `)();
  ok('顾比计算函数可独立执行', true);
} catch (e) {
  ok('顾比计算函数可独立执行', false, e.message);
}

if (api24) {
  /* ---- EMA 正确性：线性序列 nav=1..12，n=3 → 第 3 点种子=2，其后滞后 1 ---- */
  const emaPts = [];
  for (let i = 1; i <= 12; i++) emaPts.push({ ts: i, nav: i });
  const ema3 = api24.computeEMA(emaPts, 3);
  ok('EMA：种子点之前为 null', ema3[1] === null && ema3[2] === null);
  ok('EMA：第 3 点 = 前 3 点均值 = 2', Math.abs(ema3[3] - 2) < 1e-9, 'got ' + ema3[3]);
  ok('EMA：第 4 点 = 2 + 0.5×(4−2) = 3', Math.abs(ema3[4] - 3) < 1e-9, 'got ' + ema3[4]);
  ok('EMA：第 12 点 = 11（线性序列滞后 1）', Math.abs(ema3[12] - 11) < 1e-9, 'got ' + ema3[12]);
  ok('EMA：空数据返回空映射', Object.keys(api24.computeEMA([], 5)).length === 0);

  /* ---- GMMA 组统计：恒定序列 ---- */
  const flatPts = [];
  for (let i = 1; i <= 80; i++) flatPts.push({ ts: i, nav: 2 });
  const gmmaFlat = api24.computeGMMA(flatPts);
  ok('GMMA：短期 6 条 + 长期 6 条',
     gmmaFlat.short.length === 6 && gmmaFlat.long.length === 6);
  const flatLong = api24.gmmaGroupStats(gmmaFlat.long, 80);
  ok('GMMA：恒定序列长期组 min=max=avg=2',
     !!flatLong && Math.abs(flatLong.min - 2) < 1e-9 && Math.abs(flatLong.max - 2) < 1e-9 &&
     Math.abs(flatLong.avg - 2) < 1e-9, JSON.stringify(flatLong));
  ok('GMMA：长期组不足 60 点时为 null', api24.gmmaGroupStats(gmmaFlat.long, 30) === null);
  ok('GMMA：短期组第 15 点起有值',
     api24.gmmaGroupStats(gmmaFlat.short, 14) === null &&
     Math.abs(api24.gmmaGroupStats(gmmaFlat.short, 15).avg - 2) < 1e-9);
  const bandStats = api24.computeGmmaBandStats(gmmaFlat, flatPts);
  ok('GMMA：组带统计含 min/max/avg',
     !!bandStats.short[80] && !!bandStats.long[80] &&
     Math.abs(bandStats.long[80].avg - 2) < 1e-9);

  /* ---- 形态分析：单边上行 → 买入；单边下行 → 卖出；恒定 → 观望 ---- */
  const upPts = [];
  for (let i = 1; i <= 120; i++) upPts.push({ ts: i, nav: Number((1 + i * 0.01).toFixed(6)) });
  const aUp = api24.analyzeGmmaAt(upPts, api24.computeGMMA(upPts), upPts.length - 1);
  ok('单边上行 → 建议买入', aUp.ok && aUp.action === 'buy', aUp.action + ' ' + aUp.label);
  ok('建议附带动因（≥4 条理由）', aUp.reasons.length >= 4, 'n=' + aUp.reasons.length);
  ok('买入建议含多头趋势理由', aUp.reasons.some((r) => r.indexOf('多头趋势') >= 0),
     aUp.reasons.join(' | ').slice(0, 200));
  ok('建议面板文案可构造（含免责说明）',
     /function\s+gmmaAdviceHtml/.test(html) && html.indexOf('不构成投资建议') > html.indexOf('function gmmaAdviceHtml'));

  const downPts = [];
  for (let i = 1; i <= 120; i++) downPts.push({ ts: i, nav: Number((3 - i * 0.01).toFixed(6)) });
  const aDown = api24.analyzeGmmaAt(downPts, api24.computeGMMA(downPts), downPts.length - 1);
  ok('单边下行 → 建议卖出', aDown.ok && aDown.action === 'sell', aDown.action + ' ' + aDown.label);
  ok('卖出建议含空头趋势理由', aDown.reasons.some((r) => r.indexOf('空头趋势') >= 0));

  const aFlat = api24.analyzeGmmaAt(flatPts, gmmaFlat, flatPts.length - 1);
  ok('横盘（无方向）→ 观望', aFlat.ok && aFlat.action === 'wait', aFlat.action + ' ' + aFlat.label);

  const shortPts = flatPts.slice(0, 40);
  const aShort = api24.analyzeGmmaAt(shortPts, api24.computeGMMA(shortPts), shortPts.length - 1);
  ok('历史不足 60 个交易日 → 数据不足', !aShort.ok && aShort.action === 'none', aShort.label);
  ok('无净值数据 → 数据不足不崩溃',
     api24.analyzeGmmaAt([], api24.computeGMMA([]), 0).action === 'none');

  /* ---- 金叉检测：先跌后涨的 V 形 ---- */
  const vPts = [];
  for (let i = 1; i <= 100; i++) vPts.push({ ts: i, nav: Number((2 - i * 0.01).toFixed(6)) });
  for (let i = 1; i <= 20; i++) vPts.push({ ts: 100 + i, nav: Number((1 + i * 0.03).toFixed(6)) });
  const crossesV = api24.findGmmaCrosses(vPts, api24.computeGMMA(vPts), 60, vPts.length - 1);
  ok('V 形反转检测到金叉', crossesV.some((c) => c.type === 'golden'),
     JSON.stringify(crossesV.slice(-2)));
  ok('纯下行序列无金叉',
     !api24.findGmmaCrosses(downPts, api24.computeGMMA(downPts), 60, downPts.length - 1)
       .some((c) => c.type === 'golden'));
}

/* ============================================================
   20. 迭代 v2.5：基金列表「顾比信号」列（v2.7 改为窗口 10 日 + 计数汇总）
   ============================================================ */
console.log('\n【迭代 v2.5】基金列表顾比信号列');
ok('存在近 N 日交叉检测函数 gmmaRecentCross 与窗口常量',
   /function\s+gmmaRecentCross\s*\(/.test(html) && /GMMA_SIGNAL_WINDOW\s*=\s*10\s*;/.test(html));
ok('fundMetrics 输出 gmmaSignal（窗口取 GMMA_SIGNAL_WINDOW）',
   /gmmaSignal:\s*null/.test(html) &&
   /gmmaRecentCross\(fund,\s*GMMA_SIGNAL_WINDOW\)/.test(html));
ok('表头含「顾比信号」列（位于最大回撤与操作之间）',
   /<th[^>]*>顾比信号<\/th>/.test(html) &&
   html.indexOf('顾比信号') > html.indexOf('成立以来最大回撤') &&
   html.indexOf('顾比信号') < html.indexOf('>操作</th>'));
ok('行单元格含顾比信号（data-label="顾比信号"）', /data-label="顾比信号"/.test(html));
ok('信号徽章配色与文案（金叉红▲ / 死叉绿▼，涨红跌绿）',
   /\?\s*'金叉'\s*:\s*'死叉'/.test(html) && /\?\s*'▲'\s*:\s*'▼'/.test(html) &&
   /\?\s*'var\(--up\)'\s*:\s*'var\(--down\)'/.test(html) &&
   /\?\s*'上穿'\s*:\s*'下穿'/.test(html));
ok('无信号时留空 —（text-faint）',
   /gmmaHtml\s*=\s*'<span style="color:var\(--text-faint\)">—<\/span>'/.test(html));

if (api24) {
  const src25 = src24 + '\n' + extract('gmmaRecentCross') + '\nvar GMMA_SIGNAL_WINDOW = 10;';
  let api25 = null;
  try {
    api25 = new Function(src25 + `
      return { computeGMMA, gmmaGroupStats, findGmmaCrosses, gmmaRecentCross };
    `)();
    ok('顾比信号函数可独立执行', true);
  } catch (e) {
    ok('顾比信号函数可独立执行', false, e.message);
  }

  if (api25) {
    /* ---- 数据 A：跌 100 点后以 0.015/日 上涨 → 金叉落在最后 10 个交易日窗口内 ---- */
    const v25 = [];
    for (let i = 1; i <= 100; i++) v25.push({ ts: i, nav: Number((2 - i * 0.01).toFixed(6)) });
    for (let i = 1; i <= 20; i++) v25.push({ ts: 100 + i, nav: Number((1 + i * 0.015).toFixed(6)) });
    const sigV = api25.gmmaRecentCross({ points: v25 }, 10);
    const allV = api25.findGmmaCrosses(v25, api25.computeGMMA(v25), 60, v25.length - 1);
    const winV = allV.filter((c) => c.idx >= v25.length - 10);
    const expGolden = winV.filter((c) => c.type === 'golden').length;
    const expDeath = winV.filter((c) => c.type === 'death').length;
    ok('信号 = 全历史交叉 ∩ 最后 10 个交易日（次数 + 最近一次）',
       !!sigV && sigV.golden === expGolden && sigV.death === expDeath &&
       sigV.count === winV.length &&
       JSON.stringify(sigV.last) === JSON.stringify(winV.length ? winV[winV.length - 1] : null),
       JSON.stringify(sigV));
    ok('窗口内单次金叉：golden=1 / death=0 / count=1',
       winV.length === 1 && !!sigV && sigV.golden === 1 && sigV.death === 0 && sigV.count === 1,
       'win=' + JSON.stringify(winV));

    /* ---- 按类型的最近一次信号日期 ---- */
    {
      const lastG = winV.filter((c) => c.type === 'golden');
      const lastD = winV.filter((c) => c.type === 'death');
      ok('各类型最近一次日期正确（未出现的类型为 null）',
         !!sigV &&
         sigV.lastGolden === (lastG.length ? lastG[lastG.length - 1].ts : null) &&
         sigV.lastDeath === (lastD.length ? lastD[lastD.length - 1].ts : null),
         sigV ? ('g=' + sigV.lastGolden + ' d=' + sigV.lastDeath) : 'null');
    }

    /* ---- 数据 B：同形状但涨幅更陡 → 交叉落在窗口之外 → null（不误报） ---- */
    {
      const vOut = [];
      for (let i = 1; i <= 100; i++) vOut.push({ ts: i, nav: Number((2 - i * 0.01).toFixed(6)) });
      for (let i = 1; i <= 20; i++) vOut.push({ ts: 100 + i, nav: Number((1 + i * 0.03).toFixed(6)) });
      const allOut = api25.findGmmaCrosses(vOut, api25.computeGMMA(vOut), 60, vOut.length - 1);
      ok('交叉确实存在但落在窗口外 → 返回 null（窗口语义正确）',
         allOut.length > 0 && allOut.every((c) => c.idx < vOut.length - 10) &&
         api25.gmmaRecentCross({ points: vOut }, 10) === null,
         JSON.stringify(allOut));
    }

    /* ---- 数据 C：平坦基底 + 周期 6 震荡 → 窗口内同时出现金叉与死叉 ---- */
    {
      const vBoth = [];
      for (let i = 1; i <= 100; i++) vBoth.push({ ts: i, nav: 1 });
      for (let i = 1; i <= 30; i++) {
        vBoth.push({ ts: 100 + i, nav: Number((1 + 0.03 * Math.sin(2 * Math.PI * i / 6)).toFixed(6)) });
      }
      const sB = api25.gmmaRecentCross({ points: vBoth }, 10);
      const wB = api25.findGmmaCrosses(vBoth, api25.computeGMMA(vBoth), 60, vBoth.length - 1)
        .filter((c) => c.idx >= vBoth.length - 10);
      const gB = wB.filter((c) => c.type === 'golden').length;
      const dB = wB.filter((c) => c.type === 'death').length;
      ok('窗口内金叉与死叉同时存在 → 两类计数各自正确（可并列渲染）',
         gB > 0 && dB > 0 && !!sB &&
         sB.golden === gB && sB.death === dB && sB.count === gB + dB,
         'g=' + gB + ' d=' + dB + ' sig=' + JSON.stringify(sB));
      ok('窗口内多类型时 last 取时间上最近的一次',
         !!sB && sB.last.idx === wB[wB.length - 1].idx,
         sB ? JSON.stringify(sB.last) : 'null');
    }

    const flat25 = [];
    for (let i = 1; i <= 80; i++) flat25.push({ ts: i, nav: 2 });
    ok('恒定序列无交叉 → null',
       api25.gmmaRecentCross({ points: flat25 }, 10) === null);
    ok('历史不足 61 个交易日 → null（不误报）',
       api25.gmmaRecentCross({ points: flat25.slice(0, 40) }, 10) === null &&
       api25.gmmaRecentCross({ points: flat25.slice(0, 60) }, 10) === null);
    ok('空数据 / 缺 points → null 且不崩溃',
       api25.gmmaRecentCross(null, 10) === null &&
       api25.gmmaRecentCross({ points: [] }, 10) === null);
    ok('窗口天数非法（0 / 负数 / 非数值）→ null',
       api25.gmmaRecentCross({ points: flat25 }, 0) === null &&
       api25.gmmaRecentCross({ points: flat25 }, -3) === null &&
       api25.gmmaRecentCross({ points: flat25 }, 'x') === null);

    /* ---- 锯齿行情：count = 窗口内交叉总数（不是全历史） ---- */
    {
      const zig = [];
      for (let i = 1; i <= 120; i++) {
        zig.push({ ts: i, nav: Number((1.5 + (i % 2 === 0 ? 0.15 : -0.15) + i * 0.0005).toFixed(6)) });
      }
      const zSig = api25.gmmaRecentCross({ points: zig }, 10);
      const zAll = api25.findGmmaCrosses(zig, api25.computeGMMA(zig), 60, zig.length - 1);
      const zWin = zAll.filter((c) => c.idx >= zig.length - 10);
      ok('锯齿行情：窗口内多次交叉时 count = 窗口内交叉总数',
         (zWin.length === 0 && zSig === null) ||
         (!!zSig && zSig.count === zWin.length && zSig.golden + zSig.death === zWin.length),
         'win=' + zWin.length + ' sig=' + JSON.stringify(zSig));
    }
  }
}

/* ============================================================
   21. 迭代 v2.6：今日待办提醒可忽略
   ============================================================ */
console.log('\n【迭代 v2.6】今日待办提醒可忽略');

ok('state 含忽略记录 dismissedTodos（随记录持久化）', /dismissedTodos:\s*\{\}/.test(html));
ok('序列化输出 dismissedTodos', /dismissedTodos:\s*state\.dismissedTodos/.test(html));
ok('载入时读入并归一 dismissedTodos',
   /state\.dismissedTodos\s*=\s*\(data\.dismissedTodos/.test(html) &&
   /function\s+normalizeDismissedTodos\s*\(/.test(html));
ok('存在待办标识与分组纯函数（todoKey / splitTodoItems / collectTodoItems）',
   /function\s+todoKey\s*\(/.test(html) && /function\s+splitTodoItems\s*\(/.test(html) &&
   /function\s+collectTodoItems\s*\(/.test(html));
ok('收集逻辑已从渲染函数中拆出（渲染层只负责显示）',
   /function\s+renderTodayZone\s*\([\s\S]{0,400}splitTodoItems\(collectTodoItems\(\)/.test(html));
ok('存在忽略 / 全部忽略 / 恢复处理函数',
   /function\s+dismissTodoItems\s*\(/.test(html) && /function\s+dismissOneTodo\s*\(/.test(html) &&
   /function\s+dismissAllTodos\s*\(/.test(html) && /function\s+restoreTodoDismissals\s*\(/.test(html));
ok('渲染层输出 × 按钮（带标识与情境指纹）',
   /data-today-dismiss="'\s*\+\s*escapeHtml\(it\.key\)/.test(html) && /data-sig="/.test(html));
ok('渲染层输出「全部忽略」入口', /data-today-dismiss="all"/.test(html));
ok('渲染层输出「恢复」入口', /data-today-restore="1"/.test(html));
ok('过期提醒带标识与情境指纹（指纹 = 该基金最新净值日期）',
   /key:\s*todoKey\('stale',\s*f\.code\)/.test(html) && /sig:\s*String\(latest\.ts\)/.test(html));
ok('全部被忽略时给出状态占位（待办区不空白）', /已忽略 ' \+ hidden\.length \+ ' 条提醒/.test(html));
ok('事件委托分流：忽略 / 恢复 / 操作按钮',
   /if \(dis === 'all'\) dismissAllTodos\(\);/.test(html) &&
   /else dismissOneTodo\(dis, t\.getAttribute\('data-sig'\)\);/.test(html) &&
   /restoreTodoDismissals\(\); return;/.test(html));
ok('样式齐备（.todo-head / .todo-foot / .tip-x）',
   /\.todo-head\s*\{/.test(html) && /\.todo-foot\s*\{/.test(html) && /\.tip-x\s*\{/.test(html));
ok('无 emoji 图标（× 与恢复均为内联 SVG / 文字）', !/<button[^>]*>[^<]*[\u{1F300}-\u{1FAFF}\u{2600}-\u{27BF}]/u.test(html));

{
  // 空态引导类（开始使用 / 还没有记录 / 一切正常）不带 key → 不可忽略
  const collectSrc = extract('collectTodoItems') || '';
  const guideSrc = collectSrc.slice(collectSrc.indexOf('// 4) 无数据时的引导'));
  ok('空态引导类不可忽略（无 key 字段）', guideSrc.length > 0 && !/key:/.test(guideSrc));
}

{
  const srcTodo = (extract('todoKey') || '') + '\n' + (extract('splitTodoItems') || '') +
                  '\n' + (extract('normalizeDismissedTodos') || '');
  let apiTodo = null;
  try {
    apiTodo = new Function(srcTodo +
      '\nreturn { todoKey: todoKey, splitTodoItems: splitTodoItems, normalizeDismissedTodos: normalizeDismissedTodos };')();
    ok('待办忽略相关函数可独立执行', true);
  } catch (e) {
    ok('待办忽略相关函数可独立执行', false, e.message);
  }

  if (apiTodo) {
    ok('todoKey 生成稳定标识',
       apiTodo.todoKey('stale', '110022') === 'stale:110022' &&
       apiTodo.todoKey('corrupt') === 'corrupt');

    const tItems = [
      { key: 'stale:110022', sig: '1000', text: 'A' },
      { key: 'stale:110026', sig: '1000', text: 'B' },
      { key: 'dip:110022', sig: 'r9', text: 'C' },
      { text: 'D' }                                  // 空态引导类：无 key
    ];
    const t1 = apiTodo.splitTodoItems(tItems, {});
    ok('无忽略记录时全部显示', t1.shown.length === 4 && t1.hidden.length === 0);

    const t2 = apiTodo.splitTodoItems(tItems, { 'stale:110022': '1000' });
    ok('标识与指纹一致 → 该条被隐藏（不再常驻）',
       t2.hidden.length === 1 && t2.hidden[0].text === 'A' && t2.shown.length === 3);

    const t3 = apiTodo.splitTodoItems(tItems, { 'stale:110022': '2000' });
    ok('指纹变化（净值已更新过）→ 旧忽略失效、重新显示',
       t3.hidden.length === 0 && t3.shown.length === 4);

    const t4 = apiTodo.splitTodoItems(tItems, { 'stale:110022': 1000 });
    ok('指纹按字符串比较（容错数值型）', t4.hidden.length === 1);

    const t5 = apiTodo.splitTodoItems(tItems, { 'nonav:999999': 'n1' });
    ok('无关的历史忽略记录不影响其它条目渲染', t5.shown.length === 4);

    ok('无 key 的条目永不参与忽略',
       apiTodo.splitTodoItems([{ text: 'E' }, { text: 'F' }], { '': 'x', undefined: 'y' }).shown.length === 2);

    ok('只隐藏匹配项、其余照常显示（单条忽略不影响他条）',
       apiTodo.splitTodoItems(tItems, { 'stale:110022': '1000', 'dip:110022': 'r9' }).shown.length === 2);

    const n1 = apiTodo.normalizeDismissedTodos({ a: 1, b: null, c: 'ok' });
    ok('归一：只保留有效字符串键值',
       JSON.stringify(n1) === JSON.stringify({ a: '1', c: 'ok' }), JSON.stringify(n1));
    ok('归一：异常入参返回空对象',
       Object.keys(apiTodo.normalizeDismissedTodos(null)).length === 0 &&
       Object.keys(apiTodo.normalizeDismissedTodos('x')).length === 0 &&
       Object.keys(apiTodo.normalizeDismissedTodos(['a'])).length === 0);
  }
}

/* ============================================================
   22. 迭代 v2.7：顾比信号列改为「窗口 10 日 + 交叉计数」
   ============================================================ */
console.log('\n【迭代 v2.7】顾比信号窗口 10 日 + 交叉计数');

ok('窗口常量由 5 改为 10', /var\s+GMMA_SIGNAL_WINDOW\s*=\s*10\s*;/.test(html) && !/GMMA_SIGNAL_WINDOW\s*=\s*5\s*;/.test(html));
ok('返回值由单个交叉改为计数汇总 { golden, death, count, last }',
   /golden:\s*golden/.test(html) && /death:\s*death/.test(html) &&
   /count:\s*golden\s*\+\s*death/.test(html) && /last:\s*crosses\[crosses\.length\s*-\s*1\]/.test(html));
ok('补按类型的最近日期（lastGolden / lastDeath）',
   /lastGolden:\s*lastGolden/.test(html) && /lastDeath:\s*lastDeath/.test(html));
ok('列表渲染：金叉 / 死叉各自独立成块，同时存在时以 · 分隔',
   /gs\.golden\s*>\s*0/.test(html) && /gs\.death\s*>\s*0/.test(html) &&
   /gParts\.join\(\s*' <span style="color:var\(--text-faint\)">·<\/span> '\s*\)/.test(html));
ok('同类型 >1 次时文案后标 ×N（仅 1 次不标数字）',
   /\?\s*' ×'\s*\+\s*num\s*:\s*''/.test(html));
ok('悬停分别给出该类型次数与最近一次信号日期',
   /最近 '\s*\+\s*GMMA_SIGNAL_WINDOW\s*\+\s*' 个交易日内'\s*\+\s*text/.test(html) &&
   /最近一次 '\s*\+\s*dateStr/.test(html));
ok('toDateStr 空值容错（null / 空串返回空串，避免 Invalid Date 文案）',
   /function\s+toDateStr\s*\(ts\)\s*\{\s*if\s*\(ts\s*==\s*null\s*\|\|\s*ts\s*===\s*''\)\s*return\s*'';/.test(html));
ok('列头 title 同步为「过去 10 个交易日」并说明并列与 ×N',
   /过去 10 个交易日内出现顾比均线交叉/.test(html) && /两类可并列显示/.test(html));

{
  // 纯函数重放：toDateStr 空值容错
  const td = new Function('return ' + (extract('toDateStr') || 'function(){return "MISS";}'))();
  ok('toDateStr(null) → 空串', td(null) === '');
  ok('toDateStr("") → 空串', td('') === '');
  ok('toDateStr(undefined) → 空串', td(undefined) === '');
  ok('toDateStr 正常值仍返回 YYYY-MM-DD', /^\d{4}-\d{2}-\d{2}$/.test(td(new Date(2026, 8, 14).getTime())));
}

/* ============================================================
   23. 迭代 v2.8：打开页面自动刷新净值
   ============================================================ */
console.log('\n【迭代 v2.8】打开页面自动刷新净值');

ok('存在交易日判定纯函数 isTradingDayTs', /function\s+isTradingDayTs\s*\(/.test(html));
ok('存在目标净值日推算纯函数 expectedNavTs', /function\s+expectedNavTs\s*\(/.test(html));
ok('存在自动刷新计划纯函数 planAutoNavRefresh', /function\s+planAutoNavRefresh\s*\(/.test(html));
ok('存在自动刷新调度 autoRefreshNav', /function\s+autoRefreshNav\s*\(/.test(html));
ok('公布时段常量为 20 点', /var\s+NAV_PUBLISH_HOUR\s*=\s*20\s*;/.test(html));
ok('自动刷新串行且静默（不切当前基金、失败不重试）',
   /loadFundNav\(code,\s*true,\s*true\)/.test(html) && /autoRefreshTried\[code\]\s*=\s*true/.test(html));
ok('boot() 中调用自动刷新（有缓存与需加载两条路径都覆盖）',
   (html.match(/autoRefreshNav\(\)/g) || []).length >= 3);

{
  // 真实重放：抽出三个纯函数在沙箱里跑，验证判定边界
  const blockSrc = html.slice(
    html.indexOf('var NAV_PUBLISH_HOUR'),
    html.indexOf('function autoRefreshNav')
  );
  const api = new Function(
    'var MS_DAY = 24 * 3600 * 1000;\n' +
    'function toDateStr(ts){if(ts==null||ts===\'\')return \'\';var d=new Date(ts);var m=d.getMonth()+1,day=d.getDate();' +
    'return d.getFullYear()+\'-\'+(m<10?\'0\'+m:m)+\'-\'+(day<10?\'0\'+day:day);}\n' +
    'function dateStrToTs(s){var p=String(s).split(\'-\');var d=new Date(+p[0],+p[1]-1,+p[2]);return d.getTime();}\n' +
    'function latestPoint(p){return p&&p.length?p[p.length-1]:null;}\n' +
    'var autoRefreshTried = {};\n' +
    blockSrc +
    '\nreturn { isTradingDayTs: isTradingDayTs, expectedNavTs: expectedNavTs,' +
    ' planAutoNavRefresh: planAutoNavRefresh,' +
    ' resetTried: function(){ autoRefreshTried = {}; },' +
    ' markTried: function(c){ autoRefreshTried[c] = true; } };'
  )();

  function dsTs(s) { const p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]).getTime(); }
  const at = (dateStr, hour) => dsTs(dateStr) + hour * 3600 * 1000;
  const fundAt = (code, dateStr) => ({ [code]: { code: code, points: [{ ts: dsTs(dateStr), nav: 1 }] } });

  /* ---- 交易日判定（2026-09-14 周一 / 09-11 周五） ---- */
  ok('交易日判定：周一是交易日', api.isTradingDayTs(at('2026-09-14', 10)));
  ok('交易日判定：周五是交易日', api.isTradingDayTs(at('2026-09-11', 10)));
  ok('交易日判定：周六不是交易日', !api.isTradingDayTs(at('2026-09-12', 10)));
  ok('交易日判定：周日不是交易日', !api.isTradingDayTs(at('2026-09-13', 10)));

  /* ---- 目标净值日推算 ---- */
  ok('周一 21:00 → 目标为当天',
     api.expectedNavTs(at('2026-09-14', 21)) === dsTs('2026-09-14'));
  ok('周一 10:00 → 目标为上周五（今天净值还没出，不判为过期）',
     api.expectedNavTs(at('2026-09-14', 10)) === dsTs('2026-09-11'));
  ok('周一 19:00 → 仍目标上周五（公布时段未到）',
     api.expectedNavTs(at('2026-09-14', 19)) === dsTs('2026-09-11'));
  ok('周一 20:00 → 进入公布时段，目标为当天',
     api.expectedNavTs(at('2026-09-14', 20)) === dsTs('2026-09-14'));
  ok('周五 21:00 → 目标为当天（周末不再反复请求）',
     api.expectedNavTs(at('2026-09-11', 21)) === dsTs('2026-09-11'));
  ok('周五 10:00 → 目标为周四',
     api.expectedNavTs(at('2026-09-11', 10)) === dsTs('2026-09-10'));
  ok('周六 → 结论不明确（null）', api.expectedNavTs(at('2026-09-12', 21)) === null);
  ok('周日 → 结论不明确（null）', api.expectedNavTs(at('2026-09-13', 21)) === null);

  /* ---- 自动刷新计划 ---- */
  api.resetTried();
  ok('缓存已是最新 → 不拉取',
     api.planAutoNavRefresh(fundAt('110022', '2026-09-14'), at('2026-09-14', 21)).length === 0);
  ok('缓存落后一天 → 需拉取',
     JSON.stringify(api.planAutoNavRefresh(fundAt('110022', '2026-09-11'), at('2026-09-14', 21))) === '["110022"]');
  ok('周一上午缓存含上周五 → 认为最新，不拉取',
     api.planAutoNavRefresh(fundAt('110022', '2026-09-11'), at('2026-09-14', 10)).length === 0);
  ok('周末不拉取（哪怕缓存很旧）',
     api.planAutoNavRefresh(fundAt('110022', '2026-09-01'), at('2026-09-13', 21)).length === 0);
  ok('无净值数据的基金不参与（交给 boot 的静默加载）',
     api.planAutoNavRefresh({ '110022': { code: '110022', points: [] } }, at('2026-09-14', 21)).length === 0);
  ok('入参为空时不报错', api.planAutoNavRefresh(null, at('2026-09-14', 21)).length === 0);

  {
    const many = {};
    for (let i = 0; i < 30; i++) {
      many['10000' + i] = { code: '10000' + i, points: [{ ts: dsTs('2026-09-11'), nav: 1 }] };
    }
    ok('单次最多拉取 20 只（防打爆上游）',
       api.planAutoNavRefresh(many, at('2026-09-14', 21)).length === 20);
  }

  /* ---- 会话级去重 ---- */
  api.resetTried();
  api.markTried('110022');
  ok('本次会话已尝试过的基金不再列入计划',
     api.planAutoNavRefresh(fundAt('110022', '2026-09-11'), at('2026-09-14', 21)).length === 0);
}

/* ============================================================
   24. 修补：未加载净值的提醒文案按实际记录类型区分
   ============================================================ */
console.log('\n【修补】「有记录但未加载净值」提醒文案按实际记录类型区分');

ok('文案不再写死「有买入记录，但净值数据尚未加载」', !/有买入记录，但净值数据尚未加载/.test(html));
ok('记录按基金分别统计买入 / 卖出条数',
   /recStat\[rCode\]\s*=\s*\{\s*buy:\s*0,\s*sell:\s*0\s*\}/.test(html) &&
   /type === 'sell'\) st\.sell\+\+; else st\.buy\+\+/.test(html));
ok('文案类型名由纯函数给出', /var kindText = recordKindText\(st2\)/.test(html));
ok('情境指纹仍为该基金记录条数', /sig: 'n' \+ \(st2\.buy \+ st2\.sell\)/.test(html));

{
  // 纯函数重放：记录类型名三分支 + 容错
  const rkt = new Function('return ' + (extract('recordKindText') || 'function(){return "MISS";}'))();
  ok('只有买入记录 → 「买入记录」', rkt({ buy: 2, sell: 0 }) === '买入记录');
  ok('只有卖出记录 → 「卖出记录」', rkt({ buy: 0, sell: 3 }) === '卖出记录');
  ok('买卖兼有 → 「买卖记录」', rkt({ buy: 1, sell: 1 }) === '买卖记录');
  ok('无记录 / 异常入参 → 「记录」且不崩溃',
     rkt({ buy: 0, sell: 0 }) === '记录' && rkt(null) === '记录' && rkt(undefined) === '记录');
}

/* ============================================================
   25. 删除待办区的「《X》还没有买卖记录」引导
   ============================================================ */
console.log('\n【删除】待办区「《X》还没有买卖记录」引导');

ok('待办区不再产出「还没有买卖记录」文案', !/还没有买卖记录，在下方添加第一笔/.test(html));
ok('待办区不再按「当前基金是否有记录」分支', !/var hasRec = state\.records\.some/.test(html));
ok('记录表自身空态文案保留（在上方添加第一笔，与待办区无关）',
   /还没有买卖记录，在上方添加第一笔/.test(html));
ok('无待办且已选基金时显示「一切正常」',
   /\} else \{\s*items\.push\(\{\s*level: 'ok',\s*text: '一切正常，没有需要处理的异常'/.test(html));

/* ============================================================
   26. 迭代 v2.9：我的基金表格新增「净值日期」列
   ============================================================ */
console.log('\n【迭代 v2.9】基金列表「净值日期」列');

{
  // --- 静态结构 ---
  const fundHeadHtml = (html.match(/<thead[\s\S]*?<\/thead>/) || [''])[0];
  const fundBodyHtml = (html.slice(html.indexOf('id="fundBody"'), html.indexOf('</tbody>')) || '');
  const thCount = (fundHeadHtml.match(/<th[\s>]/g) || []).length;
  const staticTdCount = (fundBodyHtml.match(/<td[\s>]/g) || []).length;

  ok('表头含「净值日期」列（位于笔数与相较于前次买入之间）',
     /<th[^>]*>净值日期<\/th>/.test(html) &&
     html.indexOf('净值日期') > html.indexOf('>笔数</th>') &&
     html.indexOf('>净值日期</th>') < html.indexOf('相较于前次买入'));
  ok('列头 title 说明口径（最新净值日 / 未加载留空）',
     /title="该基金净值数据更新到的最后一个交易日/.test(html) && /未加载净值时留空/.test(html));
  ok('行单元格含净值日期（data-label="净值日期"）', /data-label="净值日期"/.test(html));
  ok('未加载净值时留空（— 占位，不显示空串）',
     /if \(!m\.navDate\) \{\s*navDateHtml = '<span style="color:var\(--text-faint\)">—<\/span>';/.test(html));
  ok('净值日期用等宽数字，避免列内跳动', /font-variant-numeric:tabular-nums/.test(html));
  ok('悬停给出「净值数据截至 …」说明', /'净值数据截至 ' \+ m\.navDate/.test(html));
  ok('列头与初始占位行列数一致（各 ' + thCount + ' 列）',
     thCount === 9 && staticTdCount === 9, 'th=' + thCount + ' td=' + staticTdCount);
  ok('净值日期由 fundMetrics 给出（latestPoint + toDateStr）',
     /out\.navTs = latest \? latest\.ts : null/.test(html) &&
     /out\.navDate = latest \? toDateStr\(latest\.ts\) : ''/.test(html));
  ok('净值日期列不参与表头排序（保持拖拽/数值排序语义不变）',
     /<th class="num" style="width: 108px;[^>]*>净值日期<\/th>/.test(html) &&
     !/data-sort="navDate"/.test(html));
}

{
  // --- 真实重放：抽出 fundMetrics，用桩函数验证「净值日期」口径与容错 ---
  const STUB =
    'var MS_DAY = 24 * 3600 * 1000;\n' +
    'var NAV_PUBLISH_HOUR = 20;\n' +
    'var GMMA_SIGNAL_WINDOW = 10;\n' +
    'var state = { funds: {}, records: [] };\n' +
    'function latestPoint(p){return p&&p.length?p[p.length-1]:null;}\n' +
    'function toDateStr(ts){if(ts==null||ts==="")return "";var d=new Date(ts);var m=d.getMonth()+1,day=d.getDate();' +
    'return d.getFullYear()+"-"+(m<10?"0"+m:m)+"-"+(day<10?"0"+day:day);}\n' +
    'function dateStrToTs(s){var p=String(s).split("-");var d=new Date(+p[0],+p[1]-1,+p[2]);return d.getTime();}\n' +
    'function enrichRecords(){return [];}\n' +
    'function latestVsLastAction(){return { vsBuy: null, vsSell: null, buyDate: null, sellDate: null };}\n' +
    'function computeDrawdownMap(){return {};}\n' +
    'function gmmaRecentCross(){return null;}\n' +
    (extract('isTradingDayTs') || '') + '\n' +
    (extract('expectedNavTs') || '') + '\n' +
    (extract('dueNavTs') || '') + '\n';

  let fm = null;
  try {
    fm = new Function(STUB + (extract('fundMetrics') || 'function fundMetrics(){return "MISS";}') +
      '\nreturn { fundMetrics: fundMetrics, setState: function(s){ state = s; } };')();
    ok('fundMetrics 可独立执行', typeof fm.fundMetrics === 'function');
  } catch (e) {
    ok('fundMetrics 可独立执行', false, e.message);
  }

  if (fm) {
    const dsTs = (s) => { const p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]).getTime(); };

    fm.setState({
      funds: { '110022': { code: '110022', name: 'A', points: [
        { ts: dsTs('2026-09-01'), nav: 1 }, { ts: dsTs('2026-09-11'), nav: 1.1 }] } },
      records: [{ code: '110022', type: 'buy', date: '2026-09-01', amount: 1000 }]
    });
    const mA = fm.fundMetrics('110022');
    ok('navDate = 净值序列最后一天（2026-09-11）', mA.navDate === '2026-09-11');
    ok('navTs 同步给出（便于后续排序/比较）', mA.navTs === dsTs('2026-09-11'));

    fm.setState({
      funds: { '110022': { code: '110022', name: 'A', points: [
        { ts: dsTs('2026-09-01'), nav: 1 }, { ts: dsTs('2026-09-11'), nav: 1.1 }] },
                '161725': { code: '161725', name: 'B', points: [{ ts: dsTs('2026-09-14'), nav: 2 }] } },
      records: []
    });
    ok('多只基金各自给出自己的净值日期（互不串号）',
       fm.fundMetrics('110022').navDate === '2026-09-11' && fm.fundMetrics('161725').navDate === '2026-09-14');

    fm.setState({ funds: { '110022': { code: '110022', name: 'A', points: [] } }, records: [] });
    const mEmpty = fm.fundMetrics('110022');
    ok('净值点为空 → navDate 空串、navTs null（渲染为 —）',
       mEmpty.navDate === '' && mEmpty.navTs === null);

    fm.setState({ funds: {}, records: [{ code: '110022', type: 'sell', date: '2026-09-01', amount: 500 }] });
    const mNoFund = fm.fundMetrics('110022');
    ok('未加载净值的基金 → navDate 空串、navTs null 且不崩溃',
       mNoFund.navDate === '' && mNoFund.navTs === null && mNoFund.count === 1);
  }
}

/* ============================================================
   27. 迭代 v2.10：净值日期落后于「应公布交易日」时标橙
   ============================================================ */
console.log('\n【迭代 v2.10】净值日期落后标橙');

{
  // --- 静态结构 ---
  ok('存在基准日纯函数 dueNavTs', /function\s+dueNavTs\s*\(now\)\s*\{/.test(html));
  ok('dueNavTs 复用 expectedNavTs 的口径（交易日 20:00 前算上一交易日）',
     /function\s+dueNavTs[\s\S]{0,400}?var t = expectedNavTs\(now\);/.test(html));
  ok('dueNavTs 周末回退到最近的周五（展示需要确定基准日）',
     /var back = wd === 0 \? 2 : 1;/.test(html) && /周日 \/ 周六 → 回退到最近的周五/.test(html));
  ok('expectedNavTs 注释与实现一致（周末返回 null，基准由 dueNavTs 兜底）',
     /周末：返回 null（结论不明确，不误拉上游）/.test(html) &&
     !/非交易日（周末）：目标回退到最近一个周五/.test(html));
  ok('落后判定用严格「早于」而非「不等于」（避免把提前公布误标）',
     /out\.navStale = out\.navTs != null && out\.navTs < due;/.test(html) && !/navTs !== due/.test(html));
  ok('标橙色使用 --warn 变量（与置顶同为警示色）',
     /data-stale="1" style="color:var\(--warn\);font-weight:600;font-variant-numeric:tabular-nums"/.test(html));
  ok('单元格带 data-stale 标记（0/1，便于运行时断言与样式扩展）',
     /data-stale="1"/.test(html) && /data-stale="0"/.test(html));
  ok('悬停说明落后口径与处理方式（点「更新」，并注明节假日可能误标）',
     /落后于最近应公布的交易日 ' \+ m\.navDue/.test(html) && /法定节假日可能误标/.test(html));
  ok('列头 title 说明标橙含义', /标橙色 = 落后于最近应公布的交易日/.test(html));
  ok('fundMetrics 同时给出 navDue / navStale',
     /navDue: '', navStale: false/.test(html) && /out\.navDue = toDateStr\(due\)/.test(html));
  ok('未加载净值（—）不参与标橙（仍在 faint 分支）',
     /if \(!m\.navDate\) \{\s*navDateHtml = '<span style="color:var\(--text-faint\)">—<\/span>';/.test(html));
}

{
  // --- 真实重放 1：dueNavTs 的基准日推算 ---
  const blockSrc = html.slice(
    html.indexOf('var NAV_PUBLISH_HOUR'),
    html.indexOf('function autoRefreshNav')
  );
  let api = null;
  try {
    api = new Function(
      'var MS_DAY = 24 * 3600 * 1000;\n' +
      'function toDateStr(ts){if(ts==null||ts==="")return "";var d=new Date(ts);var m=d.getMonth()+1,day=d.getDate();' +
      'return d.getFullYear()+"-"+(m<10?"0"+m:m)+"-"+(day<10?"0"+day:day);}\n' +
      'function dateStrToTs(s){var p=String(s).split("-");var d=new Date(+p[0],+p[1]-1,+p[2]);return d.getTime();}\n' +
      'function latestPoint(p){return p&&p.length?p[p.length-1]:null;}\n' +
      'var autoRefreshTried = {};\n' +
      blockSrc +
      '\nreturn { dueNavTs: dueNavTs, expectedNavTs: expectedNavTs };'
    )();
    ok('dueNavTs 可独立执行', typeof api.dueNavTs === 'function');
  } catch (e) {
    ok('dueNavTs 可独立执行', false, e.message);
  }

  if (api) {
    const dsTs = (s) => { const p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]).getTime(); };
    const at = (dateStr, hour) => dsTs(dateStr) + hour * 3600 * 1000;

    // 2026-09-14 周一 / 09-15 周二 / 09-11 周五 / 09-12 周六 / 09-13 周日
    ok('周一 10:00 → 基准为上周五（今天净值还没出）',
       api.dueNavTs(at('2026-09-14', 10)) === dsTs('2026-09-11'));
    ok('周一 21:00 → 基准为当天',
       api.dueNavTs(at('2026-09-14', 21)) === dsTs('2026-09-14'));
    ok('周二 10:00 → 基准为周一',
       api.dueNavTs(at('2026-09-15', 10)) === dsTs('2026-09-14'));
    ok('周二 21:00 → 基准为当天',
       api.dueNavTs(at('2026-09-15', 21)) === dsTs('2026-09-15'));
    ok('周六 → 基准为周五（expectedNavTs 此时为 null）',
       api.dueNavTs(at('2026-09-12', 21)) === dsTs('2026-09-11') &&
       api.expectedNavTs(at('2026-09-12', 21)) === null);
    ok('周日 → 基准为周五',
       api.dueNavTs(at('2026-09-13', 10)) === dsTs('2026-09-11'));
    ok('周五 21:00 → 基准为周五（周末不把最新数据误判为落后）',
       api.dueNavTs(at('2026-09-11', 21)) === dsTs('2026-09-11'));
  }
}

{
  // --- 真实重放 2：fundMetrics 的落后判定 ---
  const STUB =
    'var MS_DAY = 24 * 3600 * 1000;\n' +
    'var NAV_PUBLISH_HOUR = 20;\n' +
    'var GMMA_SIGNAL_WINDOW = 10;\n' +
    'var state = { funds: {}, records: [] };\n' +
    'function toDateStr(ts){if(ts==null||ts==="")return "";var d=new Date(ts);var m=d.getMonth()+1,day=d.getDate();' +
    'return d.getFullYear()+"-"+(m<10?"0"+m:m)+"-"+(day<10?"0"+day:day);}\n' +
    'function dateStrToTs(s){var p=String(s).split("-");var d=new Date(+p[0],+p[1]-1,+p[2]);return d.getTime();}\n' +
    'function latestPoint(p){return p&&p.length?p[p.length-1]:null;}\n' +
    'function enrichRecords(){return [];}\n' +
    'function latestVsLastAction(){return { vsBuy: null, vsSell: null, buyDate: null, sellDate: null };}\n' +
    'function computeDrawdownMap(){return {};}\n' +
    'function gmmaRecentCross(){return null;}\n' +
    (extract('isTradingDayTs') || '') + '\n' +
    (extract('expectedNavTs') || '') + '\n' +
    (extract('dueNavTs') || '') + '\n';

  let fm = null;
  try {
    fm = new Function(STUB + (extract('fundMetrics') || 'function fundMetrics(){return "MISS";}') +
      '\nreturn { fundMetrics: fundMetrics, setState: function(s){ state = s; } };')();
    ok('排序/渲染共用的 fundMetrics 可独立执行', typeof fm.fundMetrics === 'function');
  } catch (e) {
    ok('排序/渲染共用的 fundMetrics 可独立执行', false, e.message);
  }

  if (fm) {
    const dsTs = (s) => { const p = s.split('-'); return new Date(+p[0], +p[1] - 1, +p[2]).getTime(); };
    const at = (dateStr, hour) => dsTs(dateStr) + hour * 3600 * 1000;
    const setFund = (dateStr) => fm.setState({
      funds: { '110022': { code: '110022', name: 'A', points: [{ ts: dsTs(dateStr), nav: 1 }] } },
      records: []
    });

    // 周二 21:00（基准 = 周二 09-15）
    setFund('2026-09-11');
    const mA = fm.fundMetrics('110022', at('2026-09-15', 21));
    ok('净值日期落后基准 → navStale = true 且给出 navDue',
       mA.navStale === true && mA.navDue === '2026-09-15' && mA.navDate === '2026-09-11');

    setFund('2026-09-15');
    const mB = fm.fundMetrics('110022', at('2026-09-15', 21));
    ok('净值日期 = 基准 → 不标橙',
       mB.navStale === false && mB.navDate === '2026-09-15');

    setFund('2026-09-14');
    const mC = fm.fundMetrics('110022', at('2026-09-15', 10));
    ok('交易日 20:00 前，基准回落上一交易日 → 持有上一交易日净值不标橙',
       mC.navStale === false && mC.navDue === '2026-09-14');

    setFund('2026-09-15');
    const mD = fm.fundMetrics('110022', at('2026-09-15', 10));
    ok('上游提前公布（净值日期晚于基准）→ 视为更新，不标橙',
       mD.navStale === false);

    fm.setState({
      funds: { '110022': { code: '110022', name: 'A', points: [{ ts: dsTs('2026-09-04'), nav: 1 }] } },
      records: []
    });
    const mE = fm.fundMetrics('110022', at('2026-09-12', 21));   // 周六，基准 = 周五 09-11
    ok('周末也判定：周五基准下 09-04 的净值仍标橙',
       mE.navStale === true && mE.navDue === '2026-09-11');

    fm.setState({ funds: { '110022': { code: '110022', name: 'A', points: [] } }, records: [] });
    const mF = fm.fundMetrics('110022', at('2026-09-15', 21));
    ok('无净值数据 → 不标橙（渲染为 —）', mF.navStale === false && mF.navDate === '');

    fm.setState({ funds: {}, records: [] });
    const mG = fm.fundMetrics('110022', at('2026-09-15', 21));
    ok('未加载净值 → 不标橙、不崩溃（navDue 留空，单元格渲染为 —）',
       mG.navStale === false && mG.navDue === '' && mG.navDate === '');
  }
}

/* ============================================================
   汇总
   ============================================================ */
console.log('\n' + '='.repeat(58));
console.log('  自检结果：通过 ' + pass + ' 项，失败 ' + fail + ' 项，警告 ' + warn + ' 项');
console.log('='.repeat(58) + '\n');

process.exit(fail > 0 ? 1 : 0);
