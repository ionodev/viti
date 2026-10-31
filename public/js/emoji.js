// The emoji picker for the chat: a small panel with a tab for each kind of emoji. Pick one and it is put in the box.
import { h } from './ui.js';

const GROUPS = [
  ['\u{1F600}', 'Faces', '😀 😃 😄 😁 😆 😅 😂 🤣 🙂 🙃 😉 😊 😇 🥰 😍 🤩 😘 😋 😛 😜 🤪 😝 🤗 🤔 🤨 😐 😑 😶 🙄 😏 😣 😥 😮 😯 😪 😫 🥱 😴 😌 😎 🤓 🧐 😕 😟 🙁 😮‍💨 😢 😭 😤 😠 😡 🤬 🤯 😳 🥵 🥶 😱 😨 😰 😓 🤫 🫡 🫠 🥳 🥺 😬 🤐 🤥 🤒 🤕 🤢 🤮 🥴 😵 🤠 😈 💀 👻 👽 🤖 💩'],
  ['\u{1F44D}', 'Hands', '👍 👎 👌 🤌 ✌️ 🤞 🤟 🤘 🤙 👈 👉 👆 👇 ☝️ ✋ 🤚 🖐️ 🖖 👋 🤝 🙏 👏 🙌 👐 🤲 💪 ✍️ 🫶 🫰 🫵 👀 🧠 👂 👃'],
  ['❤️', 'Hearts', '❤️ 🧡 💛 💚 💙 💜 🖤 🤍 🤎 💔 ❤️‍🔥 💕 💞 💓 💗 💖 💘 💝 💯 💢 💥 💫 💦 💨 🔥 ✨ ⭐ 🌟 ⚡ 🎉 🎊 🏆 🥇 🎯'],
  ['\u{1F332}', 'Game and world', '🎮 🕹️ 👾 🧟 🧛 🧙 🧝 ⚔️ 🗡️ 🏹 🛡️ 🔫 💣 🔦 🔑 🗝️ 🗺️ 🧭 ⛺ 🏠 🏚️ 🏭 🏥 🚗 🚙 🚁 ✈️ ⛵ 🚲 🌲 🌳 🌴 ⛰️ 🌊 🌧️ ❄️ ☀️ 🌙 🌫️ 🐺 🐻 🦌 🐕 🐈 🐟 🦅 🍖 🍞 🥫 💧 🩹 💊 🔋 📻 🔥'],
  ['\u{1F4BB}', 'Work', '💻 🖥️ ⌨️ 🖱️ 💾 📁 📂 📝 📋 📌 📎 ✂️ 🔧 🔨 ⚙️ 🧰 🔍 🔎 💡 📅 📆 ⏰ ⏳ ✅ ☑️ ✔️ ❌ ❎ ⚠️ ❓ ❗ ➕ ➖ ➡️ ⬅️ ⬆️ ⬇️ 🔁 🔄 📈 📉 🐛 🚧 🚀 🏁 🔒 🔓 🏷️ 📢 💬 💭'],
];

let open = null;

// shows the picker above `anchor`; `pick(emoji)` is called with the chosen one
export function emojiPicker(anchor, pick) {
  if (open) {
    const was = open.anchor;
    open.close();
    if (was === anchor) return;
  }
  const panel = h('div', { class: 'emoji-pop' });
  const tabs = h('div', { class: 'emoji-tabs' });
  const grid = h('div', { class: 'emoji-grid' });
  const show = (i) => {
    [...tabs.children].forEach((b, j) => b.classList.toggle('on', i === j));
    grid.replaceChildren(...GROUPS[i][2].split(' ').map((e) => h('button', { type: 'button', class: 'emoji', onclick: () => pick(e) }, e)));
    grid.scrollTop = 0;
  };
  GROUPS.forEach(([icon, title], i) => tabs.append(h('button', { type: 'button', title, onclick: () => show(i) }, icon)));
  panel.append(tabs, grid);
  document.body.append(panel);
  show(0);
  const r = anchor.getBoundingClientRect();
  const pr = panel.getBoundingClientRect();
  panel.style.left = Math.max(8, Math.min(innerWidth - pr.width - 8, r.right - pr.width)) + 'px';
  panel.style.top = Math.max(8, r.top - pr.height - 8) + 'px';
  const away = (e) => !panel.contains(e.target) && e.target !== anchor && close();
  const onKey = (e) => e.key === 'Escape' && close();
  const close = () => {
    panel.remove();
    document.removeEventListener('mousedown', away, true);
    document.removeEventListener('keydown', onKey, true);
    open = null;
  };
  document.addEventListener('mousedown', away, true);
  document.addEventListener('keydown', onKey, true);
  open = { anchor, close };
}
