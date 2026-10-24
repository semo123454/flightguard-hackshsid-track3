# 模型测试替身

模型替身目前以可编程 `FakeProvider` 定义在 `apps/api/tests/llm.test.ts`，可按调用次数返回合法输出、错误引用、伪造数字或故障。固定 JSON 样例可继续放在本目录；默认测试不会访问网络或产生模型费用。

`live-holdout.template.json` 仅定义真实模型留出案例格式。请由未编写提示词的成员复制为 `live-holdout.local.json` 后填写；`.local.json` 已被忽略，不应提交给提示词开发者或打入交付包。
