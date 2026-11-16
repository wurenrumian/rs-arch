---
title: 第 2 块：客户端与分片
description: Python 侧的大入口类负责表元数据、id 编码、读写门面与异步句柄，不是薄封装。
outline: [2, 3]
---

## 它是什么

Python 侧有一个大入口类，负责表元数据、id 编码、读写门面、checkpoint 和异步句柄；它不是薄封装。围绕它还有单机多卡交换、梯度归一化与 top-k、特征主序 ticket、分片路由等辅助模块。"分片"有两套实现：一套在 C++ 传输客户端内部完成，是生产路径；一套在 Python 侧按分片切换连接，只有测试在用。

## 它为什么存在

`RecStoreClient` 存在是因为模型代码不该知道 tag 编码规则、不该知道后端是 RDMA 还是 gRPC、也不该自己管理异步句柄。id 编码尤其重要：存储层只认 64 位物理 key，表身份必须藏在 key 里，这件事只能在一个地方做。分片存在是因为单进程存不下整张表，位置选择影响性能：放在 C++ 里，key 一次切完再按块并发发出；放在 Python 里，key 要逐条转成 Python 整数再分组，是 O(N) 主机循环。

## 它和谁接

上游是模型层（`EmbeddingBag` / `DistTensor`），下游是[第 1 块](./op-entry)的 op 入口。它同时被[第 3 块](./read-path)、[第 4 块](./write-path)、[第 5 块](./bagpipe)复用：读路径调 `pull` / `prefetch`，优化器调 `update_async` / `local_update_flat` / `sparse_gradient_commit_async`。

## 代码位置

| 职责 | 入口 |
| --- | --- |
| 门面：元数据、编码、读写、异步句柄 | `src/python/pytorch/recstore/KVClient.py#RecStoreClient` |
| Python 侧多分片路由（仅测试） | `sharded_client.py#ShardedRecstoreClient` |
| 读策略协议：direct / prefetch / bagpipe | `embedding_read_path.py#build_embedding_read_path` |
| 稀疏优化器与 trace 归并 | `optimizer.py#SparseSGD`、`#BagPipeSparseSGD`（`bagpipe_cache/optimizer.py`） |
| 旧式模块与远端表句柄 | `DistEmb.py#DistEmbedding`、`DistTensor.py#DistTensor` |
| 单机多卡 ID/行/梯度交换 | `single_node_exchange.py#exchange_lookup_ids`、`#exchange_sparse_grads` |

**key 的编码。** 三层叠加：

```text
fused_id   = (table_idx << fusion_k) | feature_row_id      # torchrec_kv 融合
physical   = fused_id | (table_tag << 56)                  # KVClient._encode_ids
tag        = init_embedding_table() 返回的 backend tag     # 0 是合法 tag
```

三条约束。`_KEY_TAG_SHIFT = 56`，逻辑 id 只有低 56 位，`owner_merged_plan.h` 的 `kLogicalLimit = 1 << 56` 是同一约定。`_encode_ids` 幂等：全带目标 tag 直接返回，带别的非零 tag 抛错，全 0 时才 OR 上 `tag << 56`。GPU cache 保留两个哨兵 key：`int64.max`（empty）与 `int64.max - 1`（deleted），`_reject_gpu_cache_reserved_ids` 在 CUDA id 或 `RECSTORE_VALIDATE_GPU_CACHE_KEYS=1` 时检查。

**表元数据。** `_tensor_meta[name]` 保存 `shape / dtype / base_offset / tag / table_id / backend_initialized / part_policy`；`_next_table_id` 单调递增；`register_tensor_meta(backend_table_id=...)` 要求 `initialize_backend=True`，重复注册时 shape/dtype/base_offset/table_id 必须完全一致，否则 `ValueError`。

**分片与设备边界。** 三条：

- 生产 runner 不构造 `ShardedRecstoreClient`：多分片路由由 C++ `DistributedShardedClient` 在 `BasePSClient` 内部完成。Python 版本只在 `src/test/model_zoo/rs_demo/test_recstore_distributed.py` 出现，不能与 native 分片同时使用。
- `ShardedRecstoreClient.emb_read` 的 `keys.tolist()` 是逐 key 主机同步；`_activate_shard` 在非 native 且非 local_shm 时调 `set_ps_config` 重建 PS 客户端。这是它的性能/正确性边界。
- 返回设备：非 cache 路径先在 pinned CPU 读再 `to(device, non_blocking=True)`；`emb_wait_result` 返回 CPU 张量（`from_blob` 持有 `RecTensor` 的 shared_ptr），`wait_and_get` 再按需 `.to(device)`。

## 交付一句

key 的形状固定了，客户端只有一个，生产路径的分片在 C++ 里。下一块接读路径，看这些 key 怎么被取回来。
