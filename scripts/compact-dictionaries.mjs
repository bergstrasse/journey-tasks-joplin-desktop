// Locale keys are stored once per bundle; each locale carries only its translated values.
// Host translation calls use literal keys (including direct dictionary lookups).
import { readFile, readdir } from 'node:fs/promises';

export async function dictionaries(keys) {
  const counts = new Map();
  for (const file of (await readdir('src/i18n/locales')).filter(file => file.endsWith('.json')).sort()) {
    const dictionary = JSON.parse(await readFile('src/i18n/locales/' + file, 'utf8'));
    for (const [key, value] of Object.entries(dictionary)) {
      if ((!keys || keys.has(key)) && value.length > 12) counts.set(value, (counts.get(value) ?? 0) + 1);
    }
  }
  // Repeated translations (especially regional variants) share a single string pool.
  const pool = [...counts].filter(([, count]) => count > 1).map(([value]) => value);
  const indices = new Map(pool.map((value, index) => [value, index]));
  return { name: 'compact-dictionaries', setup(builder) {
    builder.onResolve({ filter: /^journey-locale-pool$/ }, args => ({ path: args.path, namespace: 'locale-pool' }));
    builder.onLoad({ filter: /.*/, namespace: 'locale-pool' }, () => ({ contents: `export default ${JSON.stringify(pool)}`, loader: 'js' }));
    builder.onResolve({ filter: /^journey-locale-keys:/ }, args => ({ path: args.path, namespace: 'locale-keys' }));
    builder.onLoad({ filter: /.*/, namespace: 'locale-keys' }, args => ({ contents: `export default ${args.path.slice('journey-locale-keys:'.length)}`, loader: 'js' }));
    builder.onLoad({ filter: /[/\\]i18n[/\\]locales[/\\].*\.json$/ }, async args => {
      const dictionary = JSON.parse(await readFile(args.path, 'utf8'));
      const names = Object.keys(dictionary).filter(key => !keys || keys.has(key)).sort();
      const signature = JSON.stringify(names);
      return { contents: `import keys from ${JSON.stringify('journey-locale-keys:' + signature)};
        import pool from 'journey-locale-pool';
        const values = ${JSON.stringify(names.map(key => indices.get(dictionary[key]) ?? dictionary[key]))};
        export default Object.fromEntries(keys.map((key, index) => [key, typeof values[index] === 'number' ? pool[values[index]] : values[index]]));`, loader: 'js' };
    });
  } };
}
