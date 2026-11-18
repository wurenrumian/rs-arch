---
title: 系统总览、仓库地图与构建
description: 训练进程只有 key 和结果缓冲，行放在另一个进程，按 key 哈希切片送达。
outline: [2, 3]
---

## 一句话

一个训练进程要读写 embedding，但表不归它所有：它手里只有 key 和一块结果缓冲，行放在另一个进程里。请求按 key 哈希切片，经一条可替换的传输通道送到服务进程；服务进程把"读某几行""按梯度更新某几行"翻译成对本地存储引擎的批量操作。本章拆这条链路：哪些目录承载它、跨了几个进程边界、读和写各自怎么走完、用什么选项和配置编出来。

范围：顶层目录与 `src/` 12 个一级模块的职责边界；三层架构在代码里的真实类型（不照抄 `docs/architecture/overview.md`）；一次 `EmbRead`、一次 `EmbUpdate` 的端到端主路径，止于"进入存储层"；构建选项、`third_party` 依赖、wheel 打包与产物；配置项 → 默认值 → 生效位置。不在本章：RDMA wire 协议与 lane 生命周期 → 第 04 章；`BaseKV` / index / value store / allocator 内部 → 第 05 章；`model_zoo/`、`src/test/`、`tools/benchmarks/` 的用法 → 第 06 章。

## 6 个部件

| 编号 | 短名 | 它负责回答的问题 |
| --- | --- | --- |
| 1 | [仓库地图](./repo-map) | 想改的东西在哪个目录、哪个模块，构建入口按什么顺序串起来 |
| 2 | [三层调用链](./call-chain) | 一次读写跨了哪几个进程，跨层之间传的是什么 |
| 3 | [读路径](./read-path) | 一次前向查表从 Python 张量走到存储行，中间经过哪些步骤 |
| 4 | [写路径与两种更新语义](./write-path) | 梯度提交到服务端有哪两套语义，写完的值什么时候对别人可见 |
| 5 | [构建与打包](./build) | 这些代码怎么编出来，缺什么会直接失败 |
| 6 | [配置与开关](./config) | 默认值从哪来，改哪个字段才真的生效 |

## 它们怎么串起来

第 1 块给静态结构：有哪些目录，`src/` 的 12 个模块各管什么，构建入口按什么顺序把它们加进来。第 2 块在这张地图上画动态走向：一次调用从训练进程的模型出发，穿过传输客户端，越过进程边界，落到服务进程的缓存与优化器，最后进入存储引擎。第 3、4 块各走一遍完整链路，一条读、一条写，写那条还要区分两种更新语义。第 5、6 块回答"怎么把它跑起来"：编译选项和运行时配置。整条链从构建到稳态训练的顺序，收在[启动与运行全景](/guide/lifecycle)那张大图里。

## 核心概念表

| 短名 | 一句话定义 | 别称 |
| --- | --- | --- |
| 计算层 | 训练进程内的一切：模型、Python 客户端、op 运行时、传输客户端 | 客户端侧、client side |
| 参数服务器 | 独立服务进程，持有表元数据与优化器，是跨进程读写的落点 | PS、服务端 |
| 存储层 | 服务进程内真正存放行的引擎：索引、值存储、分配器 | KV、后端 |
| 分片 | key 空间按哈希切出的等份，每份由一个服务进程独占 | shard |
| tag | 表在 key 高位上的 8 位前缀，让多张表共用一个 key 空间 | 表标签、键空间前缀 |
| 借用视图 | 只带指针和形状、不负责释放的张量视图，跨层靠它免拷贝 | `RecTensor` |
| 批 | 一次请求携带的 key 行数上限，超过就切块并发 | batch、chunk |

## 建议读法

- 目标是跑通一遍：第 1 块 → 第 5 块（构建）→ 第 6 块（配置）→ 回第 3 块对照读路径，确认命中哪个分支。
- 目标是改传输或后端：第 2 块 → 第 3 块 → 第 4 块，然后转第 03、04 章。
- 目标是查术语或定位代码：先看附录，再用第 1 块的模块表落到文件。

## 与相邻章节的接口

- 第 02 章（计算层）：本章停在 `torch.ops.recstore_ops` 的 op 边界。`read_mode`（`direct` / `prefetch` / `bagpipe`）、`torchrec_kv.EmbeddingBag`、`fused_preload`、`ps_pipeline/owner.py`、GPU cache 的 Python 镜像都在那边展开。
- 第 03 章（PS 与传输）：从 `CreatePSClient` 之后接手——路由/分块/合并、prefetch 句柄、`ShardClient` 契约、服务端 `ParameterServiceImpl`、gRPC 失败传播与 checkpoint fan-out。
- 第 04 章（RDMA）：`RDMAPSClientAdapter`、`petps_server`、`rdma_protocol.h` 的 lane/seq、`rdma_control_plane.proto`。
- 第 05 章（存储与内存）：从 `CachePS::GetParameterRun2Completion` / `UpdateParameter` 进入 `BaseKV` 之后的一切，含四种 tiering 策略、`SparseTensor` 读改写、缺失行补写、checkpoint 与 `server_epoch`。
- 第 06 章（model zoo / 测试 / 工具）：`model_zoo/*` 的运行方式、`src/test/*` 与 `tools/benchmarks/*`（含 `perf_suite.py` 注册式性能套件）的基准 lane 定义。
