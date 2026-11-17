---
title: 存储与内存
description: 一个 embedding 行从 key 到字节，最终放在哪、怎么找回来。
outline: [2, 3]
---

## 一句话

本章回答：一个 embedding 行从 key 到字节，最终放在哪、怎么找回来。中间有两次翻译——索引把 key 换成句柄，值存储把句柄换成字节；RecStore 把这两次翻译做成可替换的两层，默认两层都在 DRAM，换介质时替换其中一层，或整体换掉引擎，之上的参数服务器与传输层不感知。

## 7 个部件

| 编号 | 短名 | 它负责回答的问题 | 落在 |
|------|------|------------------|------|
| 1 | [组合矩阵](./composite-matrix) | 索引和值存储能怎么拼，默认拼成什么，之外还有哪些整体替换的引擎 | 第 1 块 |
| 2 | [索引](./index-engine) | key 怎么变成句柄；扩容、冲突、删除各自怎么做 | 第 2 块 |
| 3 | [值存储](./value-store) | 句柄背后的字节放在哪种介质，句柄怎么解释，长度从哪来 | 第 3 块 |
| 4 | [分配器](./allocator) | 值存储的字节从哪来，池怎么切，所谓共享内存究竟是什么 | 第 4 块 |
| 5 | [读写路径](./read-path) | 一次查询或写入怎么串起索引与值存储；未命中、长度、退役各归谁 | 第 5、6 块 |
| 6 | [分层策略](./tiering) | tiered 的四种策略：按水位安放、LRU 读缓存、CLOCK 冷热交换、按工作集自选 | 第 7 块 |
| 7 | [SSD / NVM](./ssd-nvm) / [GPU](./gpu) | 页和共享内存上的读写约定；显存里的表由谁维护 | 第 8、9 块 |

## 它们怎么串起来

请求先由部件 1 决定用哪套拼装；拼装定下来，后面所有路径就固定了。写入时，写路径先向部件 3 要一个槽，写入字节，再让部件 2 把 key 指到新句柄，旧句柄交给退役。读取时顺序反过来：部件 2 用 key 找回句柄，部件 3 按句柄找到字节，部件 5 决定拷一份还是直接给指针；tiered 的 `lru` 让 SSD 句柄先在部件 6 里找副本，`clock` 则把 DRAM 槽与 SSD 行按热度交换，两者未命中都落到部件 7 的页路径。部件 4 是部件 3 的字节来源。

## 核心概念表

| 概念 | 一句话 |
|------|--------|
| 句柄 | 索引给出的定位值，值存储据此找字节；特殊值表示未命中 |
| 值存储与分配器 | 前者把句柄翻成字节，后者提供字节；DRAM 侧都建在匿名 mmap 上 |
| 页 | SSD 侧唯一的 IO 单位，读写都是整页 |
| 退役 | 旧句柄交还分配器的动作，全仓唯一的回收入口 |
| 分层策略 | tiered 的 `cache_policy`：`none` / `lru`（读缓存）/ `clock`（冷热交换）/ `adaptive` |
| 恢复 | 从共享内存镜像或检查点重建索引与占用位图的过程 |

## 建议读法

- 只想知道数据放哪：第 1 块 → 第 3 块 → 第 4 块的介质表；排查"读到的行长度不对"：第 1 块 → 第 5 块 → 第 3 块的长度列。
- 评估 tiered：第 3 块 → 第 6 块 → 第 7 块（四种策略与各自代价）；持久化、SSD 或 GPU：第 8、9 块加风险节。

## 范围与不在范围

在范围内：引擎抽象、引擎选择与工厂注册，默认拼装引擎的编排逻辑；索引家族（DRAM 的 `extendible_hash` / `pet_hash` / `unordered_map`，SSD 的 CCEH）；值存储家族（DRAM、SSD plain、SSD 静态布局、tiered 的四层安放策略）；DRAM 分配器（`MallocApi`）、`ShmFile` 后端、epoch 回收；SSD 路径的 `IOBackend`、SSD block allocator、`ssd_layout` artifact；PetKV 的共享内存布局与恢复；GPU 侧 `storage/gpu_cache` 与 `gpu_memory`。不在范围：RPC、分片、压缩、传输（第 03/04 章）；计算层与训练语义（第 02 章）；测试与基准运行方式（第 06 章）。

## 与相邻章节的接口

- [第 02 章](../ch02/)（计算层 / BagPipe）：Python 侧只通过 `KVClient` 的 `BatchGet`/`BatchPut`/`ApplySgdUpdateFlat`/`SaveCheckpoint` 与 PS 交互；GPU 缓存的驻留与淘汰由第 02 章的 controller 负责，本章只提供 `storage/gpu_cache` 的设备侧表和 `gpu_memory` 的分配器/映射（后者未接入构建）。`tag` 由 `SparseTensor` 拼在 key 高 8 位，存储层只负责还原。
- [第 03 章](../ch03/)（PS 与传输）：`CachePS` 从 `cache_ps.base_kv_config` 构造 `BaseKV`，并把 `num_threads` 传入；`GetRDMABackingRegion` 依赖 `ValueStore::RDMABackingData/Size`，因此 RDMA 可直接注册 DRAM 池；`HybridValueStore` 只透出 DRAM 子层的 region，读缓存占用的槽也在这块 region 里，而 `clock` 模式下该 region 为空。
- [第 04 章](../ch04/)（RDMA）：对端内存注册与槽位协议不在本章；本章只保证 `BackingData()` 是连续的 mmap 区域，注册粒度由传输层决定。tiered 的 `clock` 策略会关闭这条零拷贝路径。
- [第 06 章](../ch06/)（测试与基准）：`test_kvengine` 用 `AllCombos` 覆盖 3 个 DRAM 索引 × 3 种 value × 3 个分配器，对 SSD 索引组合与重型场景 skip；`test_ssd_static_layout_value_store` 覆盖读缓存提升、写穿透、失效、预算上限、并发读写、CLOCK 交换与四种策略的选择；`test_io_backend` 与 `test_ssd_allocators` 覆盖批 IO 与失败回滚。PS/e2e 基准与 `benchmark/server.py` 的配置模板默认把 `tiering.cache_policy` 设为 `none` 以保持与旧数字可比，`rs_demo` 的 tiered 配置默认 `clock`（主放置交换），所以它的端到端数字默认不具可比性，复现 cache-off 基线要显式传 `none`。
