"""Regression & behavior tests for startup optimization:
1. All question contents and IDs remain 100% identical before and after optimization.
2. Legacy page data (practice-data.js) is loaded on demand only, not at startup.
3. Repeated optimization on the same directory is completely idempotent (no duplicate concatenation).
4. Startup asset transfer size remains strictly within the 3 MB budget with <= 5 requests.
"""
import io
import json
import shutil
import subprocess
import tempfile
import unittest
import zipfile
from pathlib import Path

from check_startup import measure
from optimize_site import optimize


REPO_ROOT = Path(__file__).resolve().parents[1]


def build_raw_site(target_dir):
    """Unpack original site-package and apply overrides without optimization."""
    manifest = json.loads((REPO_ROOT / 'site-package.json').read_text(encoding='utf-8'))
    pieces = [(REPO_ROOT / name).read_bytes() for name in manifest['parts']]
    raw = b''.join(pieces)
    with zipfile.ZipFile(io.BytesIO(raw)) as archive:
        archive.extractall(target_dir)
    for patch in (REPO_ROOT / 'overrides').rglob('*'):
        if patch.is_file():
            dst = target_dir / patch.relative_to(REPO_ROOT / 'overrides')
            dst.parent.mkdir(parents=True, exist_ok=True)
            shutil.copyfile(patch, dst)


def extract_questions_with_node(site_dir, is_optimized=False):
    """Execute site scripts via Node.js VM to inspect merged QUESTION_BANK and PRACTICE_UNITS."""
    node = shutil.which('node')
    if not node:
        raise RuntimeError('Node.js is required for testing')
    
    script = f"""
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const siteDir = {json.dumps(str(site_dir.resolve()))};
const isOptimized = {json.dumps(is_optimized)};

const elements = new Map();
const element = selector => {{
  if (!elements.has(selector)) {{
    const el = {{
      innerHTML: '', textContent: '', value: '', open: false,
      addEventListener() {{}}, insertAdjacentHTML() {{}},
      classList: {{ toggle() {{}}, add() {{}}, remove() {{}} }},
      querySelector(s) {{ return element(s); }},
      querySelectorAll() {{ return []; }}
    }};
    elements.set(selector, el);
  }}
  return elements.get(selector);
}};

const sandbox = {{
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  Promise: globalThis.Promise,
  document: {{
    body: {{ dataset: {{}}, classList: {{ add() {{}}, remove() {{}}, toggle() {{}} }} }},
    currentScript: {{ src: 'http://localhost/quest-app.js' }},
    querySelector: element,
    querySelectorAll() {{ return []; }},
    addEventListener() {{}},
    head: {{ append() {{}} }},
    createElement() {{ return {{ src: '', addEventListener() {{}} }}; }}
  }},
  location: {{ href: 'http://localhost/#map', hash: '#map' }},
  localStorage: {{
    getItem() {{ return JSON.stringify({{ version: 1, wrong: [], favorites: [], drafts: {{}}, levels: {{}} }}); }},
    setItem() {{}}
  }},
  navigator: {{}}
}};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.addEventListener = () => {{}};
const context = vm.createContext(sandbox);

if (!isOptimized) {{
  const scripts = [
    'bank.js', 'practice-units.js', 'explanations.js', 'quality.js',
    'practice-data.js', 'imported-data.js', 'imports.js'
  ];
  for (const s of scripts) {{
    const code = fs.readFileSync(path.join(siteDir, s), 'utf8');
    vm.runInContext(code, context);
  }}
}} else {{
  const scripts = ['bank.js', 'practice-units.js', 'quest-app.js'];
  for (const s of scripts) {{
    const code = fs.readFileSync(path.join(siteDir, s), 'utf8');
    vm.runInContext(code, context);
  }}
}}

const bank = context.window.QUESTION_BANK;
const units = context.window.PRACTICE_UNITS;
const practiceData = context.window.PRACTICE_DATA;

const output = {{
  choiceCount: bank.questions.length,
  unitCount: units.units.length,
  choices: bank.questions.map(q => ({{ id: q.id, stem: q.stem, answer: q.answer, options: q.options, chapter: q.chapter }})),
  units: units.units.map(u => ({{ id: u.id, stem: u.stem, answer: u.answer, kind: u.kind, chapter: u.chapter }})),
  practiceDataPageCount: practiceData ? practiceData.pageCount : null,
  practiceDataSourcesCount: practiceData && practiceData.sources ? Object.keys(practiceData.sources).length : null,
  legacyLoaded: practiceData ? Boolean(practiceData.legacyLoaded) : null
}};

console.log(JSON.stringify(output));
"""
    res = subprocess.run([node, '-e', script], capture_output=True, text=True, encoding='utf-8', errors='replace', check=True)
    return json.loads(res.stdout)


class StartupOptimizationTests(unittest.TestCase):
    def setUp(self):
        self.temp_dir = tempfile.TemporaryDirectory(prefix='cquest-startup-test-')
        self.site_dir = Path(self.temp_dir.name)
        build_raw_site(self.site_dir)

    def tearDown(self):
        self.temp_dir.cleanup()

    def test_all_questions_and_ids_preserved(self):
        """Questions and IDs before optimization must be 100% identical after optimization."""
        before = extract_questions_with_node(self.site_dir, is_optimized=False)
        self.assertEqual(before['choiceCount'], 1096)
        self.assertEqual(before['unitCount'], 2044)

        optimize(self.site_dir)

        after = extract_questions_with_node(self.site_dir, is_optimized=True)
        self.assertEqual(after['choiceCount'], 1096)
        self.assertEqual(after['unitCount'], 2044)
        self.assertEqual(before['choices'], after['choices'])
        self.assertEqual(before['units'], after['units'])

    def test_legacy_practice_data_on_demand_loading(self):
        """practice-data.js must not load on startup; loads on demand via loadLegacyPracticeData."""
        optimize(self.site_dir)
        initial = extract_questions_with_node(self.site_dir, is_optimized=True)
        self.assertEqual(initial['practiceDataPageCount'], 827)
        self.assertEqual(initial['practiceDataSourcesCount'], 0)
        self.assertFalse(initial['legacyLoaded'])

        node = shutil.which('node')
        script = f"""
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const siteDir = {json.dumps(str(self.site_dir.resolve()))};
const domAppendedScripts = [];

const elements = new Map();
const element = selector => {{
  if (!elements.has(selector)) {{
    const el = {{
      innerHTML: '', textContent: '', value: '', open: false,
      addEventListener() {{}}, insertAdjacentHTML() {{}},
      classList: {{ toggle() {{}}, add() {{}}, remove() {{}} }},
      querySelector(s) {{ return element(s); }},
      querySelectorAll() {{ return []; }}
    }};
    elements.set(selector, el);
  }}
  return elements.get(selector);
}};

const sandbox = {{
  URL: globalThis.URL,
  URLSearchParams: globalThis.URLSearchParams,
  setTimeout: globalThis.setTimeout,
  clearTimeout: globalThis.clearTimeout,
  Promise: globalThis.Promise,
  document: {{
    body: {{ dataset: {{}}, classList: {{ add() {{}}, remove() {{}}, toggle() {{}} }} }},
    currentScript: {{ src: 'http://localhost/quest-app.js' }},
    querySelector: element,
    querySelectorAll() {{ return []; }},
    addEventListener() {{}},
    head: {{
      append(elem) {{
        domAppendedScripts.push(elem);
        setTimeout(() => {{
          const scriptFile = path.basename(elem.src.split('?')[0]);
          const code = fs.readFileSync(path.join(siteDir, scriptFile), 'utf8');
          vm.runInContext(code, context);
          elem.onload();
        }}, 5);
      }}
    }},
    createElement(tag) {{ return {{ tag, src: '', onload() {{}}, onerror() {{}} }}; }}
  }},
  location: {{ href: 'http://localhost/#coach?question=page:h:1', hash: '#coach?question=page:h:1' }},
  localStorage: {{
    getItem() {{ return JSON.stringify({{ version: 1, wrong: [], favorites: [], drafts: {{}}, levels: {{}} }}); }},
    setItem() {{}}
  }},
  navigator: {{}}
}};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
sandbox.addEventListener = () => {{}};
const context = vm.createContext(sandbox);

for (const s of ['bank.js', 'practice-units.js', 'quest-app.js']) {{
  const code = fs.readFileSync(path.join(siteDir, s), 'utf8');
  vm.runInContext(code, context);
}}

if (context.window.PRACTICE_DATA.legacyLoaded) process.exit(1);
if (Object.keys(context.window.PRACTICE_DATA.sources).length !== 0) process.exit(2);

context.window.loadLegacyPracticeData().then(() => {{
  if (!context.window.PRACTICE_DATA.legacyLoaded) process.exit(3);
  const sourceKeys = Object.keys(context.window.PRACTICE_DATA.sources);
  if (sourceKeys.length === 0) process.exit(4);
  const scriptCountBefore = domAppendedScripts.length;
  return context.window.loadLegacyPracticeData().then(() => {{
    if (domAppendedScripts.length !== scriptCountBefore) process.exit(5);
    console.log(JSON.stringify({{ success: true, sourcesLoaded: sourceKeys.length }}));
  }});
}}).catch(err => {{
  console.error(err);
  process.exit(6);
}});
"""
        res = subprocess.run([node, '-e', script], capture_output=True, text=True, encoding='utf-8', errors='replace', check=True)
        data = json.loads(res.stdout)
        self.assertTrue(data['success'])
        self.assertGreater(data['sourcesLoaded'], 0)

    def test_repeated_optimization_is_idempotent(self):
        """Running optimize() a second time on the same directory must be a no-op."""
        optimize(self.site_dir)
        html_after_first = (self.site_dir / 'index.html').read_text(encoding='utf-8')
        quest_app_after_first = (self.site_dir / 'quest-app.js').read_text(encoding='utf-8')

        optimize(self.site_dir)
        html_after_second = (self.site_dir / 'index.html').read_text(encoding='utf-8')
        quest_app_after_second = (self.site_dir / 'quest-app.js').read_text(encoding='utf-8')

        self.assertEqual(html_after_first, html_after_second)
        self.assertEqual(quest_app_after_first, quest_app_after_second)
        self.assertEqual(html_after_second.count('quest-app.js'), 1)

    def test_startup_asset_budget(self):
        """Startup assets must not exceed 3 MB and must not request practice-data.js."""
        optimize(self.site_dir)
        result = measure(directory=self.site_dir)
        self.assertLessEqual(result['totalBytes'], 3000000)
        self.assertLessEqual(result['requests'], 5)
        asset_paths = [a['path'] for a in result['assets']]
        self.assertNotIn('practice-data.js', asset_paths)
        self.assertIn('quest-app.js', asset_paths)
        self.assertIn('bank.js', asset_paths)
        self.assertIn('practice-units.js', asset_paths)


if __name__ == '__main__':
    unittest.main()
