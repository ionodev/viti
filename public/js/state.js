// What the page knows, and a tiny event bus to tell the parts of it when something changes.
export const S = {
  me: null, // { email, name, color }
  users: new Map(), // email -> { email, name, color }
  branches: { list: [], latest: '' }, // the repository's branches (for the tags on reports and to-dos), latest first
  categories: [], // your own headings in the menu: { id, name, pos }
  sections: [], // { id, name, kind, pos, unread }
  section: null, // the id of the one that is open
  branchView: '', // the branch being looked at: '' is all of them (chosen at the top of the menu; remembered)
  bugCounts: {}, // per report section: { open, closed, trash }
  presence: {}, // section id -> [email]
  sync: null,
  live: null,
};

try {
  S.branchView = localStorage.getItem('hub.branch') || '';
} catch {}
export function setBranchView(name) {
  S.branchView = name || '';
  try {
    localStorage.setItem('hub.branch', S.branchView);
  } catch {}
  emit('branchview', S.branchView);
}

const handlers = new Map();
export const on = (type, fn) => {
  if (!handlers.has(type)) handlers.set(type, []);
  handlers.get(type).push(fn);
  return () => handlers.set(type, handlers.get(type).filter((f) => f !== fn));
};
export const emit = (type, data) => (handlers.get(type) || []).slice().forEach((fn) => fn(data));

export const user = (email) => S.users.get(email) || { email, name: String(email || 'Someone').split('@')[0] || 'Someone', color: '#888' };
export const sectionById = (id) => S.sections.find((s) => s.id === id);
// a section's name as people read it: a branch subsection is "Design \u00b7 branch-name"
export const sectionLabel = (id) => {
  const s = sectionById(id);
  if (!s) return '';
  const p = s.parent ? sectionById(s.parent) : null;
  return p ? `${p.name} \u00b7 ${s.name}` : s.name;
};
export const imageUrl = (id) => `/api/images/${id}`;
