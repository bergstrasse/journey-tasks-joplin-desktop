interface Node<T> {
  readonly children?: readonly (Node<T> | undefined)[];
  readonly values?: ReadonlyMap<string, T>;
}
function hashKey(key: string): number {
  let hash = 2166136261;
  for (let i = 0; i < key.length; i++) hash = Math.imul(hash ^ key.charCodeAt(i), 16777619);
  return hash >>> 0;
}
/** Persistent 32-bit hash trie: each lookup/update visits eight levels, regardless
 * of history length. Full keys in collision buckets preserve occurrence identity. */
export class HistoryScheduleMap<T> {
  constructor(private readonly root?: Node<T>) {}
  get(key: string): T | undefined {
    const hash = hashKey(key);
    let node = this.root;
    for (let depth = 0; depth < 8 && node; depth++) node = node.children?.[(hash >>> (depth * 4)) & 15];
    return node?.values?.get(key);
  }
  set(key: string, value: T): HistoryScheduleMap<T> {
    const hash = hashKey(key);
    // Recursion is bounded to eight trie levels, never the causal-chain length.
    const update = (node: Node<T> | undefined, depth: number): Node<T> => {
      if (depth === 8) {
        const values = new Map(node?.values);
        values.set(key, value);
        return { values };
      }
      const children = [...(node?.children || [])];
      const index = (hash >>> (depth * 4)) & 15;
      children[index] = update(children[index], depth + 1);
      return { children };
    };
    return new HistoryScheduleMap(update(this.root, 0));
  }
}
