"""Restore integrity-checked npm tarballs from an existing local npm cache.
Normal networked environments should use npm ci. No network requests are made.
"""
import base64
import hashlib
import io
import json
import os
from pathlib import Path
import sys
import tarfile

cache = Path(sys.argv[1] if len(sys.argv) > 1 else Path.home() / '.npm') / '_cacache'
versions = {
    'react': '19.2.8', 'react-dom': '19.2.8', 'scheduler': '0.27.0',
    '@types/node': '22.20.2', '@types/react': '19.2.17', 'csstype': '3.2.3',
    'undici-types': '6.21.0', 'esbuild': '0.28.2',
    '@esbuild/darwin-x64': '0.28.2', 'tsx': '4.23.13', 'typescript': '5.9.3',
}
records = {}
for entry in (cache / 'index-v5').rglob('*'):
    if not entry.is_file():
        continue
    for line in entry.read_text(errors='ignore').splitlines():
        try:
            record = json.loads(line.split('\t', 1)[1])
            if record.get('integrity'):
                records[record['key']] = record
        except (ValueError, IndexError, KeyError):
            pass
root = Path(__file__).resolve().parent.parent
manifest = json.loads((root / 'package.json').read_text())
lock = {'name': manifest['name'], 'version': manifest['version'], 'lockfileVersion': 3,
        'requires': True, 'packages': {'': {k: manifest[k] for k in
          ['name', 'version', 'license', 'dependencies', 'devDependencies']}}}
for name, version in versions.items():
    basename = name.split('/')[-1]
    url = f'https://registry.npmjs.org/{name}/-/{basename}-{version}.tgz'
    record = records.get('make-fetch-happen:request-cache:' + url)
    if not record:
        raise SystemExit(f'Missing cached tarball: {name}@{version}')
    algorithm, encoded = record['integrity'].split('-', 1)
    digest = base64.b64decode(encoded).hex()
    raw = (cache / 'content-v2' / algorithm / digest[:2] / digest[2:4] / digest[4:]).read_bytes()
    if hashlib.new(algorithm, raw).hexdigest() != digest:
        raise SystemExit(f'Integrity failure: {name}')
    dest = root / 'node_modules' / name
    dest.mkdir(parents=True, exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as archive:
        for member in archive.getmembers():
            parts = Path(member.name).parts[1:]
            if not parts or '..' in parts or member.issym() or member.islnk():
                continue
            target = dest.joinpath(*parts)
            if member.isdir():
                target.mkdir(parents=True, exist_ok=True)
            elif member.isfile():
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(archive.extractfile(member).read())
                target.chmod(member.mode & 0o777)
    pkg = json.loads((dest / 'package.json').read_text())
    item = {'version': version, 'resolved': url, 'integrity': record['integrity']}
    for key in ['license', 'dependencies', 'optionalDependencies', 'peerDependencies', 'engines', 'bin', 'os', 'cpu']:
        if key in pkg:
            item[key] = pkg[key]
    if name not in ['react', 'react-dom', 'scheduler']:
        item['dev'] = True
    lock['packages']['node_modules/' + name] = item
    bins = pkg.get('bin', {})
    if isinstance(bins, str):
        bins = {basename: bins}
    for binname, rel in bins.items():
        link = root / 'node_modules/.bin' / binname
        link.parent.mkdir(exist_ok=True)
        if link.is_symlink() or link.exists():
            link.unlink()
        link.symlink_to(os.path.relpath(dest / rel, link.parent))
    print(f'Restored {name}@{version} (verified {algorithm})')
# Include optional platform metadata as well, so npm ci can validate the lock on
# other platforms even though only this machine's executable is restored here.
def cached_metadata(name):
    key = 'make-fetch-happen:request-cache:https://registry.npmjs.org/' + name.replace('/', '%2f')
    record = records.get(key)
    if not record:
        raise SystemExit(f'Missing optional package metadata: {name}')
    algorithm, encoded = record['integrity'].split('-', 1)
    digest = base64.b64decode(encoded).hex()
    raw = (cache / 'content-v2' / algorithm / digest[:2] / digest[2:4] / digest[4:]).read_bytes()
    if hashlib.new(algorithm, raw).hexdigest() != digest:
        raise SystemExit(f'Metadata integrity failure: {name}')
    return json.loads(raw)
for owner in ['esbuild', 'tsx']:
    pkg = json.loads((root / 'node_modules' / owner / 'package.json').read_text())
    for name, spec in pkg.get('optionalDependencies', {}).items():
        key = 'node_modules/' + name
        if key in lock['packages']:
            lock['packages'][key]['optional'] = True
            continue
        version = spec if name.startswith('@esbuild/') else '2.3.3'
        pkgmeta = cached_metadata(name)['versions'][version]
        item = {'version': version, 'resolved': pkgmeta['dist']['tarball'],
                'integrity': pkgmeta['dist']['integrity'], 'dev': True, 'optional': True}
        for field in ['license', 'engines', 'os', 'cpu', 'dependencies', 'bin']:
            if field in pkgmeta:
                item[field] = pkgmeta[field]
        if pkgmeta.get('scripts', {}).get('install'):
            item['hasInstallScript'] = True
        lock['packages'][key] = item
lock['packages']['node_modules/esbuild']['hasInstallScript'] = True
(root / 'package-lock.json').write_text(json.dumps(lock, indent=2) + '\n')
