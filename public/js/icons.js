// Viti's icons: simple line drawings (in the text's colour), one set for the whole app, instead of emoji.
// icon(name) -> a <span class="ic"> with the drawing; kindIcon(kind) -> the icon for a kind of section.
const P = {
  clip: '<path d="M20.5 11.5l-8.2 8.2a5 5 0 0 1-7.1-7.1l8.5-8.5a3.3 3.3 0 0 1 4.7 4.7l-8.4 8.4a1.7 1.7 0 0 1-2.4-2.4l7.7-7.7"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1 1"/><path d="M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1-1"/>',
  smile: '<circle cx="12" cy="12" r="8.5"/><path d="M8.5 14.2a4.6 4.6 0 0 0 7 0"/><path d="M9.2 9.6h.01M14.8 9.6h.01" stroke-width="2.6"/>',
  gear: '<circle cx="12" cy="12" r="3.2"/><path d="M12 3v2.4M12 18.6V21M3 12h2.4M18.6 12H21M5.6 5.6l1.7 1.7M16.7 16.7l1.7 1.7M5.6 18.4l1.7-1.7M16.7 7.3l1.7-1.7"/>',
  pen: '<path d="M4 20h4L19 9l-4-4L4 16v4z"/><path d="M13.5 6.5l4 4"/>',
  signature: '<path d="M3 17c2-3 3.5-3.5 4.5-1s2 2.5 3.5 0 2.5-3 3.5-.5 2 2 4 1"/><path d="M3 21h18"/>',
  mail: '<rect x="3" y="5" width="18" height="14" rx="2"/><path d="M3.5 7l8.5 6 8.5-6"/>',
  refresh: '<path d="M19.5 12a7.5 7.5 0 1 1-2.2-5.3"/><path d="M19.5 4.5v4.2h-4.2"/>',
  keyboard: '<rect x="2.5" y="6" width="19" height="12" rx="2"/><path d="M6.5 10h.01M10 10h.01M14 10h.01M17.5 10h.01M7.5 14h9" stroke-width="1.9"/>',
  menu: '<path d="M4 6.5h16M4 12h16M4 17.5h16"/>',
  swap: '<path d="M6 8h13l-3.5-3.5"/><path d="M18 16H5l3.5 3.5"/>',
  todo: '<rect x="3.5" y="3.5" width="17" height="17" rx="4"/><path d="M8 12.3l2.7 2.7L16.2 9.5"/>',
  progress: '<ellipse cx="12" cy="18" rx="7.5" ry="2.6"/><ellipse cx="12" cy="12.4" rx="5.3" ry="2.1"/><ellipse cx="12" cy="7.6" rx="3.2" ry="1.6"/>',
  calendar: '<rect x="3.5" y="5" width="17" height="15.5" rx="2.5"/><path d="M3.5 10h17M8.5 3v4M15.5 3v4"/>',
  overview: '<circle cx="6" cy="7" r="2.3"/><circle cx="18" cy="8" r="2.3"/><circle cx="11" cy="17.5" r="2.3"/><path d="M8.2 7.4l7.5.4M7.2 9l2.6 6.4M16.6 9.9l-4.1 5.8"/>',
  board: '<path d="M5 9h14M5 15h14M10 4.5L8.5 19.5M15.5 4.5L14 19.5"/>',
  report: '<path d="M5.5 21V4h11.5l-2.2 4.2L17 12.5H5.5"/>',
  note: '<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8h5M9 12.5h6.5M9 16h6.5"/>',
  pdf: '<path d="M6 3.5h8.5L19 8v12.5H6z"/><path d="M14 3.5V8h5"/><path d="M9 16.5v-4h1.5a1.3 1.3 0 0 1 0 2.6H9" stroke-width="1.6"/>',
  branch: '<circle cx="7" cy="18" r="2.3"/><circle cx="7" cy="6" r="2.3"/><circle cx="17" cy="8" r="2.3"/><path d="M7 8.3v7.4M17 10.3c0 4.2-4.5 4.5-8.5 6"/>',
  arrow: '<path d="M7 17L17 7M8.5 7H17v8.5"/>',
};

export function icon(name, title) {
  const s = document.createElement('span');
  s.className = 'ic ic-' + name;
  s.setAttribute('aria-hidden', 'true');
  if (title) s.title = title;
  s.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${P[name] || ''}</svg>`;
  return s;
}

export const kindIcon = (kind) => icon({ bugs: 'report', todo: 'todo', overview: 'overview', progress: 'progress', mail: 'mail', calendar: 'calendar', note: 'note', pdf: 'pdf' }[kind] || 'board');
