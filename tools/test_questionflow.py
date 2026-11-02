"""Behavior tests: real parsing/import/rollback; model requests use a local fake."""
import io
import json
import tempfile
import unittest
import zipfile
from pathlib import Path
from unittest.mock import patch

import questionflow as flow
from question_extract import extract_pages, parse_questions, documents


TEXT = '''第1章 C语言基础
一、单项选择题
1. C语言块注释以什么开始？
A. // B. /* C. # D. <!--
答案：B
解析：块注释从 /* 开始。
二、填空题
1. C程序的入口函数是______。
答案：main
三、程序阅读题
1. 写出以下程序的输出。
```c
#include <stdio.h>
int main(void) {
    printf("%d\\n", 2 + 3);
    return 0;
}
```
答案：5
'''


class PipelineTests(unittest.TestCase):
    def setUp(self):
        self.temporary = tempfile.TemporaryDirectory(prefix='cquest-test-')
        self.root = Path(self.temporary.name)
        self.inbox = self.root / 'inbox'
        self.inbox.mkdir()
        (self.root / 'overrides').mkdir()
        self.original = {'id': 'legacy-1', 'source': 'h', 'chapter': 1, 'stem': '原有题目', 'options': ['甲', '乙'], 'answer': 'A'}
        (self.root / 'overrides/bank.js').write_text('window.QUESTION_BANK=' + json.dumps({'questions': [self.original], 'chapters': ['基础'], 'materials': []}, ensure_ascii=False) + ';', encoding='utf-8')
        (self.root / 'overrides/practice-units.js').write_text('window.PRACTICE_UNITS={"total":0,"units":[]};', encoding='utf-8')

    def tearDown(self):
        self.temporary.cleanup()

    def write_json(self, name, questions):
        path = self.inbox / name
        path.write_text(json.dumps({'title': '新增测试', 'questions': questions}, ensure_ascii=False), encoding='utf-8')
        return path

    def test_text_mixed_kinds_and_fenced_code(self):
        (self.inbox / '练习.txt').write_text(TEXT, encoding='utf-8')
        report = flow.import_files(self.root, self.inbox)
        self.assertFalse(report['errors'])
        self.assertEqual(report['new'], 3)
        data = flow.overlay_data(flow.load_catalog(self.root))
        self.assertEqual(len(data['questions']), 1)
        self.assertEqual(data['questions'][0]['answer'], 'B')
        self.assertEqual(len(data['questions'][0]['options']), 4)
        self.assertEqual(data['units'][0]['answer'], 'main')
        code = data['units'][1]
        self.assertIn('    printf("%d\\n", 2 + 3);', code['code'])
        self.assertEqual(code['answer'], '5')
        self.assertTrue(code['reviewPending'])

    def test_idempotent_and_renamed_duplicate(self):
        path = self.write_json('a.json', [{'number': 1, 'stem': '新填空______', 'kind': '填空题'}])
        first = flow.import_files(self.root, self.inbox)
        first_hash = flow.catalog_hash(flow.load_catalog(self.root))
        second = flow.import_files(self.root, self.inbox)
        self.assertEqual(first['new'], 1)
        self.assertEqual(second['new'], 0)
        self.assertEqual(first_hash, flow.catalog_hash(flow.load_catalog(self.root)))
        (self.inbox / '复制.json').write_bytes(path.read_bytes())
        self.assertEqual(flow.import_files(self.root, self.inbox)['new'], 0)

    def test_content_update_preserves_id(self):
        self.write_json('a.json', [{'key': 'stable', 'stem': '修改之前'}])
        flow.import_files(self.root, self.inbox)
        old_id = flow.load_catalog(self.root)['records'][0]['id']
        self.write_json('a.json', [{'key': 'stable', 'stem': '修改之后'}])
        report = flow.import_files(self.root, self.inbox)
        self.assertEqual(report['updated'], 1)
        row = flow.load_catalog(self.root)['records'][0]
        self.assertEqual(row['id'], old_id)
        self.assertEqual(row['stem'], '修改之后')

    def test_rollback_preserves_baseline_and_previous_batch(self):
        before = (self.root / 'overrides/bank.js').read_bytes()
        self.write_json('a.json', [{'stem': '第一题'}])
        flow.import_files(self.root, self.inbox)
        snapshot = flow.load_catalog(self.root)
        self.write_json('b.json', [{'stem': '第二题'}])
        flow.import_files(self.root, self.inbox)
        flow.rollback(self.root)
        self.assertEqual(flow.load_catalog(self.root), snapshot)
        flow.rollback(self.root)
        self.assertEqual(flow.load_catalog(self.root)['records'], [])
        self.assertEqual((self.root / 'overrides/bank.js').read_bytes(), before)

    def test_failed_file_does_not_partially_commit(self):
        self.write_json('a.json', [{'stem': '正常题目'}])
        self.write_json('b.json', [{'stem': ''}])
        report = flow.import_files(self.root, self.inbox)
        self.assertTrue(report['errors'])
        self.assertFalse((self.root / flow.CATALOG).exists())

    def test_duplicate_against_existing_bank_is_skipped(self):
        self.write_json('a.json', [self.original])
        report = flow.import_files(self.root, self.inbox)
        self.assertEqual(report['duplicates'], 1)
        self.assertEqual(report['new'], 0)

    def test_ocr_cannot_be_graded_until_reviewed(self):
        self.write_json('scan.json', [{'kind': '选择题', 'stem': '扫描题', 'options': ['甲', '乙'], 'answer': 'A', 'ocrPending': True}])
        flow.import_files(self.root, self.inbox)
        data = flow.overlay_data(flow.load_catalog(self.root))
        self.assertFalse(data['questions'])
        self.assertTrue(data['units'][0]['reviewPending'])
        draft = flow.read_json(self.root / flow.LOCAL / 'staging/latest.json')
        draft['catalog']['records'][0]['reviewed'] = True
        flow.atomic(self.root / flow.LOCAL / 'staging/latest.json', flow.encoded(draft))
        flow.apply_review(self.root, self.root / flow.LOCAL / 'staging/latest.json')
        self.assertEqual(len(flow.overlay_data(flow.load_catalog(self.root))['questions']), 1)

    def test_zip_input_and_path_traversal(self):
        with zipfile.ZipFile(self.inbox / '正常.zip', 'w') as archive:
            archive.writestr('试题/练习.txt', TEXT.encode('utf-8'))
        self.assertEqual(flow.import_files(self.root, self.inbox)['new'], 3)
        with zipfile.ZipFile(self.inbox / '恶意.zip', 'w') as archive:
            archive.writestr('../escape.txt', '1. 不允许')
        with self.assertRaises(ValueError):
            list(documents(self.inbox))
        self.assertFalse((self.root / 'escape.txt').exists())

    def test_answer_table_does_not_cross_kind(self):
        pages = [{'page': 1, 'text': '一、选择题\n1. 选择示例\nA.甲 B.乙\n二、填空题\n1. 填空示例______\n参考答案汇总\n一、选择题\n1. B\n二、填空题\n1. main'}]
        rows, _ = parse_questions(pages)
        self.assertEqual(len(rows), 2)
        self.assertEqual(rows[0]['answer'], 'B')
        self.assertEqual(rows[1]['answer'], 'main')

    def test_cross_page_code_is_not_lost(self):
        pages = [{'page': 1, 'text': '程序阅读题\n1. 阅读程序\n```c\nint main(void) {\n    int a = 1;'}, {'page': 2, 'text': '    return a;\n}\n```\n答案：1'}]
        rows, _ = parse_questions(pages)
        self.assertEqual(len(rows), 1)
        self.assertEqual(rows[0]['endPage'], 2)
        self.assertIn('    return a;', rows[0]['code'])

    def test_numbered_lines_inside_fence_are_opaque(self):
        rows, _ = parse_questions([{'page': 1, 'text': '1. 保留原始代码\n```c\n1. this is a numbered source line\n答案：this is data\n```\n答案：待核对'}])
        self.assertEqual(len(rows), 1)
        self.assertIn('答案：this is data', rows[0]['code'])

    def test_docx_tables_and_breaks(self):
        doc = io.BytesIO()
        with zipfile.ZipFile(doc, 'w') as archive:
            archive.writestr('word/document.xml', '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p><w:r><w:t>填空题</w:t></w:r></w:p><w:tbl><w:tr><w:tc><w:p><w:r><w:t>1. 入口函数______</w:t><w:br/><w:t>答案：main</w:t></w:r></w:p></w:tc></w:tr></w:tbl></w:body></w:document>')
        pages = extract_pages(doc.getvalue(), '.docx', self.root / 'cache', Path('unused'))
        rows, _ = parse_questions(pages)
        self.assertEqual(rows[0]['answer'], 'main')

    def test_native_pdf_blank_rules_and_cache(self):
        import fitz
        doc = fitz.open()
        page = doc.new_page()
        page.insert_text((50, 80), '1. Entry function is', fontsize=12)
        page.draw_line((160, 82), (210, 82))
        page.insert_text((50, 110), 'Answer: main', fontsize=12)
        raw = doc.tobytes()
        pages = extract_pages(raw, '.pdf', self.root / 'cache', Path('unused'))
        self.assertIn('______', pages[0]['text'])
        self.assertTrue(pages[0]['blankRulesRestored'])
        self.assertEqual(extract_pages(raw, '.pdf', self.root / 'cache', Path('unused')), pages)

    def test_transaction_recovery_restores_both_files(self):
        self.write_json('a.json', [{'stem': '已保存题'}])
        flow.import_files(self.root, self.inbox)
        old = flow.load_catalog(self.root)
        changed = json.loads(flow.encoded(old))
        changed['records'][0]['stem'] = '未完成写入'
        original_atomic = flow.atomic
        def fail_overlay(path, content):
            if Path(path) == self.root / flow.OVERLAY:
                raise OSError('模拟断电')
            return original_atomic(path, content)
        with patch.object(flow, 'atomic', side_effect=fail_overlay):
            with self.assertRaises(OSError):
                flow.commit_catalog(self.root, changed, '中断测试')
        flow.recover(self.root)
        self.assertEqual(flow.load_catalog(self.root), old)
        self.assertEqual(flow.assignment(self.root / flow.OVERLAY), flow.overlay_data(old))

    def test_ai_preview_checkpoint_and_cache_without_paid_calls(self):
        self.write_json('a.json', [{'stem': '什么是函数？'}])
        flow.import_files(self.root, self.inbox)
        calls = []
        def fake(payload, key, model):
            calls.append(payload)
            return {'answer': '函数是完成特定任务的代码单元。', 'explanation': '通过参数接收输入并可返回结果。', 'model': model}
        flow.generate_ai(self.root, 'imported', 'deepseek-flash', 20, False, requester=fake)
        self.assertEqual(len(calls), 0)
        flow.generate_ai(self.root, 'imported', 'deepseek-flash', 20, True, 'test-placeholder', fake)
        self.assertEqual(len(calls), 1)
        flow.generate_ai(self.root, 'imported', 'deepseek-flash', 20, True, 'test-placeholder', fake)
        self.assertEqual(len(calls), 1)
        flow.rollback(self.root)
        flow.generate_ai(self.root, 'imported', 'deepseek-flash', 20, True, None, fake)
        self.assertEqual(len(calls), 1)
        self.assertNotIn('test-placeholder', (self.root / flow.CATALOG).read_text(encoding='utf-8'))

    def test_id_and_fingerprint_keep_literal_spaces(self):
        a = flow.fingerprint({'stem': '输出', 'code': 'printf("a b");'})
        b = flow.fingerprint({'stem': '输出', 'code': 'printf("ab");'})
        self.assertNotEqual(a, b)

    def test_same_stem_conflicting_answers_are_kept_for_review(self):
        alternate = {**self.original, 'kind': '选择题', 'answer': 'B'}
        self.write_json('new.json', [alternate])
        report = flow.import_files(self.root, self.inbox)
        self.assertEqual(report['new'], 1)
        self.assertEqual(report['duplicates'], 0)
        data = flow.overlay_data(flow.load_catalog(self.root))
        self.assertEqual(len(data['units']), 1)
        self.assertTrue(data['units'][0]['reviewPending'])
        self.assertEqual(data['units'][0]['answer'], 'B')

    def test_invalid_choice_answer_cannot_be_graded(self):
        self.write_json('new.json', [{'stem': '题目', 'kind': '选择题', 'options': ['甲', '乙'], 'answer': 'D', 'reviewed': True}])
        flow.import_files(self.root, self.inbox)
        self.assertEqual(flow.overlay_data(flow.load_catalog(self.root))['questions'], [])

    def test_changed_answer_invalidates_ai_lesson(self):
        self.write_json('a.json', [{'key': 'fixed', 'stem': '入口函数______', 'answer': 'main'}])
        flow.import_files(self.root, self.inbox)
        catalog = flow.load_catalog(self.root)
        catalog['lessons'][catalog['records'][0]['id']] = {'answer': 'main', 'explanation': '旧解析', 'model': 'deepseek-flash'}
        flow.commit_catalog(self.root, catalog, '测试缓存')
        self.write_json('a.json', [{'key': 'fixed', 'stem': '入口函数______', 'answer': 'main()'}])
        flow.import_files(self.root, self.inbox)
        self.assertEqual(flow.load_catalog(self.root)['lessons'], {})

    def test_asset_versions_follow_content_and_are_repeatable(self):
        directory = self.root / 'built'
        directory.mkdir()
        (directory / 'index.html').write_text('<script src="imported-data.js?v=old"></script><link href="style.css" rel="stylesheet">', encoding='utf-8')
        (directory / 'imported-data.js').write_text('first', encoding='utf-8')
        (directory / 'style.css').write_text('body{}', encoding='utf-8')
        flow.version_assets(directory)
        first = (directory / 'index.html').read_text(encoding='utf-8')
        flow.version_assets(directory)
        self.assertEqual(first, (directory / 'index.html').read_text(encoding='utf-8'))
        (directory / 'imported-data.js').write_text('second', encoding='utf-8')
        flow.version_assets(directory)
        self.assertNotEqual(first, (directory / 'index.html').read_text(encoding='utf-8'))

    def test_unlabeled_answer_section_never_inherits_last_kind(self):
        rows, _ = parse_questions([{'page': 1, 'text': '一、选择题\n1. 选择示例\nA.甲 B.乙\n二、填空题\n1. 后缀______\n参考答案\n1. A\n1. .c'}])
        self.assertEqual([q['answer'] for q in rows], ['', ''])

    def test_choice_heading_alias_matches_unique_answer(self):
        rows, _ = parse_questions([{'page': 1, 'text': '一、选择题\n1. 选择示例\nA.甲 B.乙\n参考答案汇总\n一、单项选择题\n1. B'}])
        self.assertEqual(rows[0]['answer'], 'B')

    def test_native_crosspage_code_retains_numbered_lines_and_question(self):
        pages = [{'page': 1, 'text': '程序阅读题\n1. 阅读下列程序\nint main(void) {\n    int a = 1;'}, {'page': 2, 'text': '2. int b = 2;\n    return a + b;\n}\n请问该程序的输出是：\nA. 1 B. 2 C. 3 D. 4\n答案：C'}]
        rows, _ = parse_questions(pages)
        self.assertEqual(len(rows), 1)
        self.assertIn('2. int b = 2;', rows[0]['code'])
        self.assertNotIn('请问', rows[0]['code'])
        self.assertIn('请问该程序的输出是：', rows[0]['stem'])
        self.assertEqual(len(rows[0]['options']), 4)
        self.assertEqual(rows[0]['answer'], 'C')


if __name__ == '__main__':
    unittest.main()
