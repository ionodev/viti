// Markdown, everywhere text is written: rendered with marked, then sanitized (nothing a note or a
// message says can run code), with clickable task lists and a way to light up quoted text.
import { marked } from '/vendor/marked.js';
import DOMPurify from '/vendor/purify.js';

marked.setOptions({ gfm: true, breaks: true });

DOMPurify.addHook('afterSanitizeAttributes', (node) => {
  if (node.tagName === 'A') {
    node.setAttribute('target', '_blank');
    node.setAttribute('rel', 'noopener noreferrer');
  }
  if (node.tagName === 'IMG') {
    // only pictures of the hub's own, or from other sites by https
    const src = node.getAttribute('src') || '';
    if (!/^(\/api\/images\/[a-f0-9]{24}$|https:\/\/)/.test(src)) node.remove();
    else {
      node.setAttribute('loading', 'lazy');
      node.setAttribute('referrerpolicy', 'no-referrer');
    }
  }
  if (node.tagName === 'INPUT' && node.getAttribute('type') !== 'checkbox') node.remove();
});

export const sanitize = (html) => DOMPurify.sanitize(html, { FORBID_TAGS: ['style', 'form', 'textarea', 'select', 'button', 'iframe', 'object', 'embed'], FORBID_ATTR: ['style'] });
export const html = (md) => sanitize(marked.parse(String(md || '')));

// ---------- equations: $x^2$ inline and $$ ... $$ as a block (KaTeX, loaded the first time one is shown) ----------
// The equations are lifted out before the markdown is read (so _ and * in them are left alone), and put back, drawn, after.
const MQ = '\uE000';
const MZ = '\uE001';
function takeMath(md) {
  const math = [];
  const put = (tex, display) => MQ + (math.push({ tex, display }) - 1) + MZ;
  const text = String(md || '')
    .split(/(```[\s\S]*?```|~~~[\s\S]*?~~~|`[^`\n]*`)/)
    .map((part, i) => (i % 2 ? part : part.replace(/\$\$([\s\S]+?)\$\$/g, (m, t) => put(t.trim(), true)).replace(/(?<![\\$])\$(?!\s)([^$\n]*?[^\s$\\])\$(?!\d)/g, (m, t) => put(t, false))))
    .join('');
  return { text, math };
}
let katex = null;
const loadKatex = () => (katex ||= import('/vendor/katex.mjs').then((m) => m.default || m));
function fillMath(el, math) {
  const walker = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
  const nodes = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.nodeValue.includes(MQ)) nodes.push(n);
  const spans = [];
  for (const n of nodes) {
    const frag = document.createDocumentFragment();
    // (split with a capture group: text, number, text, number, …)
    for (const [i, part] of n.nodeValue.split(new RegExp(MQ + '(\\d+)' + MZ)).entries()) {
      if (i % 2 === 0) frag.append(part);
      else if (math[Number(part)]) {
        const m = math[Number(part)];
        const span = document.createElement(m.display ? 'div' : 'span');
        span.className = 'math' + (m.display ? ' display' : '');
        span.textContent = m.display ? '$$' + m.tex + '$$' : '$' + m.tex + '$'; // (until the equation is drawn)
        span._tex = m;
        spans.push(span);
        frag.append(span);
      } else frag.append(part);
    }
    n.replaceWith(frag);
  }
  if (spans.length)
    loadKatex().then((k) => {
      for (const span of spans) {
        try {
          span.innerHTML = k.renderToString(span._tex.tex, { displayMode: span._tex.display, throwOnError: false, trust: false, output: 'htmlAndMathml' });
          span.title = span._tex.tex;
        } catch {}
      }
    }, () => {});
}

// Renders into `el`. With onToggle(newMarkdown) given, the task-list boxes can be ticked.
export function renderInto(el, md, onToggle) {
  const { text, math } = takeMath(md);
  el.innerHTML = html(text);
  if (math.length) fillMath(el, math);
  const boxes = [...el.querySelectorAll('input[type=checkbox]')];
  boxes.forEach((box, i) => {
    box.removeAttribute('disabled');
    if (!onToggle) return box.setAttribute('disabled', '');
    box.addEventListener('click', (e) => {
      e.stopPropagation();
      const next = toggleTask(md, i);
      if (next !== md) onToggle(next);
    });
  });
}

// ticks or unticks the n-th task-list line of the markdown (not counting code blocks)
export function toggleTask(md, n) {
  const lines = String(md).split('\n');
  let seen = -1;
  let fence = false;
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) fence = !fence;
    if (fence) continue;
    const m = lines[i].match(/^(\s*(?:[-*+]|\d+[.)])\s+)\[( |x|X)\](.*)$/);
    if (m && ++seen === n) {
      lines[i] = `${m[1]}[${m[2] === ' ' ? 'x' : ' '}]${m[3]}`;
      break;
    }
  }
  return lines.join('\n');
}

// ---------- finding and lighting up quoted text ----------
const BLOCK = new Set(['P', 'LI', 'DIV', 'H1', 'H2', 'H3', 'H4', 'H5', 'H6', 'PRE', 'BLOCKQUOTE', 'TD', 'TH', 'TR', 'UL', 'OL']);
const blockOf = (node, root) => {
  let n = node.parentElement;
  while (n && n !== root && !BLOCK.has(n.tagName)) n = n.parentElement;
  return n;
};

// a Range over the (whitespace-collapsed, case-insensitive) text, wherever it sits in the rendered markup
export function findRange(root, text) {
  const want = String(text || '').replace(/\s+/g, ' ').trim().toLowerCase();
  if (!want) return null;
  let full = '';
  const map = [];
  let prevSpace = true;
  let prevBlock = null;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  while (walker.nextNode()) {
    const node = walker.currentNode;
    const block = blockOf(node, root);
    if (prevBlock && block !== prevBlock && !prevSpace && map.length) {
      full += ' ';
      map.push(map[map.length - 1]);
      prevSpace = true;
    }
    prevBlock = block;
    for (let i = 0; i < node.data.length; i++) {
      const space = /\s/.test(node.data[i]);
      if (space && prevSpace) continue;
      full += space ? ' ' : node.data[i].toLowerCase();
      map.push([node, i]);
      prevSpace = space;
    }
  }
  const at = full.indexOf(want);
  if (at < 0) return null;
  const a = map[at];
  const b = map[at + want.length - 1];
  const range = document.createRange();
  range.setStart(a[0], a[1]);
  range.setEnd(b[0], b[1] + 1);
  return range;
}

let clearTimer = 0;
// lights up `text` inside `root` for a few seconds; false if it isn't there (any more)
export function highlight(root, text) {
  const range = findRange(root, text);
  if (!range || !globalThis.CSS?.highlights) return !!range;
  CSS.highlights.set('quote', new Highlight(range));
  clearTimeout(clearTimer);
  clearTimer = setTimeout(() => CSS.highlights.delete('quote'), 5000);
  return true;
}
