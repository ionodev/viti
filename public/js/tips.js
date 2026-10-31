// The first time you open a project on this computer: a few pointers in a card at the bottom right, until you
// close it ("Got it"). Remembered on this computer.
import { h } from './ui.js';

const KEY = 'viti.tips';

export function firstTips() {
  try {
    if (localStorage.getItem(KEY)) return;
  } catch {
    return;
  }
  const tip = (keys, text) => h('li', {}, keys ? h('kbd', {}, keys) : null, h('span', {}, text));
  const card = h(
    'div',
    { class: 'tips', role: 'dialog', 'aria-label': 'A few pointers' },
    h('b', {}, 'A few pointers'),
    h(
      'ul',
      {},
      tip('Ctrl K', 'Search everything, and jump to it.'),
      tip('?', 'All the keyboard shortcuts.'),
      tip('', 'Every section has a chat: open it with the Chat button at the top.'),
      tip('', 'Right-click a card, a note or a section for everything you can do with it.'),
      tip('', 'Theme, accent colour and more are in Settings, at the bottom of the menu.'),
    ),
    h('button', { class: 'btn small', type: 'button', onclick: () => close() }, 'Got it'),
  );
  const close = () => {
    card.remove();
    try {
      localStorage.setItem(KEY, '1');
    } catch {}
  };
  document.body.append(card);
}
