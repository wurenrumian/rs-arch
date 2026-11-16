---
title: 证据索引
description: 本章各条结论与对应源码证据的对照表。
outline: [2, 3]
---

| 结论 | 代码证据 |
| --- | --- |
| 同一 `(client, table)` 两种更新模式冲突即失败 | `src/python/pytorch/recstore/optimizer.py#_record_table_update_mode`、`unittest/test_sparse_update_mode_guard.py` |
| `DistEmbedding` 是客户端 pull-modify-push，`update_async` 是服务端更新 | `optimizer.py#_process_dist_embedding_module`、`#_process_generic_module_with_trace` |
| 快路径探测用 `getattr`，无融合属性只是不命中 | `optimizer.py#_uses_shared_local_shm_single_table`、`#_can_use_shared_local_shm_direct_fast_path` |
| `KVClientOp` 是 `call_once` 单例，`ps_client_` 是静态指针 | `src/framework/op.cc#GetKVClientOp`、`#KVClientOp::ps_client_` |
| `EmbRead` 先清零再读；`validate_keys` 只查 dtype/维度 | `src/framework/op.cc#KVClientOp::EmbRead`、`#validate_keys` |
| 异步写/删除/存在性/文件接口未实现；`EmbUpdateAsync` 只允许 RDMA | `src/framework/op.cc#KVClientOp::EmbDelete`、`#EmbExists`、`#EmbWriteAsync`、`#WaitForWrite`、`#EmbUpdateAsync` |
| 稀疏提交工作线程、ready 回调、100µs 轮询、60s 超时、abort | `src/framework/common/sparse_gradient_commit_runtime.h#SparseGradientCommitRuntime::Submit` |
| v4 exact replace 的 key 严格递增/维度/大小约束 | `src/ps/base/sparse_gradient_commit.h#DecodeSparseGradientCommit` |
| owner 路由用 city_hash + `tag << 56`，meta 8 列布局 | `src/framework/common/owner_merged_plan.h#BuildOwnerMergedPlan`、`#OwnerMergedPlan::meta` |
| cache-aware 低命中 bypass 与更新后失效策略 | `src/framework/cache/cache_aware_op.h#CacheAwareOp::Lookup`、`#AfterUpdate` |
| GPU cache 只接受 CUDA keys；generation 在 enable/disable/clear 递增；profile 恒返回 0 | `src/framework/pytorch/cache/gpu_cache_adapter.cu#CanUseGpuCache`、`src/framework/cache/gpu_embedding_cache.cu#EnableGpuCache`、`cache_profile.h#GetLastGpuCacheProfile` |
| planned 是生产实现，TTL 只被单测导入 | `bagpipe_cache/__init__.py#BagPipeCacheController`、`plugin.py#BagPipePlugin.create`、`unittest/test_bagpipe_cache.py` |
| planned 的容量 `cache_capacity * 64`、预取闸门、依赖等待、commit 后的本地更新 | `bagpipe_cache/planned.py#__init__`、`#enqueue`、`#prefill_cache`、`#_wait_pending`、`#update_grads` |
| TTL 的四张平铺张量与 TTL margin / 淘汰上限 / dirty 回写 | `bagpipe_cache/controller.py#_alloc_bookkeeping`、`eviction.py#_evict_entries`、`#_flush_dirty_at_shutdown` |
| TTL 的 shared/local/unknown 梯度分流与 side-stream 顺序要求 | `bagpipe_cache/grads.py#update_grads`、`comm.py#_all_gather_sparse_async` |
| `_KEY_TAG_SHIFT = 56`、tag 幂等编码、保留 key 只在 GPU cache 路径检查 | `KVClient.py#_KEY_TAG_SHIFT`、`#_encode_ids`、`#_reject_gpu_cache_reserved_ids` |
| `wait(handle)` 只处理 update 句柄 | `KVClient.py#wait`、`#update_async`、`#flush_async_updates` |
| 融合 ID 生成与 EBC 分支顺序；`_RecStoreEBCFunction` 未被引用 | `torchrec_kv/EmbeddingBag.py#_forward_impl`、`#record_pooled_grad`、`#_RecStoreEBCFunction`（全仓仅此一处） |
| 稀疏优化器的 trace 归并、三种提交分支、Top-K 限制 | `optimizer.py#_process_generic_module_with_trace`、`#_process_generic_module_with_trace_single_node_distributed`、`#_process_generic_module_with_trace_shared_local_shm_single_table`、`#_validate_topk_module`、`gradient_compression.py#select_topk_rows` |
| read path 的三种模式与 bagpipe 委托 | `embedding_read_path.py#build_embedding_read_path`、`#BagPipeReadPath`、`#PrefetchReadPath` |
| PSPipeline 的线程池、dependency split、commit 顺序 | `ps_pipeline/pipeline.py#PSPipeline.__init__`、`#_check_prepared_step`、`#submit_sparse_grad` |
| owner 流水线硬约束与 forward/backward 交换 | `ps_pipeline/owner.py#GPUOwnerPipeline.__init__`、`owner_exchange.py#GPUOwnerExchange`、`owner_math.py#initialize_owner_merged_math` |
| `ShardedRecstoreClient` / `logical_shard_router` 只有测试使用 | `src/test/model_zoo/rs_demo/test_recstore_distributed.py`、`unittest/test_logical_shard_router.py` |
