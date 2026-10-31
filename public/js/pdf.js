// A PDF (a subsection of a board): shown with the browser's own PDF viewer, in the room of the canvas.
import { sectionById, imageUrl } from './state.js';
import { h } from './ui.js';

export class PdfView {
  constructor({ onReference }) {
    this.onReference = onReference;
  }
  mount(stage) {
    this.stage = stage;
    this.root = h('div', { class: 'pdfview' });
    stage.append(this.root);
  }
  async open(section) {
    this.section = section;
    const sec = sectionById(section);
    const url = imageUrl(sec?.file || '');
    this.root.replaceChildren(
      h('div', { class: 'notebar' }, h('span', { class: 'note-status' }, 'PDF'), h('span', { class: 'grow' }), h('a', { class: 'fmt wide', href: url, target: '_blank', rel: 'noopener' }, 'Open in a tab'), h('a', { class: 'fmt wide', href: url, download: (sec?.name || 'document') + '.pdf' }, 'Download')),
      sec?.file ? h('iframe', { class: 'pdfframe', src: url, title: sec.name }) : h('p', { class: 'pdfmissing' }, 'This PDF is missing.'),
    );
  }
  unmount() {
    this.stage?.replaceChildren();
  }
}
