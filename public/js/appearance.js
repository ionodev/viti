// The theme (System, Light, Dark) and the accent colour (a few to pick from, or any colour): the
// controls for Settings and the home screen. theme.js puts the choice on the page and keeps it.
import { h } from './ui.js';

export function appearanceControls() {
  const T = window.vitiTheme;
  const themes = h('div', { class: 'theme-row' }, [['system', 'System'], ['light', 'Light'], ['dark', 'Dark']].map(([k, label]) => h('button', { type: 'button', dataset: { k }, onclick: () => (T.set({ theme: k }), paint()) }, label)));
  // any colour: seen at once while it is dragged, kept when it is let go
  const custom = h('input', { type: 'color', title: 'Any colour you like', oninput: () => (T.preview({ accent: custom.value }), paint()), onchange: () => T.set({ accent: custom.value }) });
  const accents = h(
    'div',
    { class: 'accents' },
    T.ACCENTS.map((c) => h('button', { type: 'button', class: 'acc', style: { '--c': c }, title: c, dataset: { c }, onclick: () => (T.set({ accent: c }), paint()) })),
    h('label', { class: 'custom' }, custom, 'Custom'),
  );
  const paint = () => {
    const p = T.get();
    themes.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b.dataset.k === p.theme));
    accents.querySelectorAll('.acc').forEach((b) => b.classList.toggle('on', b.dataset.c === p.accent));
    custom.value = p.accent;
  };
  paint();
  return [h('p', { class: 'label' }, 'Theme'), themes, h('p', { class: 'label' }, 'Accent colour'), accents];
}
