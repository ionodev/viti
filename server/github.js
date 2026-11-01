// A small client for the parts of the GitHub API the mirror needs (the Git Data API, so a whole batch of
// changes becomes one commit), and a reader for the .tar.gz that a restore downloads.
import { b64encode, b64decode } from './util.js';

export const EMPTY = 'This repository is empty, so GitHub cannot keep Viti’s backup branch in it yet. Give it a first commit (a README is enough): on GitHub, or click the backup status in Viti and choose “Start it with a README”.';

export class GitHub {
  constructor(env) {
    this.api = (env.GITHUB_API || 'https://api.github.com').replace(/\/$/, '');
    this.repo = env.GITHUB_REPO;
    this.branch = env.GITHUB_BRANCH || 'viti-data';
    this.token = env.GITHUB_TOKEN;
  }
  get configured() {
    return !!(this.token && this.repo);
  }
  async call(method, path, body, ok404 = false) {
    const res = await fetch(`${this.api}/repos/${this.repo}${path}`, {
      method,
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'viti', ...(body ? { 'content-type': 'application/json' } : {}) },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 404 && ok404) return null;
    if (!res.ok) {
      const t = await res.text().catch(() => '');
      // a repository with no commits yet: GitHub keeps no branches in it until it has one
      if (res.status === 409 && /repository is empty/i.test(t)) throw Object.assign(new Error(EMPTY), { code: 'empty-repo' });
      throw new Error(`GitHub ${method} ${path.split('?')[0]} → ${res.status}${res.status === 401 || res.status === 403 ? ' (check the token: Contents read/write on this repo)' : ''} ${t.slice(0, 160)}`);
    }
    return res.json();
  }

  // an empty repository's first commit: a README on its default branch (only when you ask for it in Viti)
  async startEmpty(title) {
    const content = b64encode(new TextEncoder().encode(`# ${title}\n`));
    const res = await fetch(`${this.api}/repos/${this.repo}/contents/README.md`, {
      method: 'PUT',
      headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'viti', 'content-type': 'application/json' },
      body: JSON.stringify({ message: 'Add a README', content }),
    });
    if (!res.ok) throw new Error(`GitHub could not add the README (${res.status}).`);
  }

  // the branch's latest commit (null: there is no branch yet)
  async head() {
    return (await this.call('GET', `/git/ref/heads/${this.branch}`, null, true))?.object?.sha || null;
  }
  // every file in a commit: [{ path, sha }]
  async tree(commit) {
    const c = await this.call('GET', `/git/commits/${commit}`);
    const t = await this.call('GET', `/git/trees/${c.tree.sha}?recursive=1`);
    return t.tree.filter((e) => e.type === 'blob').map((e) => ({ path: e.path, sha: e.sha }));
  }
  // one file's content, by its sha
  async blob(sha) {
    return b64decode((await this.call('GET', `/git/blobs/${sha}`)).content);
  }

  // files: { path: string | Uint8Array | null }  (null deletes). One commit on the branch (made if missing).
  // parent: the commit this is meant to follow (undefined: any). Someone else committed since? Then nothing
  // is written and the error's code is 'behind': fetch theirs first, then try again.
  async commit(files, message, parent) {
    const head = await this.call('GET', `/git/ref/heads/${this.branch}`, null, true);
    if (parent !== undefined && (head?.object?.sha || null) !== parent) throw Object.assign(new Error('Someone else backed up meanwhile.'), { code: 'behind' });
    let baseTree = null;
    if (head) baseTree = (await this.call('GET', `/git/commits/${head.object.sha}`)).tree.sha;
    const tree = [];
    for (const [path, content] of Object.entries(files)) {
      if (content === null) tree.push({ path, mode: '100644', type: 'blob', sha: null });
      else if (typeof content === 'string') tree.push({ path, mode: '100644', type: 'blob', content });
      else {
        const blob = await this.call('POST', '/git/blobs', { content: b64encode(content), encoding: 'base64' });
        tree.push({ path, mode: '100644', type: 'blob', sha: blob.sha });
      }
    }
    const t = await this.call('POST', '/git/trees', baseTree ? { base_tree: baseTree, tree } : { tree });
    const c = await this.call('POST', '/git/commits', { message, tree: t.sha, parents: head ? [head.object.sha] : [] });
    try {
      if (head) await this.call('PATCH', `/git/refs/heads/${this.branch}`, { sha: c.sha });
      else await this.call('POST', '/git/refs', { ref: `refs/heads/${this.branch}`, sha: c.sha });
    } catch (e) {
      // (someone committed in the moment between: not a fast-forward any more)
      if (/→ 422/.test(e.message)) throw Object.assign(new Error('Someone else backed up meanwhile.'), { code: 'behind' });
      throw e;
    }
    return c.sha;
  }

  // every file of the branch under `dir`, as { relativePath: Uint8Array }
  async files(dir) {
    const res = await fetch(`${this.api}/repos/${this.repo}/tarball/${this.branch}`, { headers: { authorization: `Bearer ${this.token}`, accept: 'application/vnd.github+json', 'user-agent': 'viti' }, redirect: 'follow' });
    if (res.status === 404) return null;
    if (!res.ok) throw new Error(`GitHub tarball → ${res.status}`);
    const raw = new Uint8Array(await new Response(res.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
    return untar(raw, dir);
  }
}

const text = (b, from, to) => new TextDecoder().decode(b.subarray(from, to)).replace(/\0[\s\S]*$/, '');

export function untar(buf, dir) {
  const out = {};
  const prefix = dir.replace(/^\/|\/$/g, '') + '/';
  let at = 0;
  let longName = null;
  while (at + 512 <= buf.length) {
    const head = buf.subarray(at, at + 512);
    if (head.every((x) => x === 0)) break;
    let name = text(head, 0, 100);
    const pre = text(head, 345, 500);
    if (pre) name = `${pre}/${name}`;
    const size = parseInt(text(head, 124, 136).trim() || '0', 8);
    const type = String.fromCharCode(head[156] || 48);
    const body = buf.subarray(at + 512, at + 512 + size);
    at += 512 + Math.ceil(size / 512) * 512;
    if (type === 'x') {
      const m = new TextDecoder().decode(body).match(/\d+ path=([^\n]+)\n/);
      longName = m ? m[1] : null;
      continue;
    }
    if (type === 'g') continue;
    if (longName) {
      name = longName;
      longName = null;
    }
    if (type !== '0' && type !== '\0') continue;
    const rel = name.split('/').slice(1).join('/'); // drop the "owner-repo-sha/" folder
    if (rel.startsWith(prefix)) out[rel.slice(prefix.length)] = body.slice();
  }
  return out;
}

// The branches of the project's repository (env.BRANCHES_REPO), most recently committed first, in one GraphQL call
// (a few more if there are over 100), with the token BRANCHES_TOKEN.
export async function repoBranches(env) {
  const [owner, name] = String(env.BRANCHES_REPO || '').split('/');
  if (!env.BRANCHES_TOKEN || !owner || !name) return null;
  const api = (env.BRANCHES_API || 'https://api.github.com').replace(/\/$/, '');
  const query = 'query($o:String!,$n:String!,$c:String){repository(owner:$o,name:$n){defaultBranchRef{name} refs(refPrefix:"refs/heads/",first:100,after:$c){pageInfo{hasNextPage endCursor} nodes{name target{... on Commit{committedDate}}}}}}';
  const branches = [];
  let def = '';
  let cursor = null;
  for (let page = 0; page < 5; page++) {
    const res = await fetch(`${api}/graphql`, { method: 'POST', headers: { authorization: `Bearer ${env.BRANCHES_TOKEN}`, 'content-type': 'application/json', 'user-agent': 'viti' }, body: JSON.stringify({ query, variables: { o: owner, n: name, c: cursor } }) });
    if (!res.ok) throw new Error(`GitHub graphql → ${res.status}${res.status === 401 || res.status === 403 ? ' (check the GitHub sign-in)' : ''}`);
    const j = await res.json();
    const repo = j.data?.repository;
    if (!repo) throw new Error(j.errors?.[0]?.message || 'The repository could not be read (is the token allowed to see it?)');
    def = repo.defaultBranchRef?.name || def;
    for (const n of repo.refs.nodes) branches.push({ name: n.name, date: n.target?.committedDate || '' });
    if (!repo.refs.pageInfo.hasNextPage) break;
    cursor = repo.refs.pageInfo.endCursor;
  }
  branches.sort((a, b) => (a.date < b.date ? 1 : a.date > b.date ? -1 : 0));
  return { branches, def };
}
