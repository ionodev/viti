// Personal settings, kept in this browser (so each device has its own), and the little sounds and pop-ups they control.
import { appearanceControls } from './appearance.js';
import { h, modal, toast } from './ui.js';

const KEY = 'hub.settings';
export const DEFAULTS = {
  mute: false, // no notification sound
  volume: 60, // 0..100
  soundOnlyAway: false, // only make a sound when this tab is not the one you are looking at
  desktop: false, // a pop-up from the browser when you are somewhere else
  titleCount: true, // "(3) Viti" in the tab title
  animate: true, // the menus slide
  cursors: true, // see other people's mouse pointers on a board
  confirmDelete: true, // ask "Delete?" before something is deleted
  autoFit: false, // a board you have not looked at before opens fitted to the screen
  deadHigh: 7, // days to the deadline of a high priority task (blank: no deadline)
  deadMedium: 14,
  deadLow: '', // low priority: no deadline unless you give one
  deadRef: 'today', // the day the days are counted from: today, or the next Monday, Tuesday… ('1'..'6', '0' is Sunday)
};

// the deadline (YYYY-MM-DD, or '') a task gets when it is given a priority, from the days set in Settings
export function deadlineFor(priority) {
  const s = settings();
  const days = s['dead' + priority.charAt(0).toUpperCase() + priority.slice(1)];
  if (days === '' || days == null || !Number.isFinite(Number(days))) return '';
  const d = new Date();
  d.setHours(12, 0, 0, 0);
  if (s.deadRef !== 'today') d.setDate(d.getDate() + ((Number(s.deadRef) - d.getDay() + 7) % 7));
  d.setDate(d.getDate() + Math.round(Number(days)));
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

let cache = null;
const listeners = new Set();
export function settings() {
  if (cache) return cache;
  let saved = {};
  try {
    saved = JSON.parse(localStorage.getItem(KEY) || '{}');
  } catch {}
  cache = { ...DEFAULTS, ...saved };
  return cache;
}
export function setSetting(k, v) {
  cache = { ...settings(), [k]: v };
  try {
    localStorage.setItem(KEY, JSON.stringify(cache));
  } catch {}
  for (const f of listeners) f(k, v);
}
export const onSetting = (f) => listeners.add(f);

// ------------------------------------------------------------------ the sound: a short two-note chime (no sound file needed)
let ctx = null;
function audio() {
  if (!ctx) {
    try {
      ctx = new (window.AudioContext || window.webkitAudioContext)();
    } catch {
      return null;
    }
  }
  if (ctx.state === 'suspended') ctx.resume().catch(() => {});
  return ctx;
}
// browsers only allow sound after you have clicked or typed on the page once
for (const ev of ['pointerdown', 'keydown']) document.addEventListener(ev, () => audio(), { once: true, capture: true });

export function chime(force = false) {
  const s = settings();
  if (s.mute && !force) return;
  const a = audio();
  if (!a || a.state !== 'running') return;
  const vol = Math.max(0, Math.min(1, s.volume / 100)) * 0.25;
  const t0 = a.currentTime;
  [[880, 0], [1318.5, 0.12]].forEach(([freq, at]) => {
    const o = a.createOscillator();
    const g = a.createGain();
    o.type = 'sine';
    o.frequency.value = freq;
    g.gain.setValueAtTime(0.0001, t0 + at);
    g.gain.exponentialRampToValueAtTime(Math.max(vol, 0.0002), t0 + at + 0.02);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + at + 0.45);
    o.connect(g).connect(a.destination);
    o.start(t0 + at);
    o.stop(t0 + at + 0.5);
  });
}

// ------------------------------------------------------------------ a new message from someone else
export function announce(msg, where, onClick) {
  const s = settings();
  const away = document.hidden || !document.hasFocus();
  if (!s.soundOnlyAway || away) chime();
  if (s.desktop && away && 'Notification' in window && Notification.permission === 'granted') {
    try {
      const n = new Notification(`${msg.name || 'Someone'} in ${where}`, { body: String(msg.body || 'Sent a reference').slice(0, 140), tag: `hub-${msg.section}`, icon: '/favicon.png' });
      n.onclick = () => {
        window.focus();
        onClick?.();
        n.close();
      };
    } catch {}
  }
}

// ------------------------------------------------------------------ the Settings window
export async function openSettings() {
  const s = settings();
  const row = (key, title, hint) => {
    const box = h('input', { type: 'checkbox' });
    box.checked = !!s[key];
    box.addEventListener('change', async () => {
      if (key === 'desktop' && box.checked) {
        const ok = 'Notification' in window && (Notification.permission === 'granted' || (await Notification.requestPermission()) === 'granted');
        if (!ok) {
          box.checked = false;
          return toast('Windows did not allow notifications from Viti. You can allow them in Settings › System › Notifications.', true);
        }
      }
      setSetting(key, box.checked);
    });
    return h('label', { class: 'setrow' }, box, h('span', {}, h('b', {}, title), hint ? h('small', {}, hint) : null));
  };
  const vol = h('input', { type: 'range', min: '0', max: '100', value: String(s.volume) });
  vol.addEventListener('input', () => setSetting('volume', Number(vol.value)));
  vol.addEventListener('change', () => chime(true));
  const body = h(
    'div',
    { class: 'settings' },
    ...appearanceControls(),
    h('p', { class: 'label' }, 'Sound'),
    row('mute', 'Mute notification sound', 'No chime when someone else writes.'),
    h('div', { class: 'setvol' }, h('span', {}, 'Volume'), vol, h('button', { class: 'btn small ghost', onclick: () => chime(true) }, 'Test')),
    row('soundOnlyAway', 'Only play it when I am somewhere else', 'Stay quiet while the Viti window is the one in front.'),
    h('p', { class: 'label' }, 'Alerts'),
    row('desktop', 'Windows notifications', 'A notification from Windows when Viti is in the background.'),
    row('titleCount', 'Show the unread count in the window title', 'For example: (3) Viti'),
    h('p', { class: 'label' }, 'Look and feel'),
    row('animate', 'Slide the menus', 'Turn off for instant opening and closing.'),
    row('cursors', "Show other people's pointers on a board"),
    row('autoFit', 'Auto fitting', 'Every board you open is fitted to the screen, instead of showing where you left it.'),
    row('confirmDelete', 'Confirm before deleting', 'Ask "Delete?" before a section, category or trash item is removed for good.'),
    h('p', { class: 'label' }, 'Deadlines'),
    h('p', { class: 'hint' }, 'A task given a priority gets a deadline this many days after the reference day (blank: no deadline). It shows in the Calendar. You can still change the date of one task by clicking it.'),
    ...[['deadHigh', 'High priority'], ['deadMedium', 'Medium priority'], ['deadLow', 'Low priority']].map(([key, label]) => {
      const inp = h('input', { type: 'number', min: '0', max: '3650', step: '1', placeholder: 'none', value: String(s[key] ?? '') });
      inp.addEventListener('input', () => setSetting(key, inp.value === '' ? '' : Math.max(0, Math.round(Number(inp.value)))));
      return h('div', { class: 'setvol' }, h('span', {}, label), inp, h('span', {}, 'days'));
    }),
    (() => {
      const sel = h('select', {}, h('option', { value: 'today' }, 'Today'), ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'].map((d, i) => h('option', { value: String(i) }, 'The next ' + d)));
      sel.value = String(s.deadRef);
      sel.addEventListener('change', () => setSetting('deadRef', sel.value));
      return h('div', { class: 'setvol' }, h('span', {}, 'Count from'), sel);
    })(),
    h('p', { class: 'hint' }, 'These settings are kept on this computer.'),
  );
  await modal('Settings', body, [{ label: 'Done', value: true, primary: true }]);
}
