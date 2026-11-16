---
title: 模型接入、测试、基准与工具
description: 把 RecStore 接进训练循环要动哪几处，改完按什么顺序跑才算没坏。
outline: [2, 3]
---

## 一句话

这一章是入口地图：把 RecStore 接进一个训练循环要动哪几处，以及改完之后按什么顺序跑，才能说"没坏"。

## 6 个部件

| 编号 | 短名 | 它负责回答的问题 |
|------|------|------------------|
| 1 | [训练接入](./training-integration) | 一个 step 里，查询、梯度回写、优化器更新、检查点分别接在哪 |
| 2 | [其它模型与例子](./model-examples) | 除主入口外还有哪些训练脚本，各自到底接没接 RecStore |
| 3 | [测试地图](./test-map) | 哪个测试覆盖哪条不变量，跑起来要什么前置条件 |
| 4 | [基准地图](./benchmark-map) | 指标按哪三层拆，产物长什么样，驱动脚本怎么选 |
| 5 | [验证路径](./verification) | 按改动落点，最小验证集与全量验证集分别是什么 |
| 6 | [工程工具](./tooling) | CI、格式、注册守卫各自从哪进 |

## 它们怎么串起来

想接入新模型，先看部件 1，那里有一个 step 的完整接入顺序；想确认某个现成脚本是不是真的在用 RecStore，查部件 2。改完代码不确认范围时，走部件 5：它把"改了什么"映射到"先跑哪条命令"，被引用的测试与基准分别是部件 3 和部件 4。部件 6 是外围：CI 把部件 3、4 串成流水线。

## 核心概念表

| 概念 | 一句话 |
|------|--------|
| 接入点 | 训练循环里与存储交互的那几行代码 |
| 读路径 | 查询怎么发出去、梯度怎么回来的那套策略 |
| 提交与刷新 | 稀疏梯度先提交成句柄，再统一等待的两段式 |
| 验证网 | 从单元测试到集成测试的分层测试集合 |
| 层 | 基准的三档口径：存储、PS 传输、端到端 |
| lane | 一组固定步数与参数的基准运行单元 |
| 注册 | 测试文件进入 ctest 名单；没注册的必须显式豁免 |

## 建议读法

- 要把某个新模型接进来：[第 1 块](./training-integration) → [第 2 块](./model-examples)，对照现有脚本改。
- 改完代码不知道跑什么：[第 5 块](./verification) → [第 3 块](./test-map)，按落点补齐。
- 要出可比较的性能数字：[第 4 块](./benchmark-map) → [第 6 块](./tooling)，先对齐口径再报数。

## 范围与不在范围

在范围内：`model_zoo/` 下四个训练入口、`examples/`、`src/executable/` 的接入程度；C++ 与 Python 测试地图；基准体系（可执行文件、驱动脚本、产物、报告格式）；工程工具（CI 复现、格式、文档站、注册守卫）。不在范围内：计算层算子内部（02 章）、PS 协议与传输（03/04 章）、存储引擎内部（05 章）、具体性能数字（本仓库要求文档不复述易过期数字，见 `docs/performance/methodology.md`）。

## 与相邻章节的接口

| 章节 | 本章向上依赖 | 本章向下提供 |
| --- | --- | --- |
| 01 总览与构建 | 构建产物名（`ps_server`、`petps_server`、`recstore_torch_ops`、`benchmark_kv_engine`）、CMake 选项 | 各产物的验证入口与基准入口 |
| 02 计算层 / PyTorch | `RecStoreClient`、`RecStoreEmbeddingBagCollection`、`SparseSGD`、`PSPipeline`、`BagPipe` | 接入示例（rs_demo / torchrec_dlrm）、精度对齐与 topk 验证网 |
| 03 参数服务器与传输 | `ps_transport_benchmark` 的 `transport=` 口径、`summary` 行格式 | PS 基准命令、拓扑参数、`summary.md` 格式 |
| 04 RDMA | `RECSTORE_RDMA_*` 环境变量、`rdma_integration` 测试标签 | RDMA 验证阶梯（协议 → 集成 → 基准）与跳过语义（exit 77） |
| 05 存储与内存 | KVEngine 组合、`--index-type`/`--value-store-type`/allocator 名称 | `run_kvengine_compare.py` 的 engine 组合与 YCSB 口径 |
