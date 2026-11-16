---
title: 计算层：PyTorch 集成、Python 客户端与 BagPipe
description: 一次 forward 把稀疏 key 变成行交回 torchrec，一次 backward 只留一条记录。
outline: [2, 3]
---

## 一句话

一次 forward 把稀疏 key 变成一批 `[N, D]` 行再交回 torchrec；一次 backward 只留下一条 `(ids, grads)` 记录。中间那层做三件事：编码 key、按设备与后端选读策略、把梯度归并后异步提交。BagPipe 在中间插一层有界行缓存，读变成"计划内命中 + 预取"，写变成会话式稀疏提交。本章回答的问题是：一次 forward/backward 如何变成对 PS 的批量读写。

**在范围**：C++ 计算层（`framework/op.*`、`framework/pytorch/*`、`framework/cache/*`）、Python 客户端、`torchrec_kv` 适配、BagPipe、`ps_pipeline`、计算层读到的配置项。**不在范围**：RPC 报文与传输 → [第 03 章](../ch03/)；RDMA 控制面 → [第 04 章](../ch04/)；`BaseKV` / 索引 / value store → [第 05 章](../ch05/)；runner 与基准流程 → [第 06 章](../ch06/)。

## 7 个部件

| 编号 | 短名 | 它负责回答的问题 |
| --- | --- | --- |
| 1 | [op 入口](./op-entry) | 模型里的一次调用怎么变成一个注册过的 op，谁来校验参数与设备 |
| 2 | [客户端与分片](./client-shard) | key 怎么编码、单例怎么持有后端、多分片到底在哪一层完成 |
| 3 | [读路径](./read-path) | 一次 forward 走哪条读策略，分支在谁手里 |
| 4 | [写路径与梯度提交](./write-path) | 梯度从哪来、怎么归并、提交为什么是异步的 |
| 5 | [BagPipe 驻留](./bagpipe) | 客户端缓存怎么驻留、什么时候能预取、两套实现差在哪 |
| 6 | [ps_pipeline](./pipeline) | 单步流水线与 GPU owner 实验路径各自优化什么 |
| 7 | [配置与开关](./config) | 计算层真正读取哪些字段、哪些是 build 期决定的 |

## 它们怎么串起来

第 1 块交代 Python 张量进 C++ 之后变成了什么；第 2 块把 key 编码与客户端持有关系讲清，后面每条路径都用这套 key；第 3、4 块是主干，一条读链、一条写链，都从 `EmbeddingBag` 出发，分别落到 PS 的读接口和稀疏提交接口；第 5 块单独讲 BagPipe——它在读写之间插了一层驻留，仓库里有两个同名控制器，是本章最容易读错的地方；第 6 块讲把前四块串成"下一步还没算完就开始取数"的流水线；第 7 块回到配置。

## 核心概念表

| 短名 | 一句话定义 | 别称 |
| --- | --- | --- |
| op 入口 | 唯一的 Torch 算子注册点，Python 只能通过它进 C++ | `torch.ops.recstore_ops` |
| 融合 id | 多张表共用 master 键空间后的行号，高若干位放表序号 | `fused_id` |
| 物理 key | 融合 id 再或上表 tag 得到的 64 位值，存储层只认它 | encoded id、`tag << 56` |
| trace | backward 留下的待提交记录：表名、key、梯度 | 梯度轨迹 |
| 提交 | 把 trace 归并后送上参数服务器的动作，可能异步 | commit、push |
| 驻留 | 客户端内存里保留的一份行副本，命中就不用发请求 | residency、缓存命中 |
| 读策略 | 决定"何时发起、何时消费"的调度方案 | `read_mode` |

## 建议读法

- 想搞懂一次 forward 到底发了几个请求：第 1 块 → 第 3 块，跳过 BagPipe。
- 想改缓存或预取：第 2 块（key 编码）→ 第 5 块，再回第 3 块确认分支。
- 想改梯度提交或对齐数值：第 4 块 → 第 6 块，重点看不变量那一节。

## 与相邻章节的接口

- **与第 03 章**：计算层只通过 `BasePSClient` 的 `GetParameter` / `PutParameter` / `UpdateParameter` / `PrefetchParameter` / `IsPrefetchDone` / `WaitForPrefetch` / `GetPrefetchResult` / `SparseGradientCommit` / `InitEmbeddingTable` / `SaveCheckpoint` 交互。`EmbUpdateAsync` 显式要求 `ps_backend_name_ == "rdma"`；其它后端的"异步 update"是 Python 侧 staged 队列，不是真正的传输异步。
- **与第 04 章**：`PrefetchParameter` + `GetPrefetchResult` 的句柄语义是 `emb_prefetch` / `emb_wait_result` 的基础；RDMA 的 slot 池容量直接限制 BagPipe 的 `max_inflight_prefetch`（注释里按 2 shard × 32 QP × 1 slot 估算）。`op_prefetch.cc` 对 RDMA 跳过显式 `WaitForPrefetch`，因为 `GetPrefetchResult` 会内部等待并借出 slot payload。
- **与第 05 章**：`SparseGradientCommit` 的 key 已经是"逻辑 id + tag<<56"的物理 key；存储层只按 key 查索引。GPU cache 的设备侧表由第 05 章的 `storage/gpu_cache/nv_gpu_cache.hpp` 提供，计算层只调用其 Query/Insert/GetAssumingHits/Contains。
- **与第 06 章**：runner 负责把 `read_mode`、`optimization.plugin`、`prescan`、`aggregation`、`ps_pipeline_*` 翻译成上面的构造参数；模型侧只要求"返回 `KeyedTensor` / `Dict[str, JaggedTensor]`"和"trace 里有 `(name, ids, grads)`"。
