"""Compile prewritten per-question explanations; never calls a model or reads keys."""
import argparse
import hashlib
import json
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
STATUSES = {'consistent', 'conflict', 'ambiguous', 'unresolved'}


def dump(value):
    return json.dumps(value, ensure_ascii=False, separators=(',', ':'), sort_keys=True)


def compile_lessons(directory, sources, rows):
    directory, sources = Path(directory), Path(sources)
    questions = {q['id']: q for q in rows}
    if len(questions) != len(rows):
        raise ValueError('题目ID重复')
    lessons = {}
    for q in rows:
        if q.get('reviewedExplanation'):
            lessons[q['id']] = {'questionId': q['id'], 'sourceHash': q['sourceHash'], 'explanation': q['reviewedExplanation'], 'steps': [], 'takeaway': '', 'origin': '网站核对解析'}
    supplied = set()
    for file in sorted(sources.glob('*.json')):
        package = json.loads(file.read_text(encoding='utf-8-sig'))
        if package.get('schemaVersion') != 1 or not isinstance(package.get('lessons'), list):
            raise ValueError(f'{file.name}: 解析包格式不正确')
        for lesson in package['lessons']:
            qid = lesson.get('questionId')
            if qid not in questions or qid in supplied:
                raise ValueError(f'{file.name}: 未知或重复题号 {qid}')
            supplied.add(qid)
            if lesson.get('sourceHash') != questions[qid]['sourceHash']:
                raise ValueError(f'{qid}: 题目已变化或解析对应错误，请重新核对')
            explanation = lesson.get('explanation')
            steps = lesson.get('steps', [])
            takeaway = lesson.get('takeaway', '')
            review = lesson.get('answerReview')
            if not isinstance(explanation, str) or not explanation.strip() or len(explanation) > 16000:
                raise ValueError(f'{qid}: 缺少逐题讲解或内容过长')
            if not isinstance(steps, list) or len(steps) > 20 or any(not isinstance(s, str) or len(s) > 4000 for s in steps):
                raise ValueError(f'{qid}: 解题步骤格式不正确')
            if not isinstance(takeaway, str) or len(takeaway) > 2000:
                raise ValueError(f'{qid}: 记忆点格式不正确')
            if not isinstance(review, dict) or review.get('status') not in STATUSES or any(not isinstance(review.get(k), str) or len(review[k]) > 10000 for k in ('answer', 'reason')):
                raise ValueError(f'{qid}: 缺少答案核对结论')
            if qid in lessons:
                raise ValueError(f'{qid}: 已有核对解析，禁止静默覆盖')
            lessons[qid] = {k: lesson[k] for k in ('questionId', 'sourceHash', 'explanation', 'steps', 'takeaway', 'answerReview') if k in lesson}
            lessons[qid]['origin'] = 'AI预写讲解 · ' + str(package.get('author', 'AI'))[:50]
    chunks, index = {}, {}
    ordered = sorted(lessons)
    for offset in range(0, len(ordered), 40):
        group = {qid: lessons[qid] for qid in ordered[offset:offset + 40]}
        content = dump(group)
        name = hashlib.sha256(content.encode()).hexdigest()[:20] + '.json'
        chunks[name] = content
        index.update({qid: name for qid in group})
    manifest = {'schemaVersion': 1, 'total': len(rows), 'covered': len(lessons), 'index': index}
    coverage = {'total': len(rows), 'covered': len(lessons)}
    body = dump(manifest)
    version = hashlib.sha256(body.encode()).hexdigest()[:20]
    output = directory / 'static-lessons'
    output.mkdir(exist_ok=True)
    for name, content in chunks.items():
        (output / name).write_text(content, encoding='utf-8')
    (output / (version + '.json')).write_text(body, encoding='utf-8')
    loader = directory / 'static-lessons.js'
    if loader.exists():
        text = loader.read_text(encoding='utf-8-sig').replace('__LESSON_MANIFEST_VERSION__', version).replace('__LESSON_COVERAGE__', dump(coverage))
        loader.write_text(text, encoding='utf-8')
    report = {'total': len(rows), 'covered': len(lessons), 'missing': len(rows) - len(lessons), 'reviewed': len(lessons) - len(supplied), 'ai': len(supplied)}
    return report


def build(directory, root=ROOT):
    data = subprocess.check_output(['node', str(root / 'tools/export_lesson_source.cjs'), str(directory)], encoding='utf-8')
    return compile_lessons(directory, root / 'question-imports/lessons', json.loads(data))


if __name__ == '__main__':
    parser = argparse.ArgumentParser()
    parser.add_argument('--directory', type=Path, required=True)
    parser.add_argument('--export', type=Path, help='仅导出题目与哈希，供离线代理撰写，不调用模型')
    args = parser.parse_args()
    if args.export:
        data = subprocess.check_output(['node', str(ROOT / 'tools/export_lesson_source.cjs'), str(args.directory)])
        args.export.parent.mkdir(parents=True, exist_ok=True)
        args.export.write_bytes(data)
        print('已导出题目快照；未调用API。')
    else:
        print(json.dumps(build(args.directory), ensure_ascii=False))
