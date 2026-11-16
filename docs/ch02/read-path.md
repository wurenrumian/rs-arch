---
title: 第 3 块：读路径
description: 一次 forward 的读拆成三个决策：何时发起、发起给谁、结果怎么拼回张量。
outline: [2, 3]
---

## 它是什么

一次 forward 的读可以拆成三个决策：什么时候发起、发起给谁、结果怎么拼回张量。三个决策都在 Python 侧做，C++ 只提供原语；读策略只负责调度，不负责存储。

## 它为什么存在

读是训练循环里最贵的一段。逐 key 发请求会让 RPC 次数随 batch 线性增长；每次同步等结果会让 dense 计算无法与取数重叠。预取、融合（多特征共用一次取数）、缓存各自省掉一种工作，分支多就是这三件事的组合。

## 它和谁接

上游是[第 2 块](./client-shard)的 key 编码，下游是[第 1 块](./op-entry)的 op 与原语。BagPipe 分支的执行细节在[第 5 块](./bagpipe)，这里只说明它作为一个分支存在。

## 代码位置

以 `RecStoreEmbeddingBagCollection.forward` 为骨架，分支按优先级排列。"谁发起 / 谁等待 / 失败怎么表现"是每行最后一列：

| 优先级 | 分支 | 触发条件 | 谁发起 · 谁等待 · 失败表现 | 代码位置 |
| --- | --- | --- | --- | --- |
| 1 | local_shm 单表直连 | 后端是 local_shm 且只有一张表 | 调用线程借出共享内存 payload；非阻塞 H2D，lease 保留到 stream 完成；后端类型不符即抛错 | `torchrec_kv/EmbeddingBag.py#_lookup_fused_embeddings_shared_local_shm_single_table`、`op_flat.cc#local_lookup_flat_torch` |
| 2 | 单机多卡 owner 交换 | 每 rank 拥有自己的分片，需要跨卡取行 | `exchange_lookup_ids` 按 `fused_id % world` 发到 owner，owner 用 `local_lookup_flat` 读完回传；行数不匹配则重组错位，无重试 | `EmbeddingBag.py#_lookup_fused_embeddings_single_node_distributed`、`single_node_exchange.py#exchange_lookup_ids` |
| 3 | 融合预取 | 已发起 `emb_prefetch` 且句柄可用 | 发起在 `before_lookup` 之前，等待是 `wait_and_get(handle, dim, device)`；返回行数 != unique 数时按 id 合并，缺的退回 `pull` | `EmbeddingBag.py#_consume_fused_prefetch_embeddings`、`op_prefetch.cc#emb_wait_result_torch` |
| 4 | 逐特征预取 | 每个特征一个句柄 | 同上；逐句柄等待 | `embedding_read_path.py#PrefetchReadPath` |
| 5 | GPU cache 路径 | 开启 GPU cache 且 keys 在 CUDA | 调用线程；query 有主机同步；miss 回填、不淘汰 | `EmbeddingBag.py#_lookup_fused_embeddings_gpu_cache`、`pytorch/cache/cache_bindings.cc` |
| 6 | 普通 `pull` | 以上都不满足 | 调用线程同步；`emb_read` 返回时值已就绪；PS 读失败抛异常（第 03 章） | `KVClient.py#pull`、`op_base.cc#emb_read_torch` |

三条实现要记：

- 融合走 `enable_fusion`（默认 True）且本 batch 各特征 `embedding_dim` 一致；`fused_id = feature_value + (table_idx << fusion_k)`，所有特征共享 master 表（第一张表）的键空间。
- `emb_read` 的公共实现是 `CachedReadTorch`：`CacheAwareOp::Lookup` 先 query 命中数，有 miss 就 `read_missing`（staging 到 pinned CPU → `EmbRead` → 回 CUDA）→ `fill` → `scatter`，cache 不可用或整体失败就 `read_all`。`KVClient.pull` 的 id 始终在 CPU，所以**不会命中 C++ GPU cache**；只有 `pull_with_gpu_cache` / `gpu_cache_lookup_flat*` 保留 CUDA id 才走 cache。
- GPU cache 分支是 TTL/通用分支：若 `_bagpipe_current_prepared_ids` 已被 TTL prefill 设置就复用它，命中假设为真时用 `gpu_cache_lookup_flat_assuming_hits`。planned 生产路径不经过 `EBC.forward`，不会进入这里。

池化与返回：融合路径对拼接后的全部行做一次 `F.embedding_bag(..., mode="sum")` 再按特征切分，非融合路径逐特征池化后 `torch.cat`，返回 `KeyedTensor(keys=feature_keys, values=[B, sum(dim)], length_per_key=dims)`。

`torchrec_kv` 的三个适配模块决定这套骨架：

| 模块 | 与原生 torchrec 的关系 |
| --- | --- |
| `torchrec_kv/EmbeddingBag.py` | 替换 `EmbeddingBagCollection`：收 KJT、融合 ID、可选预取、拉行、本地池化；`record_pooled_grad` 提供不重放 autograd 的梯度记录路径。参数不在 `nn.Parameters` 里，表由 PS 持有，不能交给 DDP/分布式优化器 |
| `torchrec_kv/EmbeddingCollection.py` | 替换 `EmbeddingCollection`：逐特征 `pull` + 返回 `Dict[str, JaggedTensor]`，保留 unpooled 契约；可 `clamp_ids`；多表必须 `enable_fusion=True` |
| `torchrec_kv/fused_preload.py` | 不是 torchrec API：把第 i 张表的行预建到 master 表的 `(i << fusion_k) \| id` 键空间 |

`EmbeddingBag.py` 里的 `_RecStoreEBCFunction`（自定义 autograd Function）**没有被任何代码引用**，是遗留死代码；实际 forward 用 `register_hook`。

## 交付一句

读路径的六个分支、触发条件与失败表现都在表里。下一块接写路径，从同一次 forward 的反向开始。
