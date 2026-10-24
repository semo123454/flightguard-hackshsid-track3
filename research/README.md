# 可选天气研究状态

当前状态：**未启用**。

赛事数据仅有小规模月度模拟记录，当前交付没有声称得到可靠的天气—机场放行正常比例预测关系，也没有附带已验证模型文件。主系统因此默认使用 `DisabledWeatherModel`，返回 `status: not_configured` 与 `estimate: null`。

后续如开展研究，应按 `docs/IMPLEMENTATION_GUIDE.md` 第 10 节建立独立 Python 3.12 + uv 环境，完成时间切分、基准对照、最终留出集、模型卡和 Python/Node 数值一致性验证。只有导出的 JSON 明确包含 `validated: true`、训练范围、验证摘要、数据校验和、特征顺序、缩放参数与有效范围时，Node 侧 `JsonWeatherModel` 才会返回 `ok`。

未验证、缺失特征、机场范围外或输入越界时，估计必须为 `null`；该旁路结果不会覆盖确定性规则风险。
