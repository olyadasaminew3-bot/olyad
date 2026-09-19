/* Static sanity checks for the Trade AI page:
   - every #id the JS looks up exists in trade.html (or is created by the JS)
   - every class the JS renders has a rule in trade.css
   - trade.html has balanced tags and loads all five scripts in order
   Run: node tools/check-ui.mjs                                            */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');
const read = (p) => fs.readFileSync(path.join(root, p), 'utf8');

const html = read('trade.html');
const js = read('js/trade-ai.js');
const chartJs = read('js/trade-chart.js');
const css = read('css/trade.css');

let problems = 0;
const warn = (msg) => { problems++; console.log(`  MISSING  ${msg}`); };
const ok = (msg) => console.log(`  ok       ${msg}`);

/* 1. ids ------------------------------------------------------------- */
const htmlIds = new Set([...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]));
// ids the JS injects via template strings or className-style assignment
const jsCreatedIds = new Set([
  ...[...js.matchAll(/\.id\s*=\s*'([^']+)'/g)].map((m) => m[1]),
  ...[...js.matchAll(/id="([A-Za-z0-9_-]+)"/g)].map((m) => m[1]),
]);
const chartCreatedIds = new Set([...chartJs.matchAll(/\.id\s*=\s*'([^']+)'/g)].map((m) => m[1]));
const wanted = new Set([
  ...[...js.matchAll(/\$\('#([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]),
  ...[...js.matchAll(/getElementById\('([A-Za-z0-9_-]+)'\)/g)].map((m) => m[1]),
  ...[...js.matchAll(/\$\$\('#([A-Za-z0-9_-]+)\s+/g)].map((m) => m[1]),
]);
for (const id of wanted) {
  if (htmlIds.has(id)) ok(`#${id} present in trade.html`);
  else if (jsCreatedIds.has(id) || chartCreatedIds.has(id)) ok(`#${id} created by JS`);
  else warn(`#${id} referenced by trade-ai.js but not found anywhere`);
}
for (const id of ['statusBar', 'runBtn', 'chart', 'chatLog', 'journalCard', 'watchCard', 'planCard', 'linesCard', 'signalsCard', 'levelsCard', 'narrativeCard', 'verdictCard', 'chatSection']) {
  if (!htmlIds.has(id)) warn(`#${id} missing from trade.html`);
}

/* 2. classes rendered by JS must exist in the stylesheet ------------ */
const cssClasses = new Set([...css.matchAll(/\.([a-zA-Z][a-zA-Z0-9_-]*)/g)].map((m) => m[1]));
const dynamicTemplates = [
  ...[...js.matchAll(/class="([^"]*)"/g)].map((m) => m[1]),
  ...[...js.matchAll(/className\s*=\s*`([^`]*)`/g)].map((m) => m[1]),
  ...[...js.matchAll(/className\s*=\s*'([^']*)'/g)].map((m) => m[1]),
  ...[...chartJs.matchAll(/className\s*=\s*'([^']*)'/g)].map((m) => m[1]),
  ...[...chartJs.matchAll(/class="([^"]*)"/g)].map((m) => m[1]),
].join(' ');
const used = new Set();
for (const token of dynamicTemplates.split(/[\s${}?:()]+/)) {
  const t = token.trim();
  if (/^[a-zA-Z][a-zA-Z0-9_-]*$/.test(t) && /^(ta-|green|red|small|hidden)/.test(t)) used.add(t);
}
// classes that only exist at runtime get their colour/hook elsewhere
const ignorable = new Set(['ta-active']);
for (const c of used) {
  if (cssClasses.has(c) || ignorable.has(c)) ok(`.${c} styled`);
  else warn(`.${c} used in JS but not defined in trade.css`);
}

/* 3. html structure -------------------------------------------------- */
const stack = [];
const voidTags = new Set(['meta', 'link', 'br', 'hr', 'img', 'input', 'source', 'path']);
let tagProblem = false;
for (const m of html.matchAll(/<(\/?)([a-zA-Z][a-zA-Z0-9]*)\b[^>]*?(\/?)>/g)) {
  const [, close, tag, selfClose] = m;
  const t = tag.toLowerCase();
  if (voidTags.has(t) || selfClose) continue;
  if (!close) stack.push(t);
  else {
    const last = stack.pop();
    if (last !== t) { warn(`unbalanced tag: expected </${last}> but found </${t}>`); tagProblem = true; break; }
  }
}
if (!tagProblem && stack.length) warn(`unclosed tags: ${stack.join(', ')}`);
else if (!tagProblem) ok('trade.html tags are balanced');

const scripts = [...html.matchAll(/<script src="([^"]+)"/g)].map((m) => m[1]);
const expect = ['js/trade-engine.js', 'js/trade-data.js', 'js/trade-chart.js', 'js/trade-bot.js', 'js/trade-ai.js'];
if (JSON.stringify(scripts) === JSON.stringify(expect)) ok('script load order is correct');
else warn(`script order ${scripts.join(' → ')}`);
for (const s of scripts) if (!fs.existsSync(path.join(root, s))) warn(`${s} does not exist`);
for (const href of [...html.matchAll(/<link rel="stylesheet" href="([^"]+)"/g)].map((m) => m[1])) {
  if (href.startsWith('http')) continue;
  if (!fs.existsSync(path.join(root, href))) warn(`${href} missing`);
  else ok(`stylesheet ${href} exists`);
}

/* 4. cross-file guards ------------------------------------------------ */
if (!js.includes('window.TradeEngine') || !js.includes('window.TradeData')) warn('trade-ai.js does not reference the global engine/data modules');
else ok('trade-ai.js wires the global modules');

console.log(`\n${problems === 0 ? 'UI checks passed — no problems found.' : `${problems} problem(s) found.`}\n`);
process.exit(problems ? 1 : 0);
