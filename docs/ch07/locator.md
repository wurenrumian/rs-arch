---
title: 定位手册
description: 按现象查文件，按改动查入口；一页装下最常走的十几条路。
outline: [2, 3]
---

这一页是查表用的，不用来读。左边是你手上的现象或改动，右边是第一个该打开的文件与函数。定位顺序固定：先确认在哪一层，再看那一层的入口，最后才进实现。

## 按现象查

| 现象 | 先打开 | 先看什么 |
|---|---|---|
| 训练侧报 `Tensor 'x' has not been initialized` | `src/python/pytorch/recstore/KVClient.py#RecStoreClient.pull` | `_tensor_meta` 里有没有这张表；`init_embedding_table` 是否成功 |
| 前向拿到的 embedding 全是零 | `src/python/pytorch/recstore/KVClient.py#RecStoreClient.init_data` | `initialize_values` 是否为 false；key 的 tag 是否与建表时一致 |
| 读请求发出去了但很慢 | `src/ps/base/dist_sharded_client.h#DistributedShardedClient::GetParameter` | 每个分片的行数是否均衡；`max_keys_per_request` 是否切得太碎 |
| 服务端 CPU 高、读延迟抖动 | `src/storage/kv_engine/engine_composite.h#KVEngineComposite::BatchGet` | 命中落在 `DirectPtr` 还是 `BatchRead`；缺失行有多少 |
| 开了 tiered 之后读变慢 | `src/storage/value_store/hybrid_value_store.h#HybridValueStore::HybridValueStore` | `cache_policy` 是不是 `clock`；`clock` 下每次读都要查元数据，且失去零拷贝 |
| 内存池耗尽、进程直接退出 | `src/memory/allocators/concurrent_slab_memory_pool.h` | `capacity_bytes` 是否按行数 × 行字节估够；默认实现耗尽走 `LOG(FATAL)` |
| 索引报 `dict OOM` | `src/storage/index/dram/pet_hash_index.h` | `capacity` 是否小于实际 key 数；固定容量哈希没有运行期扩容 |
| 写入报学习率不匹配 | `src/ps/base/cache_ps_impl.h#CachePS::CheckLearningRate` | 客户端 lr 与服务端优化器 lr 是否一致 |
| 更新后下一次读仍是旧值 | `src/storage/kv_engine/engine_composite.h#KVEngineComposite::ApplySgdUpdateFlat` | 走的是原地路径还是混合路径；混合路径写回前读不到新值 |
| 检查点加载失败 | `src/ps/base/cache_ps_impl.h#CachePS::LoadCheckpoint` | 引擎是否为空；metadata 与布局标识是否一致 |
| RDMA 注册失败 | `src/ps/rdma/rdma_ps_client_adapter.cc` | `GetRDMABackingRegion` 是否为空；`clock` 模式下 region 为 0 |
| local_shm 读写不通 | `src/ps/local_shm/local_shm_client.cpp#LocalShmPSClient::GetParameter` | 槽位状态机与 `server_epoch`；服务端进程是否在轮询 |

## 按改动查

| 想改什么 | 入口文件 | 连带要改 |
|---|---|---|
| 换默认引擎组合 | `recstore_config.json` 的 `cache_ps.base_kv_config` | 确认索引与值存储的组合在矩阵里成立 |
| 加一种索引 | `src/storage/index/` 下新增实现 + `FACTORY_REGISTER` | 索引接口 `src/storage/index/index.h`；`test_kvengine` 的组合 |
| 加一种值存储 | `src/storage/value_store/` 下新增实现 + 工厂注册 | `value_store.h` 接口；句柄语义与长度来源 |
| 换 DRAM 分配器 | `value.dram_allocator.type` | `src/memory/allocators/`；容量与 `size_classes` |
| 加一种传输 | `src/ps/client_factory.cc#CreatePSClient` | 客户端、服务端入口、协议；见第 03、04 章 |
| 改 tag 位宽 | `src/optimizer/sparse_tensor.h#MakeTensorTag` | Python 侧 `_KEY_TAG_SHIFT`，两边必须同时改 |
| 改批量切块大小 | `distributed_client.max_keys_per_request` | 服务端 `max_batch_keys_size` 已废弃，不再生效 |
| 改 tiered 策略 | `value.tiering.cache_policy` | `HybridValueStore` 构造；`clock` 会换掉整个值存储 |
| 改 SSD 页大小或 IO 深度 | `*.io.type` / `*.io.queue_depth` | `IoUringBackend` 构造；页对齐与 `O_DIRECT` |
| 加一种检查点格式 | `KVEngineComposite::SaveCheckpoint` | 加载侧版本判断；布局标识与 checksum |

## 按符号查

| 符号 | 文件 | 属于哪一段 |
|---|---|---|
| `RecStoreEmbeddingBagCollection._forward_impl` | `src/python/pytorch/torchrec_kv/EmbeddingBag.py` | 训练侧前向 |
| `RecStoreClient.pull` | `src/python/pytorch/recstore/KVClient.py` | Python 门面 |
| `CachedReadTorch` | `src/framework/pytorch/cache/tensor_adapter.cc` | op 运行时 |
| `KVClientOp::EmbRead` | `src/framework/op.cc` | op 运行时 |
| `DistributedShardedClient::GetParameter` | `src/ps/base/dist_sharded_client.h` | 分片客户端 |
| `GRPCParameterClient::GetParameter` | `src/ps/grpc/grpc_ps_client.cpp` | 传输客户端 |
| `GRPCParameterServiceImpl::GetParameter` | `src/ps/grpc/grpc_ps_server.cpp` | 服务实现 |
| `CachePS::GetParameterRun2Completion` | `src/ps/base/cache_ps_impl.h` | 服务端编排 |
| `CachePS::UpdateParameter` | `src/ps/base/cache_ps_impl.h` | 服务端编排 |
| `SGD::UpdateFlat` | `src/optimizer/optimizer.cpp` | 优化器 |
| `KVEngineComposite::BatchGet` | `src/storage/kv_engine/engine_composite.h` | 引擎读 |
| `KVEngineComposite::BatchGetFlat` | `src/storage/kv_engine/engine_composite.h` | 引擎读（平铺） |
| `KVEngineComposite::ApplySgdUpdateFlat` | `src/storage/kv_engine/engine_composite.h` | 引擎写 |
| `DramPetHashIndex` | `src/storage/index/dram/pet_hash_index.h` | 索引 |
| `DramValueStore` | `src/storage/value_store/dram_value_store.h` | 值存储 |
| `HybridValueStore` | `src/storage/value_store/hybrid_value_store.h` | 分层值存储 |
| `LocalShmPSClient::GetParameter` | `src/ps/local_shm/local_shm_client.cpp` | local_shm 客户端 |

## 定位的三条纪律

1. **先分层，再找函数。** 现象是「慢」时，先确定慢在训练侧、传输、服务端编排还是引擎，不要一上来翻 `engine_composite.h`。
2. **先看判据，再看实现。** 每个分叉点都有一个条件（融合、GPU cache、plain、在线准入、学习率），先确认条件落在哪一边，能省掉一半阅读。
3. **用证据页复核。** 本章每个结论都能在[证据索引](./evidence)里找到文件与符号；代码往前走之后，按那张表重核。

需要重跑验证时，去[第 06 章 · 改动 → 验证路径](../ch06/verification)。
