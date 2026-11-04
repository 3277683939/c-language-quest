# 公共逐题讲解

本目录保存预先写好的题目讲解。浏览者查看时无需填写 API Key，也不会调用模型服务。构建会校验题号与题目内容哈希，然后编译成按需下载的小包，不加入首屏题库数据。

`网站核对解析`来自现有独立核对内容；`AI预写讲解`来自批量撰写，未经过逐题编译运行验证。AI 对资料答案的不同意见单独显示，不能改写原题或判分答案。不能用通用知识点模板、仅重复答案或来源说明冒充逐题解析。

## 增补流程

1. 用 `questionflow.build_preview` 构建实际发布内容。可从 `.question-import/preview-location.json` 获取构建目录。
2. 执行 `python tools/lessonbank.py --directory <构建目录> --export .question-import/static-lessons/source.json` 导出无凭据的题目快照。
3. 把缺失题目分成小批交给撰写代理。每题只需题干、代码、选项、参考答案、勘误和稳定题号；不用让代理读取浏览器或网站账户。已有讲解不重复生成。
4. 每批先写 `.tmp`，全部 JSON 校验通过后原子改名为 `.json`。多个代理使用不同文件前缀，不能覆盖彼此的文件。
5. 构建自动校验并接入。未知/重复题号、失效内容哈希、缺少解释或核对结论会阻止发布。若原题改变，应重新核对讲解，不能直接替换哈希掩盖内容变化。
6. 执行 `python tools/test_lessonbank.py`，构建后运行 `node tools/test_static_lessons.cjs`。界面显示真实覆盖数量；未完成的题保留明确的待补齐提示。

建议每批约30–40题，复杂程序题可更小。每批只返回本批讲解，不重复输出原题；完整保存的批次就是断点，代理或服务中断后只继续缺失部分。整个流程没有自动付费调用。

## JSON 格式

```json
{
  "schemaVersion": 1,
  "author": "Luna",
  "lessons": [{
    "questionId": "从快照复制的题号",
    "sourceHash": "从快照原样复制的内容哈希",
    "explanation": "针对本题说明为什么，涉及计算要写必要过程",
    "steps": ["具体的解题步骤"],
    "takeaway": "本题最值得记住的一点",
    "answerReview": {
      "status": "consistent",
      "answer": "独立核对的结论",
      "reason": "与原资料答案一致或不一致的具体理由"
    }
  }]
}
```

`status`取`consistent`（一致）、`conflict`（冲突）、`ambiguous`（有歧义/环境依赖）或`unresolved`（信息不足）。缺失的题干、代码、图片或公式不能凭空补全；未定义行为不能编造唯一输出。所有字段使用纯文本，网页以文本安全呈现。
