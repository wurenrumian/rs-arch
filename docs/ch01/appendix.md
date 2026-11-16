---
title: 附录：术语与代码位置
description: 本章术语的一句话定义与权威代码位置对照表。
outline: [2, 3]
---

| 概念 | 一句话定义 | 权威代码 |
| --- | --- | --- |
| table | 具名 embedding 表：服务端按 name 登记形状，物理上由 8-bit tag 前缀 + `num_embeddings × embedding_dim` 行组成 | `src/ps/base/cache_ps_impl.h#CachePS::InitTable`、`src/optimizer/sparse_tensor.h#MakeTensorTag` |
| shard | key 空间按 `hash(key) % num_shards` 切出的逻辑分片，每片由独立服务进程里的一个 `CachePS` 独占 | `src/ps/base/dist_sharded_client.h#GetShardId`、`src/ps/client_options.h#PSClientType` |
| owner | 对一组 key 的梯度聚合与写回负责的一方：Python 侧是建表的 `DistTensor._owner`，分布式训练里是 merged-gradient 的 `owner_rank`（服务端对应 `exact_owner_rank`） | `src/python/pytorch/recstore/DistTensor.py#DistTensor.__init__`、`ps_pipeline/owner.py`、`src/ps/base/cache_ps_impl.h#CachePS::SparseGradientCommit` |
| lane | RDMA 侧一条点对点 QP 通道（`qp_index` / `publisher_lane` / `receiver_lane` + `lane_generation`），lane 内请求带单调 `seq` | `src/ps/rdma/rdma_protocol.h#RequestDescriptor`、`src/ps/proto/rdma_control_plane.proto` |
| epoch | 基于 epoch 的内存回收安全点：`current_epoch` 与 `safe_to_reclaim_epoch` 判断一段内存能否释放 | `src/memory/epoch_manager.h#EpochManager` |
| slot | local_shm 环形队列中的一个请求槽（共 `slot_count` 个），状态机 `kFree → kWriting → kReady → kRunning → kDone/kError` | `src/ps/local_shm/local_shm_protocol.h#LocalShmSlotHeader` |
| index type | 索引组件实现，决定 key → value handle 的映射（`DRAM_PET_HASH` / `DRAM_EXTENDIBLE_HASH` / `DRAM_UNORDERED_MAP` / `SSD_*`） | `src/storage/kv_engine/engine_composite.h#KVEngineComposite`、`src/storage/index/` |
| value type | 值存储组件实现，决定行数据落在 DRAM / SSD / 分层（`DRAM_VALUE_STORE` / `SSD_VALUE_STORE` / `TIERED_VALUE_STORE`） | `src/storage/value_store/value_store.h`、`engine_composite.h` |
| allocator | 值存储内部的行级内存/块分配器（`CONCURRENT_SLAB_MEMORY_POOL` / `PERSIST_LOOP_SLAB` / SSD buddy），由 `dram_allocator` / `ssd_allocator` 选择 | `src/memory/allocators/allocator_factory.h`、`src/storage/allocator/ssd/` |
