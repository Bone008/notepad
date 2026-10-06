import { useState } from 'react';
import type * as Y from 'yjs';
import { createFile, deleteFile, ensureMarkdownName, renameFile, type FileEntry } from '../core/files.js';

export function FileSidebar({
  doc,
  files,
  activeId,
  onSelect,
}: {
  doc: Y.Doc;
  files: FileEntry[];
  activeId: string | null;
  onSelect: (id: string) => void;
}) {
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState('');

  const add = (): void => {
    const name = prompt('File name', 'Untitled.md');
    if (name === null) return;
    const id = createFile(doc, ensureMarkdownName(name));
    onSelect(id);
  };

  const commitRename = (id: string): void => {
    const name = ensureMarkdownName(draft);
    if (name) renameFile(doc, id, name);
    setRenaming(null);
  };

  const remove = (f: FileEntry): void => {
    if (files.length === 1) {
      alert('A vault needs at least one file.');
      return;
    }
    if (!confirm(`Delete "${f.name}" for everyone in this vault?`)) return;
    deleteFile(doc, f.id);
    if (activeId === f.id) {
      const next = files.find((x) => x.id !== f.id);
      if (next) onSelect(next.id);
    }
  };

  return (
    <aside className="sidebar" data-testid="sidebar">
      <div className="sidebar-head">
        <span>Files</span>
        <button className="icon-btn" onClick={add} title="New file" aria-label="New file">
          ＋
        </button>
      </div>
      <ul className="file-list">
        {files.map((f) => (
          <li key={f.id} className={f.id === activeId ? 'active' : ''}>
            {renaming === f.id ? (
              <input
                autoFocus
                value={draft}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => commitRename(f.id)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') commitRename(f.id);
                  if (e.key === 'Escape') setRenaming(null);
                }}
              />
            ) : (
              <>
                <button className="file-name" onClick={() => onSelect(f.id)} onDoubleClick={() => (setRenaming(f.id), setDraft(f.name))} title={f.name}>
                  {f.name}
                </button>
                <span className="file-actions">
                  <button className="icon-btn" title="Rename" aria-label={`Rename ${f.name}`} onClick={() => (setRenaming(f.id), setDraft(f.name))}>
                    ✎
                  </button>
                  <button className="icon-btn" title="Delete" aria-label={`Delete ${f.name}`} onClick={() => remove(f)}>
                    🗑
                  </button>
                </span>
              </>
            )}
          </li>
        ))}
      </ul>
    </aside>
  );
}
