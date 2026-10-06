import * as Y from 'yjs';

export interface FileEntry {
  id: string;
  name: string;
  createdAt: number;
}

type FileMap = Y.Map<unknown>;

export function metaMap(doc: Y.Doc): Y.Map<unknown> {
  return doc.getMap('meta');
}

export function filesMap(doc: Y.Doc): Y.Map<FileMap> {
  return doc.getMap('files') as Y.Map<FileMap>;
}

export function getVaultName(doc: Y.Doc): string {
  const n = metaMap(doc).get('name');
  return typeof n === 'string' ? n : '';
}

export function setVaultName(doc: Y.Doc, name: string): void {
  metaMap(doc).set('name', name);
}

export function listFiles(doc: Y.Doc): FileEntry[] {
  const out: FileEntry[] = [];
  filesMap(doc).forEach((f, id) => {
    const name = f.get('name');
    const createdAt = f.get('createdAt');
    out.push({ id, name: typeof name === 'string' ? name : 'Untitled', createdAt: typeof createdAt === 'number' ? createdAt : 0 });
  });
  return out.sort((a, b) => a.createdAt - b.createdAt || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
}

export function getFileText(doc: Y.Doc, id: string): Y.Text | null {
  const f = filesMap(doc).get(id);
  const t = f?.get('text');
  return t instanceof Y.Text ? t : null;
}

export function getFileName(doc: Y.Doc, id: string): string | null {
  const n = filesMap(doc).get(id)?.get('name');
  return typeof n === 'string' ? n : null;
}

function newId(): string {
  const b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('');
}

export function createFile(doc: Y.Doc, name: string, initial = ''): string {
  const id = newId();
  doc.transact(() => {
    const f = new Y.Map<unknown>();
    const text = new Y.Text();
    f.set('name', name);
    f.set('createdAt', Date.now());
    f.set('text', text);
    filesMap(doc).set(id, f);
    if (initial) text.insert(0, initial);
  });
  return id;
}

export function renameFile(doc: Y.Doc, id: string, name: string): void {
  filesMap(doc).get(id)?.set('name', name);
}

export function deleteFile(doc: Y.Doc, id: string): void {
  filesMap(doc).delete(id);
}

/** Only the creating device does this; joiners wait for the first sync instead. */
export function initVault(doc: Y.Doc, name: string): string {
  let id = '';
  doc.transact(() => {
    setVaultName(doc, name);
    metaMap(doc).set('createdAt', Date.now());
    id = createFile(doc, 'Notes.md', `# ${name}\n\n`);
  });
  return id;
}

export function ensureMarkdownName(name: string): string {
  const trimmed = name.trim().replace(/[\\/]/g, '-');
  if (!trimmed) return 'Untitled.md';
  return /\.(md|markdown)$/i.test(trimmed) ? trimmed : `${trimmed}.md`;
}
