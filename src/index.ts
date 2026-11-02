import joplin from 'api';
import { startPlugin } from './bootstrap';
import type { RuntimeApi } from './panel/controller';
const host = joplin as RuntimeApi & { plugins: { register(spec: { onStart(): Promise<void> }): void } };
host.plugins.register({
  onStart: async () => { await startPlugin(host); },
});
