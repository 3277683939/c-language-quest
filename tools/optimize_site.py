"""Build-only startup optimization. Source question data stays untouched."""
import argparse
import hashlib
import json
import re
from pathlib import Path


def assignment(text):
    start = text.index('{')
    value, end = json.JSONDecoder().raw_decode(text[start:])
    if text[start + end:].strip() not in {'', ';'}:
        raise ValueError('数据脚本含额外代码，停止压缩')
    return text[:start], value


def optimize(directory):
    directory = Path(directory)
    html_path = directory / 'index.html'
    html = html_path.read_text(encoding='utf-8')
    if 'quest-app.js' in html:
        return
    # Keep account styles in the existing stylesheet request on mobile networks.
    account_css = directory / 'account.css'
    if account_css.exists() and re.search(r'<link[^>]+href="account\.css(?:\?[^"]*)?"[^>]*>', html):
        ui_css = directory / 'ui.css'
        ui_css.write_text(ui_css.read_text(encoding='utf-8-sig') + '\n/* Account */\n' + account_css.read_text(encoding='utf-8-sig'), encoding='utf-8')
        html = re.sub(r'<link[^>]+href="account\.css(?:\?[^"]*)?"[^>]*>\s*', '', html)
    for name in ['bank.js', 'practice-units.js', 'imported-data.js']:
        path = directory / name
        prefix, data = assignment(path.read_text(encoding='utf-8-sig'))
        path.write_text(prefix + json.dumps(data, ensure_ascii=False, separators=(',', ':')) + ';\n', encoding='utf-8')

    raw = (directory / 'practice-data.js').read_text(encoding='utf-8-sig')
    _, pages = assignment(raw)
    version = hashlib.sha256(raw.encode('utf-8')).hexdigest()[:16]
    # Old page-based teaching links still work, without loading all 827 pages
    # during ordinary map/quiz/practice visits.
    meta = '''window.PRACTICE_DATA = {pageCount: PAGE_COUNT, sources: {}};
window.loadLegacyPracticeData = (() => {
  let pending;
  const base = (typeof document !== 'undefined' && document.currentScript && document.currentScript.src) || (typeof location !== 'undefined' && location.href) || 'http://localhost/';
  const URLCtor = typeof URL !== 'undefined' ? URL : (typeof window !== 'undefined' ? window.URL : null);
  const url = URLCtor ? new URLCtor(LEGACY_URL, base).href : LEGACY_URL;
  return () => {
    if (window.PRACTICE_DATA.legacyLoaded) return Promise.resolve();
    if (!pending) pending = new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = url;
      script.onload = () => { window.PRACTICE_DATA.legacyLoaded = true; resolve(); };
      script.onerror = () => { pending = null; script.remove(); reject(new Error('旧版页码资料加载失败')); };
      document.head.append(script);
    });
    return pending;
  };
})();
'''.replace('PAGE_COUNT', str(pages['pageCount'])).replace('LEGACY_URL', json.dumps('practice-data.js?v=' + version))

    tags = list(re.finditer(r'<script\s+src="([^"?]+)(?:\?[^\"]*)?"\s*></script>', html))
    required = ['bank.js', 'practice-units.js']
    actual = [m.group(1) for m in tags]
    if not set(required + ['practice-data.js', 'app.js', 'imports.js']).issubset(actual):
        raise ValueError('网页脚本顺序不符合预期，停止打包')
    bundle = []
    for tag in tags:
        name = tag.group(1)
        if name in required:
            continue
        content = meta if name == 'practice-data.js' else (directory / name).read_text(encoding='utf-8-sig')
        bundle.append(';\n/* ' + name + ' */\n' + content + '\n')
    (directory / 'quest-app.js').write_text('\n'.join(bundle), encoding='utf-8')
    for tag in reversed(tags):
        html = html[:tag.start()] + html[tag.end():]
    entry = ''.join(f'<script defer src="{name}"></script>' for name in required + ['quest-app.js'])
    html = html.replace('</body>', entry + '</body>')
    html_path.write_text(html, encoding='utf-8')


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, required=True)
    optimize(parser.parse_args().directory)
