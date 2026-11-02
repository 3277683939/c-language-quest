"""Conservative document readers and numbered-question parser. Never execute source text."""
from __future__ import annotations

import hashlib
import json
import re
import shutil
import subprocess
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from xml.etree import ElementTree as ET

VERSION = 1
MAX_FILE = 80 * 1024 * 1024
SUPPORTED = {'.pdf', '.docx', '.txt', '.md', '.json'}
NUMBER = re.compile(r'^\s*(?:第\s*)?(\d{1,4})\s*[.．、）)]\s*(.*)$')
HEADING = re.compile(r'^\s*(?:第\s*([\d一二三四五六七八九十百]+)\s*[章单元节]+)\s*(.*)$')
KINDS = ('程序填空题', '程序阅读题', '程序改错题', '程序设计题', '编程题', '判断题', '填空题', '简答题', '多项选择题', '单项选择题', '选择题')
ALIASES = {'读程序写结果': '程序阅读题', '程序阅读': '程序阅读题', '程序填空': '程序填空题', '程序改错': '程序改错题', '程序设计': '程序设计题', '编程': '编程题', '单项选择': '单项选择题', '多项选择': '多项选择题', '填空': '填空题', '判断': '判断题', '简答': '简答题'}
ANSWER = re.compile(r'^\s*(?:【|\[)?(?:参考答案|正确答案|答案)(?:】|\])?\s*[:：]?\s*(.*)$')
EXPLANATION = re.compile(r'^\s*(?:【|\[)?(?:解析|解答|解题分析)(?:】|\])?\s*[:：]?\s*(.*)$')
OPTION = re.compile(r'(?:^|\s)([A-HＡ-Ｈ])[.．、:：)）]\s*')
CODE = re.compile(r'^\s*(?:#\s*(?:include|define|if|endif)|(?:int|void|char|float|double|long|short|unsigned|struct|FILE)\b.*[;({*]|(?:for|while|if|switch|printf|scanf|return)\s*[( ;]|[{}]\s*;?)')


def digest(data: bytes) -> str:
    return hashlib.sha256(data).hexdigest()


def safe_member(name: str) -> None:
    p = PurePosixPath(name.replace('\\', '/'))
    if p.is_absolute() or '..' in p.parts or ':' in name or '\x00' in name or any(part.startswith(('-', '@')) for part in p.parts):
        raise ValueError('压缩包包含不安全路径')


def documents(inbox: Path):
    """Yield virtual name + bytes; archive members are never extracted as paths."""
    for path in sorted(inbox.rglob('*')):
        if not path.is_file() or path.name.startswith('.') or path.name.startswith('~$'):
            continue
        name = path.relative_to(inbox).as_posix()
        if path.stat().st_size > MAX_FILE:
            raise ValueError(f'文件超过80MB，请拆分：{name}')
        suffix = path.suffix.lower()
        if suffix in SUPPORTED:
            yield name, path.read_bytes(), suffix
        elif suffix == '.zip':
            with zipfile.ZipFile(path) as archive:
                total = 0
                for item in archive.infolist():
                    safe_member(item.filename)
                    if item.is_dir():
                        continue
                    total += item.file_size
                    if item.file_size > MAX_FILE or total > 300 * 1024 * 1024:
                        raise ValueError('压缩包解压后过大，请拆分')
                    ext = PurePosixPath(item.filename).suffix.lower()
                    if ext in SUPPORTED:
                        yield name + '!' + item.filename, archive.read(item), ext
                    elif ext in {'.rar', '.zip'}:
                        raise ValueError('请先解开嵌套压缩包：' + name + '!' + item.filename)
        elif suffix == '.rar':
            exe = shutil.which('7z') or shutil.which('7zz')
            if not exe:
                raise ValueError('读取RAR需要7-Zip；也可手动解压到收件目录')
            listing = subprocess.run([exe, 'l', '-slt', '-ba', '-sccUTF-8', str(path)], capture_output=True, timeout=60, check=True).stdout.decode('utf-8-sig')
            total = 0
            for entry in re.split(r'\r?\n\s*\r?\n', listing):
                fields = dict(line.split(' = ', 1) for line in entry.splitlines() if ' = ' in line)
                member = fields.get('Path', '')
                if not member or fields.get('Folder') == '+' or fields.get('Attributes', '').startswith('D'):
                    continue
                safe_member(member)
                size = int(fields.get('Size', '0'))
                total += size
                if size > MAX_FILE or total > 300 * 1024 * 1024:
                    raise ValueError('压缩包解压后过大，请拆分')
                ext = PurePosixPath(member).suffix.lower()
                if ext in {'.rar', '.zip'}:
                    raise ValueError('请先解开嵌套压缩包：' + name + '!' + member)
                if ext not in SUPPORTED:
                    continue
                proc = subprocess.Popen([exe, 'x', '-so', '-spd', str(path), member], stdout=subprocess.PIPE, stderr=subprocess.DEVNULL)
                try:
                    content = proc.stdout.read(MAX_FILE + 1)
                    if len(content) > MAX_FILE:
                        raise ValueError('压缩包文件超过80MB')
                    if proc.wait(timeout=60):
                        raise ValueError('RAR解压失败：' + name)
                finally:
                    if proc.poll() is None:
                        proc.kill()
                    proc.stdout.close()
                yield name + '!' + member, content, ext


def read_text(raw: bytes) -> str:
    for encoding in ('utf-8-sig', 'gb18030', 'utf-16'):
        try:
            result = raw.decode(encoding)
            if '\x00' not in result:
                return result
        except UnicodeError:
            pass
    raise ValueError('无法确定文字编码，请另存为UTF-8')


def native_pdf(page) -> tuple[str, bool]:
    """Keep line order and indentation; restore only short horizontal blank rules."""
    lines = []
    rules = []
    for drawing in page.get_drawings():
        for item in drawing['items']:
            if item[0] == 'l':
                a, b = item[1:3]
                length = abs(a.x - b.x)
                if abs(a.y - b.y) < .5 and 12 <= length <= min(200, page.rect.width * .45):
                    rules.append((min(a.x, b.x), max(a.x, b.x), a.y))
    restored = False
    for block in page.get_text('dict', sort=True)['blocks']:
        for line in block.get('lines', []):
            spans = list(line['spans'])
            if not spans:
                continue
            baseline = max(s.get('origin', (0, s['bbox'][3]))[1] for s in spans)
            additions = []
            for x0, x1, y in rules:
                if abs(y - baseline) < 5 and not any(s['bbox'][0] < x1 and s['bbox'][2] > x0 for s in spans):
                    additions.append({'text': '______', 'bbox': (x0, y, x1, y), 'size': 10})
                    restored = True
            pieces = sorted(spans + additions, key=lambda s: s['bbox'][0])
            text, end = '', pieces[0]['bbox'][0]
            for s in pieces:
                gap = s['bbox'][0] - end
                if gap > s['size'] * .45 and text:
                    text += ' ' * min(20, max(1, round(gap / max(3, s['size'] * .55))))
                text += s['text']
                end = s['bbox'][2]
            lines.append((line['bbox'][1], line['bbox'][0], text))
    if not lines:
        return '', restored
    left = min(x for _, x, _ in lines)
    return '\n'.join(' ' * min(30, max(0, round((x - left) / 6))) + t for _, x, t in sorted(lines, key=lambda v: (round(v[0] / 3), v[1]))), restored


def extract_pages(raw: bytes, suffix: str, cache: Path, ocr_script: Path) -> list[dict]:
    target = cache / (digest(raw) + f'-v{VERSION}.json')
    if target.exists():
        return json.loads(target.read_text(encoding='utf-8'))
    pages = []
    if suffix == '.pdf':
        try:
            import fitz
        except ImportError:
            raise ValueError('缺少PDF组件，请运行：python -m pip install PyMuPDF') from None
        with fitz.open(stream=raw, filetype='pdf') as doc, tempfile.TemporaryDirectory(prefix='cquest-ocr-') as tmp:
            pending = []
            for index, page in enumerate(doc):
                text, restored = native_pdf(page)
                damaged = text.count('\ufffd') + text.count('\u25a1')
                needs_ocr = len(re.sub(r'\s', '', text)) < 25 or damaged > max(3, len(text) * .02)
                has_images = bool(page.get_images())
                if not text.strip() and not has_images and not page.get_drawings():
                    pages.append({'page': index + 1, 'text': '', 'ocrPending': False, 'layoutPending': False, 'blankPage': True})
                    continue
                pages.append({'page': index + 1, 'text': text, 'ocrPending': needs_ocr, 'layoutPending': restored or has_images, 'blankRulesRestored': restored})
                if needs_ocr:
                    image = Path(tmp) / f'{index + 1:05}.png'
                    page.get_pixmap(matrix=fitz.Matrix(2, 2)).save(image)
                    pending.append(index)
            if pending:
                exe = shutil.which('powershell.exe')
                if not exe:
                    raise ValueError('扫描PDF需Windows OCR。请使用Windows运行或先转换为文字TXT')
                output = Path(tmp) / 'ocr.json'
                result = subprocess.run([exe, '-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', str(ocr_script), '-InputDir', tmp, '-OutputFile', str(output)], capture_output=True, timeout=max(120, 45 * len(pending)))
                if result.returncode or not output.exists():
                    raise ValueError('Windows OCR未完成，请检查系统中文OCR语言包；本批次未入库')
                recognized = json.loads(output.read_text(encoding='utf-8-sig'))
                for row in recognized:
                    idx = int(Path(row['file']).stem) - 1
                    pages[idx]['text'] = row['text']
                    pages[idx]['ocrPending'] = True
                    if not row['text'].strip():
                        raise ValueError(f'第{idx + 1}页无法识别，本批次未入库')
    elif suffix == '.docx':
        ns = {'w': 'http://schemas.openxmlformats.org/wordprocessingml/2006/main'}
        import io
        with zipfile.ZipFile(io.BytesIO(raw)) as doc:
            root = ET.fromstring(doc.read('word/document.xml'))
        paragraphs = []
        for p in root.findall('.//w:body//w:p', ns):
            chunks = []
            for element in p.iter():
                tag = element.tag.rsplit('}', 1)[-1]
                if tag == 't':
                    chunks.append(element.text or '')
                elif tag in {'br', 'cr'}:
                    chunks.append('\n')
                elif tag == 'tab':
                    chunks.append('\t')
            paragraphs.append(''.join(chunks))
        pages = [{'page': 1, 'text': '\n'.join(paragraphs), 'ocrPending': False, 'layoutPending': bool(root.findall('.//w:drawing', ns)), 'locationType': '文档段落（非实际页码）'}]
    else:
        pages = [{'page': i + 1, 'text': text, 'ocrPending': False, 'layoutPending': False} for i, text in enumerate(read_text(raw).split('\f'))]
    if not any(p['text'].strip() for p in pages):
        raise ValueError('文档未提取到文字，本批次未入库')
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(json.dumps(pages, ensure_ascii=False, indent=2), encoding='utf-8')
    return pages


def kind_heading(text: str) -> str | None:
    value = re.sub(r'^\s*[一二三四五六七八九十\d]+\s*[、.．]\s*', '', text.strip()).strip('：: ')
    value = re.split(r'[（(]', value, maxsplit=1)[0].strip()
    for kind in KINDS:
        if value == kind or value.startswith(kind + '（') or value.startswith(kind + '('):
            return kind
    return ALIASES.get(value)


def brace_delta(line):
    # Quoted braces and ordinary comments cannot open/close a C block.
    clean = re.sub(r'"(?:\\.|[^"\\])*"|\x27(?:\\.|[^\x27\\])*\x27|//.*|/\*.*?\*/', '', line)
    return clean.count('{') - clean.count('}')


def same_kind(a, b):
    return a == b or {a, b}.issubset({'选择题', '单项选择题'})


def parse_questions(pages: list[dict]) -> tuple[list[dict], list[str]]:
    questions, notes = [], []
    chapter, chapter_name, kind = 1, '新增练习', '简答题'
    current = None
    answer_mode = False
    answer_chapter, answer_kind = None, None
    answer_rows = []
    section_counter = 0
    for page in pages:
        for line in page['text'].splitlines():
            stripped = line.strip()
            if not stripped:
                if current:
                    current['lines'].append('')
                continue
            # Fenced C code is opaque: numbered comments and "答案" cannot split it.
            in_code = bool(current and current.get('fence'))
            if stripped.startswith('```') and current:
                current['fence'] = not in_code
                current['lines'].append(line)
                continue
            h, k = (None, None) if in_code else (HEADING.match(stripped), kind_heading(stripped))
            if not in_code and stripped in {'参考答案', '参考答案汇总', '答案汇总', '习题参考答案'}:
                answer_mode, current = True, None
                answer_chapter, answer_kind = None, None
                continue
            if h:
                section_counter += 1
                chapter += 1 if chapter_name != '新增练习' else 0
                if h.group(1).isdigit():
                    chapter = int(h.group(1))
                chapter_name = stripped
                if answer_mode:
                    answer_chapter = chapter_name
                    answer_kind = None
                current = None
                continue
            if k:
                kind, current = k, None
                if answer_mode:
                    answer_kind = k
                section_counter += 1
                continue
            if answer_mode:
                answer_rows.append((answer_chapter, answer_kind, stripped, page['page']))
                continue
            match = None if in_code else NUMBER.match(line)
            if match and current and current.get('nativeCode') and current.get('codeDepth', 0) > 0 and (CODE.match(match.group(2)) or re.search(r'[;{}]\s*$', match.group(2))):
                current['numberedCode'] = True
                match = None
            if match:
                current = {'number': match.group(1), 'chapter': chapter, 'chapterName': chapter_name, 'kind': kind, 'section': kind, 'page': page['page'], 'endPage': page['page'], 'lines': [match.group(2)], 'ocrPending': page.get('ocrPending', False), 'layoutPending': page.get('layoutPending', False), 'sectionOrdinal': section_counter, 'fence': False, 'nativeCode': bool(CODE.match(match.group(2))), 'codeDepth': brace_delta(match.group(2))}
                questions.append(current)
            elif current:
                current['lines'].append(line)
                if not in_code and (CODE.match(line) or current.get('nativeCode')):
                    current['nativeCode'] = True
                    current['codeDepth'] = current.get('codeDepth', 0) + brace_delta(line)
                current['endPage'] = page['page']
                current['ocrPending'] |= page.get('ocrPending', False)
                current['layoutPending'] |= page.get('layoutPending', False)
    result = []
    for q in questions:
        lines = q.pop('lines')
        q.pop('fence', None)
        q.pop('nativeCode', None)
        q.pop('codeDepth', None)
        stem, code, options, answer, explanation = [], [], [], [], []
        mode, fenced = 'stem', False
        code_depth = 0
        for line in lines:
            if line.strip().startswith('```'):
                fenced = not fenced
                continue
            if fenced:
                code.append(line)
                code_depth += brace_delta(line)
                continue
            a, e = ANSWER.match(line), EXPLANATION.match(line)
            if a:
                mode = 'answer'
                answer.append(a.group(1))
                continue
            if e:
                mode = 'explanation'
                explanation.append(e.group(1))
                continue
            if mode == 'answer':
                answer.append(line)
                continue
            if mode == 'explanation':
                explanation.append(line)
                continue
            matches = list(OPTION.finditer(line)) if not code else []
            if matches and (matches[0].start() == 0 or not line[:matches[0].start()].strip()):
                for i, m in enumerate(matches):
                    label = chr(ord(m.group(1)) - 0xFEE0) if ord(m.group(1)) > 127 else m.group(1)
                    options.append((label, line[m.end():matches[i + 1].start() if i + 1 < len(matches) else len(line)].strip()))
                mode = 'options'
            elif mode == 'options' and options and line.strip():
                label, text = options[-1]
                options[-1] = (label, text + '\n' + line)
            elif code and code_depth <= 0 and not CODE.match(line) and re.match(r'^\s*(?:[\u4e00-\u9fff]|[Tt]he (?:output|result)|[Ww]hat (?:is|will))', line):
                stem.append(line)
            elif CODE.match(line) or code:
                code.append(line)
                code_depth += brace_delta(line)
            else:
                stem.append(line)
        # Options may follow a complete program; parse them from the code tail too.
        if code:
            option_at = next((i for i, line in enumerate(code) if re.match(r'^\s*A[.．、:：)）]', line)), None)
            if option_at is not None:
                tail = code[option_at:]
                code = code[:option_at]
                for line in tail:
                    ms = list(OPTION.finditer(line))
                    if ms:
                        for i, m in enumerate(ms):
                            options.append((m.group(1), line[m.end():ms[i + 1].start() if i + 1 < len(ms) else len(line)].strip()))
                    elif options:
                        label, text = options[-1]
                        options[-1] = (label, text + '\n' + line)
        q.update(stem='\n'.join(stem).strip(), code='\n'.join(code).rstrip(), answer='\n'.join(answer).strip(), explanation='\n'.join(explanation).strip(), options=[text for _, text in options])
        q['warnings'] = []
        if options:
            if [label for label, _ in options] != list('ABCDEFGH'[:len(options)]):
                q['warnings'].append('选项标号不连续或重复')
            if '选择' not in q['kind']:
                q['kind'] = '单项选择题'
        if q['code']:
            q['warnings'].append('代码排版与题目边界需核对')
        if q.pop('numberedCode', False):
            q['warnings'].append('代码中含数字行号，保留原文待核对')
        if q['layoutPending']:
            q['warnings'].append('含图片或恢复的横线，版面需核对')
        if q['ocrPending']:
            q['warnings'].append('OCR识别待核对')
        if re.search(r'[\ufffd\u25a1]', q['stem'] + q['code']):
            q['warnings'].append('存在无法识别的字符')
        if not q['stem']:
            q['warnings'].append('未识别到独立题干，请核对')
            q['stem'] = '请阅读以下原始内容并核对题目要求。'
        result.append(q)
    # Match only a unique chapter+kind+number; ambiguous answer tables remain unmatched.
    for ch, kd, text, page in answer_rows:
        m = NUMBER.match(text)
        if not m:
            continue
        candidates = [q for q in result if (ch is None or q['chapterName'] == ch) and (kd is None or same_kind(q['kind'], kd)) and str(q['number']) == m.group(1)]
        if len(candidates) == 1 and not candidates[0]['answer'] and m.group(2).strip():
            q = candidates[0]
            q['answer'], q['answerPage'] = m.group(2).strip(), page
    if not result:
        notes.append('未找到可靠题号；按页保留原文待整理，未宣称自动分题完成')
        for p in pages:
            if p['text'].strip():
                result.append({'number': str(p['page']), 'chapter': 1, 'chapterName': '待整理原文', 'kind': '待整理', 'section': '原文保留', 'page': p['page'], 'endPage': p['page'], 'stem': p['text'], 'code': '', 'options': [], 'answer': '', 'explanation': '', 'ocrPending': p.get('ocrPending', False), 'warnings': ['未可靠分题，需整理题号与题型']})
    return result, notes
