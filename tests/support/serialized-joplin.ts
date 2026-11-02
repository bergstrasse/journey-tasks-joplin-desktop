import type { JoplinApiLike } from '../../src/adapters/joplin/gateway';
import { MemoryJoplin } from './memory-joplin';

/** JSON-compatible public-API boundary. The object response envelope preserves
 * absent `undefined` values; it deliberately does not assert that every Joplin
 * RPC transport converts missing results to null. */
const json = <T>(value: T): T => JSON.parse(JSON.stringify({ value })).value;

export function serializedJoplin(host: MemoryJoplin) {
  const writtenKeys: string[] = [];
  const data = Object.fromEntries(Object.entries(host.data).map(([name, method]) => [name, async (...input: any[]) => {
    const args = json(input);
    if (name === 'userDataSet') {
      const key = args[2];
      if (typeof key !== 'string' || key.length > 255) throw new Error(`Host key bound exceeded: ${String(key).length}`);
      writtenKeys.push(key);
    }
    let result = await (method as (...args: any[]) => Promise<any>)(...args);
    const path = args[0];
    // BaseModel.load adds type_; collection pagination returns selected SQL rows.
    if (name === 'get' && path?.[0] === 'notes' && path.length === 2) result = { ...result, type_: 1 };
    return json(result);
  }])) as JoplinApiLike['data'];
  return { api: { data, settings: host.settings } satisfies JoplinApiLike, writtenKeys };
}

export const jsonRoundTrip = json;
