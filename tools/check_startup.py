"""Measure files actually referenced by index.html; no network or API keys."""
import argparse
import io
import json
import re
import zipfile
from pathlib import Path


def measure(directory=None, root=None):
    archive = None
    if directory:
        read = lambda name: (directory / name).read_bytes()
    else:
        manifest = json.loads((root / 'site-package.json').read_text())
        archive = zipfile.ZipFile(io.BytesIO(b''.join((root / part).read_bytes() for part in manifest['parts'])))
        read = lambda name: (root / 'overrides' / name).read_bytes() if (root / 'overrides' / name).exists() else archive.read(name)
    html = read('index.html').decode('utf-8')
    paths = re.findall(r'(?:src|href)="([^"?:]+\.(?:js|css))(?:\?[^\"]*)?"', html)
    rows = [{'path': path, 'bytes': len(read(path))} for path in paths]
    if archive:
        archive.close()
    return {'requests': len(rows), 'totalBytes': sum(row['bytes'] for row in rows), 'assets': sorted(rows, key=lambda r: -r['bytes'])}


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path)
    parser.add_argument('--root', type=Path, default=Path(__file__).resolve().parents[1])
    parser.add_argument('--max-bytes', type=int, default=3000000)
    args = parser.parse_args()
    result = measure(args.directory, args.root)
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if result['totalBytes'] > args.max_bytes:
        raise SystemExit('FAIL: startup assets exceed the 3 MB uncompressed budget')
