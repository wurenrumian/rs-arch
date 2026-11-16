---
title: 第 4 块：写路径与两种更新语义
description: 稀疏梯度提交，从 backward (ids, grads) 到服务端读改写。
outline: [2, 3]
---

## 它是什么

一次稀疏梯度提交，从 `backward` 产生的 `(ids, grads)` 开始，到"服务端优化器对某几行做了读改写"结束。与读路径最大的差别在于：学习率由谁施加，在两套并存的实现里答案不同。

## 它为什么存在

写路径必须解决两个问题。第一，梯度是按 batch 产生的碎片，必须先聚合再发，否则同一个 key 在一次请求里出现多次。第二，更新之后客户端可能缓存了旧行，必须让缓存失效，否则下一步读到旧值。

## 它和谁接

上游是本块的两种计算层实现，下游是第 05 章的优化器与存储读改写。第 02 章会把同样两条语义放进 Python 侧的梯度归并与 BagPipe 上下文里再讲一遍。

## 代码位置

**两种更新语义并存。** 传统 `DistEmbedding` 路径：`backward` 只把 `(unique_ids, summed_grads)` 追加到 `mod._trace`，`SparseSGD.step()` 里的 `_process_dist_embedding_module` 做 pull-modify-push——`mod.weight[unique_ids]` 拉回、`current - lr * grads`、再 `mod.weight[unique_ids] = updated`（内部走 `emb_write`），学习率在 Python 生效。`torchrec_kv.EmbeddingBag` 与通用模块路径：`_process_generic_module_with_trace` 聚合梯度后调 `update_async(name, ids, grads)`，学习率由服务端优化器施加。两条路径对同 `(client, table)` 混用时，第一次用过的模式会被 `_record_table_update_mode` 记住，改用另一种直接 `RuntimeError`。

**提交的形态。** `RecStoreClient.update` = `update_async` + `wait`。`update_async` 先 `_normalize_ids`（含 tag 编码）、`_normalize_grads`（`float32`、连续、默认搬 CPU），生成自增 handle。若 `current_ps_backend() == "rdma"` 且 op 暴露 `emb_update_async`，直接调用并记下后端 handle；否则把 `ids.clone()` / `grads.clone()` 暂存，等 `wait()` 再提交（"staged" 路径）。`wait(handle)` 时 RDMA 走 `emb_update_wait`，staged 走 `emb_update_table`。

**进入 op 与缓存。** `emb_update_table_torch` 先 `CheckRows` 校验 `[N] int64` + `[N, D] float32`，`ToCpuTensor`，转 `RecTensor`，调 `GetConcreteKVClientOp()->EmbUpdateCached(table, keys, grads, CacheActions(keys, D))`。`EmbUpdateCached` 把真正更新包在 `g_cache_aware_op.Update(rows, cache, fn)` 里：先执行 `EmbUpdate`，成功后按 `CacheUpdateActions` 做 per-key 失效或整表清空；抛异常时也会清空 cache。`KVClientOp::EmbUpdate` 处理 `hierkv` 短路、校验后调 `ps_client_->UpdateParameter`。

**扇出。** `DistributedShardedClient::UpdateParameter` 同样 `PartitionKeys`，但要用 `GatherEmbeddingRows` 把梯度按 shard 的 `key_index_mapping_` **收集**成连续块（只发属于该 shard 的行），再按 `max_keys_per_request` 分块 `std::async` 扇出。任一 shard 返回非 0 即整体返回 -1。进程边界与读路径相同。

**服务端。** `ParameterServiceImpl::UpdateParameter` 把 `request->gradients()` 重新解释为 `ParameterCompressReader`，调 `cache_ps_->UpdateParameter(table_name, reader, 0)`；`CachePS` 调 `optimizer_->Update(...)`（flat 路径是 `UpdateFlat`），优化器内部按 `SparseTensor` 拼 key+tag 后对 `BaseKV` 做读改写，然后 `MarkCheckpointDirty()`。索引查找、值分配、缺失行补写、SSD 回写、checkpoint 语义从这一步起归第 05 章。

**一致性与可见性。** 更新成功后客户端按 `CacheUpdateActions` 失效对应 key 的 GPU cache；若更新抛异常，`CacheAwareOp::Update` 先清空整张 cache 再把异常抛出，避免读到旧行。`push`（`emb_write`）路径则无条件清空 GPU cache。`wait()` 返回的是"提交完成"，不是"值已可见于所有读者"；跨 step 的可见性由优化器 + 服务端 `SparseGradientCommit` 的 session/step 语义约束（见第 05 章）。

按步骤对照代码：

| 阶段 | 步骤 | 代码位置 |
| --- | --- | --- |
| 计算层 | pull-modify-push 与更新模式记录 | `src/python/pytorch/recstore/optimizer.py#_process_dist_embedding_module`、`#_record_table_update_mode`、`src/python/pytorch/recstore/DistEmb.py#_DistEmbFunction.backward` |
| 计算层 | 通用模块梯度聚合 | `src/python/pytorch/recstore/optimizer.py#_process_generic_module_with_trace` |
| 提交 | handle 生成与 staged 队列 | `src/python/pytorch/recstore/KVClient.py#update_async`、`#wait` |
| 提交 | op 层校验与转发 | `src/framework/pytorch/op_base.cc#emb_update_table_torch`、`#CheckRows` |
| 缓存 | 更新后失效/清空 | `src/framework/op.cc#KVClientOp::EmbUpdateCached`、`src/framework/cache/cache_aware_op.h#CacheAwareOp::Update` |
| 扇出 | 梯度收集与分块 | `src/ps/base/dist_sharded_client.h#UpdateParameter`、`#GatherEmbeddingRows` |
| 服务端 | 读取压缩梯度 | `src/ps/grpc/grpc_ps_server.cpp#ParameterServiceImpl::UpdateParameter`、`src/ps/base/cache_ps_impl.h#CachePS::UpdateParameter` |
| 服务端 | 优化器读改写 | `src/optimizer/optimizer.h#Optimizer::Update`、`src/optimizer/sparse_tensor.h#ApplySgdUpdateFlat` |

## 交付一句

第 4 块到此为止：读写两条链路都闭合到存储层入口。下一块接构建，把"这些代码从哪来"补上。
