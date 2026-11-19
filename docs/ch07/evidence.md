---
title: 证据索引
description: 本章每条路径引用的文件与符号，按阶段排列，便于随代码变更复核。
outline: [2]
---

版本基线：`upstream/main` 的 `a1cfcc81f`。路径相对仓库根，符号用 `#` 分隔。

## 训练侧

| 文件 | 符号 | 证明什么 |
|---|---|---|
| `src/python/pytorch/torchrec_kv/EmbeddingBag.py` | `RecStoreEmbeddingBagCollection._forward_impl` | 前向入口；融合判据 `use_fused` |
| 同上 | `_pull_fused_rows` | 融合路径最终落到 `kv_client.pull` |
| 同上 | `_append_trace` | 反向梯度按行记进 `_trace` |
| `src/python/pytorch/recstore/optimizer.py` | `SparseSGD.step` | 一步训练里聚合与提交的位置 |
| 同上 | `_process_generic_module_with_trace` | 按表分组、`torch.unique`、`index_add_` |
| 同上 | `SparseOptimizer.flush` | `wait(handle)` 把暂存请求真正提交 |

## Python 门面与 op 运行时

| 文件 | 符号 | 证明什么 |
|---|---|---|
| `src/python/pytorch/recstore/KVClient.py` | `RecStoreClient.pull` | 读的 Python 入口 |
| 同上 | `RecStoreClient._normalize_ids` | 转 `int64`、连续、CPU |
| 同上 | `RecStoreClient._encode_ids` | tag 拼进高 8 位 |
| 同上 | `RecStoreClient.update_async` | 写请求的暂存与提交 |
| `src/framework/pytorch/op_base.cc` | `emb_read_torch` | `emb_read` 的实现只有一行转发 |
| 同上 | `emb_update_table_torch` | 更新入口 |
| `src/framework/pytorch/cache/tensor_adapter.cc` | `CachedReadTorch` | GPU cache 分流与 `EmbRead` 调用 |
| `src/framework/op.cc` | `KVClientOp::KVClientOp` | PS 客户端的懒构造 |
| 同上 | `KVClientOp::EmbRead` | 校验、零填、`GetParameter` |
| 同上 | `KVClientOp::EmbUpdateWithLearningRate` | `UpdateParameter` 的调用点 |

## 客户端与传输

| 文件 | 符号 | 证明什么 |
|---|---|---|
| `src/ps/client_factory.cc` | `CreatePSClient` | 四种后端的选型 |
| `src/ps/base/dist_sharded_client.h` | `DistributedShardedClient::GetParameter` | 分片、`std::async`、按 `max_keys_per_request` 切块 |
| `src/ps/grpc/grpc_ps_client.cpp` | `GRPCParameterClient::GetParameter` | 异步 stub 与按 `MAX_PARAMETER_BATCH` 切分块 |
| 同上 | `GRPCParameterClient::UpdateParameter` | 更新请求的序列化与发送 |
| `src/ps/local_shm/local_shm_client.cpp` | `LocalShmPSClient::GetParameter` | 共享内存读路径 |
| `src/ps/rdma/rdma_ps_client_adapter.cc` | `RDMAPSClientAdapter::GetParameter` | RDMA 读入口 |

## 服务端编排

| 文件 | 符号 | 证明什么 |
|---|---|---|
| `src/ps/grpc/grpc_ps_server.cpp` | `GRPCParameterServiceImpl::GetParameter` | 读请求进入编排层 |
| 同上 | `GRPCParameterServiceImpl::UpdateParameter` | 写请求进入编排层 |
| 同上 | `GRPCParameterServiceImpl::InitEmbeddingTable` | 建表请求 |
| `src/ps/base/cache_ps_impl.h` | `CachePS::CachePS` | 引擎与优化器在启动时构造；在线准入要求 SGD |
| 同上 | `CachePS::InitTable` | 登记表、返回 tag |
| 同上 | `CachePS::GetParameterRun2Completion` | 读走 `BatchGet` |
| 同上 | `CachePS::GetParameterFlat` | 平铺读走 `BatchGetFlat` |
| 同上 | `CachePS::UpdateParameter` | 校验学习率后交给优化器 |
| 同上 | `CachePS::CheckLearningRate` | 客户端与服务端学习率必须一致 |

## 存储引擎与介质

| 文件 | 符号 | 证明什么 |
|---|---|---|
| `src/storage/kv_engine/engine_composite.h` | `KVEngineComposite::KVEngineComposite` | 引擎构造时查两次工厂 |
| 同上 | `BatchGet` | 索引批量查 + 逐行直接指针或批量读 |
| 同上 | `BatchGetFlat` | 平铺快路与缺失行填零 |
| 同上 | `BatchPut` | 去重、批量分配、批量替换、统一退役 |
| 同上 | `ApplySgdUpdateFlat` | tag 拼 key、原地改或混合路径 |
| 同上 | `BatchGetDirectFixedRows` | RDMA 直读的入口 |
| `src/storage/index/dram/pet_hash_index.h` | `DramPetHashIndex` | 默认索引实现 |
| `src/storage/value_store/dram_value_store.h` | `DramValueStore` | 默认值存储；`SlotCapacity` 与 `DirectPtr` |
| `src/storage/value_store/ssd_value_store.h` | `SsdValueStore` | 页路径与槽头长度 |
| `src/storage/value_store/hybrid_value_store.h` | `HybridValueStore` | tiered 的介质选择与句柄最高位 |
| `src/storage/value_store/tiered_clock_value_store.h` | `TieredClockValueStore` | CLOCK 的句柄、晋升与回写 |
| `src/memory/allocators/concurrent_slab_memory_pool.h` | `ConcurrentSlabMemoryPool` | 默认 DRAM 分配器 |
| `src/storage/io_backend/iouring/io_uring_backend.cpp` | `IoUringBackend::BatchIO` | 页级批量 IO |

## 复核建议

- 改了读写主路径，先重核 `KVClient.py` 的归一化与编码、`op.cc` 的三个调用点、`cache_ps_impl.h` 的两个入口。
- 改了引擎内部，重核 `engine_composite.h` 的 `BatchGet` / `BatchPut` / `ApplySgdUpdateFlat` 与第 05 章的证据索引。
- 改了传输，重核 `client_factory.cc` 与对应 server 的四个方法，再回第 03、04 章。
