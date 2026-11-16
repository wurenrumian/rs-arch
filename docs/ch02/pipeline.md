---
title: 第 6 块：ps_pipeline
description: PSPipeline 把准备、后台拉取、提交后读排成流水，owner 路径把分片绑到卡上。
outline: [2, 3]
---

## 它是什么

两个实验性的组织方式：`PSPipeline` 把单步里的"准备 ticket、后台拉取、提交后读"排成流水；`GPUOwnerPipeline` 把分片直接按 owner 绑到卡上，用 NCCL 在两卡之间交换 merged 行，用 v4 整行替换把新行发布回去。

## 它为什么存在

默认读路径同步等结果。当 dense 计算不足以掩盖取数延迟时，唯一有效的办法是让取数提前一步发生；`PSPipeline` 就是这种重叠，并顺带解决一个正确性问题——上一步刚被改过的 key，这一读取到的必须是新值，于是有 dependency split。owner 路径的存在理由是省掉"读回 PS 再更新"的往返：一行只属于我一个 rank 时，完全可以本地算完再整行发布。

## 它和谁接

上游是[第 3 块](./read-path)的读路径与[第 4 块](./write-path)的优化器，下游是[第 03 章](../ch03/)的稀疏提交接口与[第 04 章](../ch04/)的 NCCL/预取资源。它不替换 BagPipe，两者是并列的实验方向。

## 代码位置

| 路径 | 职责 |
| --- | --- |
| `ps_pipeline/pipeline.py` | 单步流水线：CPU ID ticket、后台线程拉取、提交后读、可选 dependency split（按"上一步哪些 key 被改"分区干净/脏行） |
| `ps_pipeline/owner.py` | rank r 拥有 city_hash 分片 r；forward 做 merged-row 交换，backward 用 v4 exact replace 发布新行 |
| `ps_pipeline/owner_exchange.py` | world-2 NCCL owner 交换：CPU plan 上传、`forward_rows`、`run` 计算候选行与状态 |
| `ps_pipeline/owner_math.py` / `.cu` | JIT 编译的 merged-gradient 算术：`g = (r0 + r1) * 0.5`，`new = old - lr * g`，严格浮点选项 |

**owner 判定。** `owner = CityHash64(physical) % 2`，与存储层 `base/hash.h::GetHash` 的编码一致。`OwnerMergedPlan.meta` 每行 8 列 `[key, c0, c1, type, offset0, nvec0, offset1, nvec1]`；`permutation` 先按 destination 0 再 1 排列本地 merged 行，`forward_send_index` / `forward_reorder` 描述 forward 方向，`rows[source]` 是该 rank 观测到的每个 source 的行数。

**提交。** forward 用 NCCL 交换 merged 行并就地算出候选新行；backward 把候选行通过 `sparse_owner_replace_async` 以 `header.version=4` 发布，服务端直接替换整行。硬约束：world=2、`embedding_dim==128`、CUDA、NCCL、显式 `total_steps`、每 rank 一个 city_hash 分片、表类型 0/1，`owner_math` 还要求 SM80；任一不满足直接 `ValueError`，没有 CPU/其它维度回退，`sparse_owner_replace_close` 的 abort 是 sticky failed，后续不能重试。

**等待。** 流水线只有一个 pending 提交：`_check_prepared_step` 要求当前 batch 已提交才能准备下一个，`before_lookup` 要求 `step == _current_step + 1`，`submit_sparse_grad` 要求 `_current_step == _submitted`；dependency split 额外要求 world=2 且 `total_steps` 显式给出。`RECSTORE_PS_DEVICE_MERGE=1` 时才在 GPU 上合并 clean/dirty 行（要求 dependency split + CUDA + batch ≥ 4096）。

## 交付一句

流水线与 owner 是两个可选的重叠方案，约束都在第 4 块的不变量表里。下一块接配置，把这些方案真正读到的字段列出来。
