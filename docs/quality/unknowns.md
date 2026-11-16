---
title: 未确认清单
description: 需要构建、硬件或实测才能下结论的问题，按领域分组。
outline: [2]
---

# 未确认清单

这里的每一条都是**已知但没验证**的问题：代码读到某一步就断了，剩下的要靠跑起来、插故障、或者拿真实 trace。
把它们和“源码事实”混在一起写会误导人，所以单列一页。

## RDMA

- lane 重建的时延包线到底多大（故障注入测到 4.2–4.4 s，来源不明）。
- `direct_sg` 并发读在真实训练流量下的实际影响。
- 重建预算是按 lane 终身累计（成功后不复位），长期运行的风险没有量化。
- 第 04 章末尾列了 11 项故障注入观察，都还没有在大规模下复现。

→ [第 04 章](/ch04/)

## 构建

- `RECSTORE_ENABLE_THIRD_PARTY_ENGINES=ON` 是否真的可构建。
- Windows 支持：仓库里没有证据表明跑通过。

→ [构建与打包](/ch01/build)

## 存储后端

- SPDK 的实际可用性（代码路径在，没跑通记录）。
- HPS 外部引擎的接入状态。
- `GPUCacheWithNoHash` 的 `start != 0` 语义。
- CLOCK 在真实 trace 下的命中率与回写开销。
- `completion_poll_spins` 的最优值。

→ [第 05 章](/ch05/)

## 在线准入

- `online_admission` 在真实 trace 下的晋升率。
- `online_stale_jobs` / `online_queue_drops` 的比例。
- 名单行数与水位的匹配关系。
- 异步交换对 SGD 停顿时延的影响。

现有证据只有单测和上游机器的单机结果。

→ [分层策略](/ch05/tiering)

## local_shm

- `tid` 语义（填什么、谁校验）。
- 多 ready queue 下的饥饿是否真的会发生。
- `InitEmbeddingTable` 没有 deadline，对端卡住时客户端行为。

→ [local_shm 路径](/ch03/local-shm)

## 基准

- `perf` 基线只有一个桶 `node190-intel-r-xeon-r-gold-5420`，其他机器报 `no-baseline`。
- `e2e/custom/runner.py` 以仓库根为 cwd 调 ctest 是否能命中 build 目录。
- tiered 的端到端基线来自上游机器，本机未复现。

→ [基准地图](/ch06/benchmark-map)

## 怎么把一条移出这张表

三步：能构建 → 能观测 → 有对照。缺第三步的结论只能算“在这台机器上成立”，
不要写进正文当事实，先回这里。
