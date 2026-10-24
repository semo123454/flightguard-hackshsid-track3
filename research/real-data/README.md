# 现实数据辅助模型

本目录把公开的运行与天气数据整理成 Excel，并训练一个可审计的辅助判断模型。它不替代值班人员的放行、安全和运行决策，也不会自动改变产品中的确定性风险等级。

## 数据范围

- 机场：ATL、DFW、DEN、ORD、LAX、CLT、LAS、PHX、MCO、SEA。
- 时间：2024 年 1—4 月。选择四个完整月份是为了让提交包可复现、可下载；扩展到全年时只需把 `train_real_model.py` 的 `MONTHS` 改为 `range(1, 13)`。
- 航班运行：美国交通统计局 BTS TranStats 的月度 On-Time Reporting 数据。数据覆盖美国大型承运人，字段包括起飞/到达延误、取消、备降、天气延误和 NAS 延误。
- 天气：NOAA/NCEI Global Summary of the Day（GSOD）日汇总；每个机场使用 2024 年仍在运行且距离机场坐标最近的气象站。
- 网络暴露度：直接由 BTS 的 Origin/Dest 航段聚合，保留目的地数量、航段量和归一化暴露度，不把历史 OpenFlights 路由当作当前运行事实。

原始下载文件只保存在本地 `raw/` 缓存中，不进入交付压缩包；聚合后的训练表、来源映射和模型参数全部进入 Excel。

## Excel 工作簿

`processed/FlightGuard_Real_Data_Training_2024.xlsx` 包含：

- `airport_monthly_real`：机场-月份运行、天气、完成率和容量损失。
- `network_exposure_real`：按机场汇总的目的地数量、航段量、网络暴露度。
- `aux_model`：标准化逻辑回归的特征、均值、标准差、权重、样本数和 Brier 分数。
- `sources`：机场坐标与 NOAA 站点映射。

`processed/weather_function_model.json` 已接入 API 天气旁路。它使用 BTS 的 `completion_ratio` 作为放行正常比例代理，输入单位已转换为天气接口要求的毫米、摄氏度和米/秒；输出仅作为 `evidence.kind=estimate` 辅助证据，不覆盖规则风险。当前模型为探索性训练集模型，仍需独立留出集验证。

目标变量是“平均起飞延误 ≥15 分钟 **或** 容量损失 ≥3%”。特征为完成率、平均起飞延误、天气延误占比、能见度和风速。模型输出的是压力概率，属于探索性辅助信号；当前指标为训练集内指标，不能据此宣称因果关系或生产级准确率。

## 重跑

使用项目提供的 Python 运行时执行：

```powershell
& 'C:\Users\Summer\.cache\codex-runtimes\codex-primary-runtime\dependencies\python\python.exe' research/real-data/train_real_model.py
```

脚本会下载缺失的公开文件，生成 Excel 和 `processed/auxiliary_model.json`。若来源接口暂时限流，可保留已下载文件后重跑，脚本会跳过完整缓存。

## 来源

- BTS TranStats On-Time：<https://www.transtats.bts.gov/>
- BTS 数据字段说明：<https://www.transtats.bts.gov/Fields.asp?gnoyr_VQ=FGJ>
- NOAA NCEI GSOD：<https://www.ncei.noaa.gov/products/land-based-station/global-summary-of-the-day>
- NOAA ISD 站点目录：<https://www.ncei.noaa.gov/pub/data/noaa/isd-history.csv>
