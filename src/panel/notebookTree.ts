export interface Notebook { id: string; title: string; parent_id?: string }
export interface NotebookRow extends Notebook { depth: number; path: string }

/** Lay out the host-ordered catalog without changing sibling order or sorting by UI language. */
export function notebookRows(folders: readonly Notebook[]): NotebookRow[] {
  const byId = new Map(folders.map(folder => [folder.id, folder]));
  const children = new Map<string, Notebook[]>();
  for (const folder of byId.values()) {
    const parent = folder.parent_id && byId.has(folder.parent_id) ? folder.parent_id : '';
    const siblings = children.get(parent) ?? [];
    siblings.push(folder);
    children.set(parent, siblings);
  }
  const rows: NotebookRow[] = [], seen = new Set<string>();
  const visit = (folder: Notebook, titles: string[]) => {
    if (seen.has(folder.id)) return;
    seen.add(folder.id);
    const path = [...titles, folder.title];
    rows.push({ ...folder, depth: titles.length, path: path.join(' / ') });
    for (const child of children.get(folder.id) ?? []) visit(child, path);
  };
  for (const root of children.get('') ?? []) visit(root, []);
  // A damaged parent cycle must not hide notebooks or loop forever.
  for (const folder of byId.values()) if (!seen.has(folder.id)) visit(folder, []);
  return rows;
}
