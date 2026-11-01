// About Viti: the version, where your data is kept, the log, and where to go with problems and ideas. Opened from
// the home screen and from Settings.
import { h, modal, toast } from './ui.js';
import { updateRow } from './update.js';

export async function openAbout() {
  let a = {};
  try {
    a = await fetch('/app/about').then((r) => r.json());
  } catch {}
  const repo = `https://github.com/${a.repo || 'ionodev/viti'}`;
  const reveal = (what) =>
    fetch('/app/reveal', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ what }) })
      .then((r) => r.json())
      .then((r) => !r.ok && toast(r.error || 'It could not be opened.', true))
      .catch(() => toast('It could not be opened.', true));
  const row = (title, text, button) => h('div', { class: 'about-row' }, h('div', {}, h('b', {}, title), h('small', {}, text)), button);
  const btn = (label, fn) => h('button', { class: 'btn small ghost', type: 'button', onclick: fn }, label);
  const body = h(
    'div',
    { class: 'about' },
    h('div', { class: 'about-head' }, h('span', { class: 'cairn-mark' }), h('div', {}, h('b', {}, 'Viti'), h('span', {}, a.version ? `Version ${a.version}` : ''))),
    h('p', {}, 'A shared workspace for your project on GitHub. Free and open source.'),
    h(
      'div',
      { class: 'about-rows' },
      row('Your data', a.dataDir || 'On this computer.', a.canOpen ? btn('Open folder', () => reveal('data')) : null),
      a.logFile ? row('The log', 'What Viti did, and anything that went wrong. Handy when you report a problem.', a.canOpen ? btn('Open the log', () => reveal('log')) : null) : null,
      await updateRow(row, btn),
      row('Problems and ideas', 'Tell us on GitHub.', btn('Report a problem', () => window.open(`${repo}/issues/new`))),
    ),
  );
  return modal('About Viti', body, [{ label: 'Close', value: true, primary: true }]);
}
