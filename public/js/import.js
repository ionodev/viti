// Import a bundle file (boards, reports and to-do rows, with images inside it) made from the team's Figma notes.
// The images are uploaded one by one (shrunk first, like any image), then everything else goes in one request.
import { api, uploadImage } from './api.js';
import { toast } from './ui.js';

const toBlob = (img) => {
  const bin = atob(img.b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new File([bytes], img.name || 'image.png', { type: img.mime || 'image/png' });
};

export async function importBundle(bundle, progress = () => {}) {
  const keys = Object.keys(bundle.images || {});
  const up = {};
  for (const [i, k] of keys.entries()) {
    progress(`Uploading image ${i + 1} of ${keys.length}…`);
    const r = await uploadImage(toBlob(bundle.images[k]));
    up[k] = r;
  }
  const useImages = (items) =>
    (items || []).map((it) => {
      if (it.type !== 'image') return it;
      const u = up[it.data.imgKey];
      if (!u) return { ...it, type: 'image', data: {} };
      const ratio = u.h && u.w ? u.h / u.w : 0.6;
      const w = it.w || u.w;
      return { ...it, w, h: Math.round(w * ratio), data: { img: u.id, name: it.data.name || u.name } };
    });
  const out = {
    id: bundle.id,
    boards: (bundle.boards || []).map((b) => ({ ...b, items: useImages(b.items) })),
    reports: (bundle.reports || []).map((r) => ({ ...r, rows: (r.rows || []).map((row) => ({ ...row, images: (row.imageKeys || []).map((k) => up[k]?.id).filter(Boolean) })) })),
    todos: bundle.todos || [],
    chats: bundle.chats || [],
  };
  progress('Adding everything…');
  return api('POST', '/api/admin/import', out);
}

// the file picker behind the button in Settings
export function pickAndImport() {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'application/json,.json';
  input.onchange = async () => {
    const file = input.files?.[0];
    if (!file) return;
    try {
      const bundle = JSON.parse(await file.text());
      toast('Importing…');
      const r = await importBundle(bundle, (m) => toast(m));
      toast(`Imported: ${r.items} board items, ${r.reports} reports, ${r.todos} to-dos, ${r.messages || 0} chat messages, ${r.sections} new sections. Reloading…`);
    } catch (e) {
      toast(e.message || 'The import failed.', true);
    }
  };
  input.click();
}
