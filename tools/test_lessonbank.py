import copy
import json
import tempfile
import unittest
from pathlib import Path

from lessonbank import compile_lessons


class LessonTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.sources = self.root / 'sources'
        self.sources.mkdir()
        self.site = self.root / 'site'
        self.site.mkdir()
        (self.site / 'static-lessons.js').write_text('__LESSON_MANIFEST_VERSION__', encoding='utf-8')
        self.rows = [{'id': 'q1', 'sourceHash': 'a' * 64, 'answer': 'A'}, {'id': 'q2', 'sourceHash': 'b' * 64, 'reviewedExplanation': '已核对的逐题推理', 'answer': 'B'}]
        self.lesson = {'questionId': 'q1', 'sourceHash': 'a' * 64, 'explanation': '先计算整数除法，3/2 等于1，不能用实数1.5代入。', 'steps': ['3与2都是int，因此执行整数除法。'], 'takeaway': '整数商舍弃小数部分。', 'answerReview': {'status': 'conflict', 'answer': 'A、C', 'reason': '资料漏选C，保留原评分。'}}

    def package(self, lesson=None, name='one.json'):
        (self.sources / name).write_text(json.dumps({'schemaVersion': 1, 'author': 'Luna', 'lessons': [lesson or self.lesson]}, ensure_ascii=False), encoding='utf-8')

    def test_public_chunks_preserve_answers_and_review_flags(self):
        self.package()
        before = copy.deepcopy(self.rows)
        report = compile_lessons(self.site, self.sources, self.rows)
        self.assertEqual(report, {'total': 2, 'covered': 2, 'missing': 0, 'reviewed': 1, 'ai': 1})
        self.assertEqual(self.rows, before)
        version = (self.site / 'static-lessons.js').read_text()
        manifest = json.loads((self.site / 'static-lessons' / (version + '.json')).read_text(encoding='utf-8'))
        chunk = json.loads((self.site / 'static-lessons' / manifest['index']['q1']).read_text(encoding='utf-8'))
        self.assertEqual(chunk['q1']['answerReview']['status'], 'conflict')
        self.assertEqual(chunk['q1']['explanation'], self.lesson['explanation'])
        self.assertEqual(chunk['q2']['origin'], '网站核对解析')

    def test_stale_content_is_rejected_before_writes(self):
        self.package({**self.lesson, 'sourceHash': '0' * 64})
        with self.assertRaises(ValueError):
            compile_lessons(self.site, self.sources, self.rows)
        self.assertFalse((self.site / 'static-lessons').exists())

    def test_duplicates_and_unknown_ids_rejected(self):
        self.package()
        self.package(name='two.json')
        with self.assertRaises(ValueError):
            compile_lessons(self.site, self.sources, self.rows)
        (self.sources / 'two.json').unlink()
        self.package({**self.lesson, 'questionId': 'unknown'})
        with self.assertRaises(ValueError):
            compile_lessons(self.site, self.sources, self.rows)

    def test_reviewed_explanation_cannot_be_overwritten(self):
        self.package({**self.lesson, 'questionId': 'q2', 'sourceHash': 'b' * 64})
        with self.assertRaises(ValueError):
            compile_lessons(self.site, self.sources, self.rows)

    def test_invalid_fields_cannot_inflate_coverage(self):
        for change in [{'explanation': ''}, {'answerReview': None}, {'steps': ['ok', 1]}, {'takeaway': ['bad']}]:
            self.package({**self.lesson, **change})
            with self.assertRaises(ValueError):
                compile_lessons(self.site, self.sources, self.rows)

    def test_manifest_is_deterministic_and_missing_is_truthful(self):
        first = compile_lessons(self.site, self.sources, self.rows)
        self.assertEqual(first['missing'], 1)
        files = {p.name: p.read_bytes() for p in (self.site / 'static-lessons').glob('*.json')}
        compile_lessons(self.site, self.sources, self.rows)
        self.assertEqual(files, {p.name: p.read_bytes() for p in (self.site / 'static-lessons').glob('*.json')})


if __name__ == '__main__':
    unittest.main()
