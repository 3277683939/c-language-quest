# 公共逐题讲解

本目录保存预先写好的题目讲解。浏览者查看时无需填写 API Key，也不会调用模型服务。构建会校验题号与题目内容哈希，然后编译成按需下载的小包，不加入首屏题库数据。

`网站核对解析`来自现有独立核对内容；`AI预写讲解`来自批量撰写。AI 对资料答案的不同意见单独显示，不能改写原题或判分答案。不能用通用知识点模板、仅重复答案或来源说明冒充逐题解析。

每条 `AI预写讲解` 的 `explanation` 第一行必须写出本题的**核验方式**，三选一：

- `核验方式：资料答案核对 + AI推导（未运行程序）` —— 只对照资料答案与标准文本；
- `核验方式：AI推导（未运行，仅按 C11 语义推演）` —— 资料没有可对照答案，讲解为独立推导；
- `核验方式：编译运行验证（本机 TDM-GCC 4.9.2，实际输出 …）` —— 必须真的编译并运行过，并在离线工作区留下运行记录（`.question-import/lessons-work/verify/<questionId>.json`）。一次运行不能当作标准答案，涉及未定义行为时必须注明。

代码片段放在 `explanation`/`steps` 的 ```c 围栏里，网页会把围栏内内容渲染成等宽代码块（保留换行与缩进，窄屏内部横向滚动），不要把代码压成一行。没有围栏、但连续 3 行以上看起来是 C 代码的文本也会自动按代码块排版。

## 增补流程

1. 用 `questionflow.build_preview` 构建实际发布内容。可从 `.question-import/preview-location.json` 获取构建目录。
2. 执行 `python tools/lessonbank.py --directory <构建目录> --export .question-import/static-lessons/source.json` 导出无凭据的题目快照。
3. 把缺失题目分成小批交给撰写代理。每题只需题干、代码、选项、参考答案、勘误和稳定题号；不用让代理读取浏览器或网站账户。已有讲解不重复生成。
4. 每批先写 `.tmp`，全部 JSON 校验通过后原子改名为 `.json`。多个代理使用不同文件前缀，不能覆盖彼此的文件。
5. 构建自动校验并接入。未知/重复题号、失效内容哈希、缺少解释或核对结论会阻止发布。若原题改变，应重新核对讲解，不能直接替换哈希掩盖内容变化。
6. 执行 `python tools/test_lessonbank.py`，构建后运行 `node tools/test_static_lessons.cjs`。界面显示真实覆盖数量；未完成的题保留明确的待补齐提示。

建议每批约20–35题，复杂程序题更小。每批只返回本批讲解，不重复输出原题；完整保存的批次就是断点，代理或服务中断后只继续缺失部分。整个流程没有自动付费调用。

### 本机批量撰写辅助脚本（离线工作区，不进入发布包）

以下脚本位于 `.question-import/lessons-work/`（`.question-import/` 已被 git 忽略）：

- `make_batches.py`：按题型把缺少讲解的题目切成批次，写到 `batches/`。
- `validate.py <批次文件>`：按题号、内容哈希、字段长度、重复文本、围栏完整性、核验方式与运行记录校验一包讲解。
- `crun.py <源文件> --qid <题号>`：用本机 `D:\Dev-Cpp\MinGW64\bin\gcc.exe` 编译运行小程序并写入运行记录。
- `ingest.py`：校验 `done/` 中全部批次，通过后复制进本目录并记录进度。
- `progress.py`：重新计算真实覆盖数、剩余数与下一批题号。

## JSON 格式

```json
{
  "schemaVersion": 1,
  "author": "DeepSeek",
  "lessons": [{
    "questionId": "从快照复制的题号",
    "sourceHash": "从快照原样复制的内容哈希",
    "explanation": "核验方式：…\n针对本题说明为什么，涉及计算要写必要过程",
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

`status`取`consistent`（一致）、`conflict`（冲突）、`ambiguous`（有歧义/环境依赖）或`unresolved`（信息不足）；资料没有参考答案时不得写 `consistent`。缺失的题干、代码、图片或公式不能凭空补全；未定义行为不能编造唯一输出。所有字段使用纯文本，网页按文本安全呈现并把代码围栏渲染成代码块。
