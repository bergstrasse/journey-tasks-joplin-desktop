// Same runtime contract as the official generator: Joplin injects this binding.
import type { JoplinApiLike } from '../src/adapters/joplin/gateway';
declare const joplin: JoplinApiLike;
export default joplin;
