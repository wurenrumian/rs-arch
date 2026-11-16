---
title: 证据索引
description: 本章各条结论与代码证据（相对路径#符号）的对照表。
outline: [2, 3]
---

| 结论 | 代码证据（相对路径#符号） |
|------|---------------------------|
| 默认引擎、嵌套 `index.type`/`value.type` 查表、工厂注册名与静态链接保留 | `src/storage/kv_engine/engine_selector.h#ResolveEngine`、`src/storage/kv_engine/engine_composite.h#KVEngineComposite::KVEngineComposite`、`src/storage/value_store/hybrid_value_store.h#FACTORY_REGISTER`、`src/storage/kv_engine/kv_engine_register.cc#RecStoreForceLinkKVEngineRegistrations` |
| 默认组合与参数 | `recstore_config.json`（`cache_ps.base_kv_config`） |
| GET 快路径、未命中零填充、缺失行号契约 | `src/storage/kv_engine/engine_composite.h#KVEngineComposite::BatchGetFlat`、`#BatchGetFlatRangeImpl`、`src/storage/kv_engine/base_kv.h#MissingPositionsOutput` |
| PUT 是 COW；SGD 命中原地更新；检查点格式 | `src/storage/kv_engine/engine_composite.h#KVEngineComposite::PutInternal`、`#BatchPut`、`#ApplySgdUpdateFlat`、`#SaveCheckpoint` |
| PetHash / ExtendibleHash / CCEH 结构 | `src/storage/nvm/pet_kv/pet_hash.h#F14Chunk`、`#PetHash::Reload`、`src/storage/index/dram/extendible_hash.cpp#ExtendibleHash::Insert`、`src/storage/index/ssd/CCEH.h#DirectoryHeader`、`#kCuckooThreshold` |
| tiered 介质选择与 handle 最高位 | `src/storage/value_store/hybrid_value_store.h#HybridValueStore::TryAllocDram`、`#HybridValueStore::kSsdFlag` |
| 四种分层策略、名单放置、在线准入与参数校验 | `src/storage/value_store/hybrid_value_store.h#HybridValueStore::HybridValueStore`、`#HybridValueStore::PrepareExchange`、`#HybridValueStore::KeyUsesDram`、`src/storage/value_store/tiered_clock_value_store.h#TieredClockValueStore`、`src/storage/kv_engine/engine_composite.h#KVEngineComposite::MaybeAdmit`、`#RunBackgroundJob`、`#DrainBackgroundWork`、`tools/benchmarks/build_tiered_dram_profile.py#build_profile` |
| 读缓存结构、一致性协议、生效预算与参数校验 | `src/storage/cache/tiered_read_cache.h#TieredReadCache`、`#WriteBarrier`、`#Promote`、`#WriteThrough`、`#Invalidate`、`#EffectiveBudgetBytes`、`src/storage/value_store/hybrid_value_store.h#HybridValueStore::Read` |
| 静态布局映射、读写与页锁 | `src/storage/value_store/ssd_static_layout_value_store.h#SsdStaticLayoutValueStore::BatchRead`、`#LockPages`、`src/storage/ssd_layout/ssd_layout.h#Artifact` |
| SSD slab 整页 RMW、页锁 stripe、块级 tombstone；IOBackend 页语义、批量窗口与写计数 | `src/storage/allocator/ssd/ssd_slab_allocator.h#SsdSlabAllocator::BatchRead`、`#Free`、`#kPageLockStripes`、`src/storage/io_backend/io_backend.h#IOBackend::GetWriteStats`、`#RecordWrite`、`src/storage/io_backend/iouring/io_uring_backend.cpp#IoUringBackend::BatchIO`、`src/storage/value_store/ssd_static_layout_value_store.h#SsdStaticLayoutValueStore::ApplyPatches` |
| 混合层 SGD、平铺读与长度校验 | `src/storage/kv_engine/engine_composite.h#KVEngineComposite::ApplySgdUpdateFlat`、`#ApplySgdMixedRows`、`#BatchGetFlat`、`src/storage/value_store/value_store.h#ValueStore::ReadValue` |
| 匿名 DRAM / FS_DAX 映射（`DEV_DAX` 分支被注释）；epoch 回收与槽不回收 | `src/memory/shm_file.cc#ShmFile::ConfigForMedium`、`#AnonyDramShmFile::Initialize`、`#FsDaxShmFile::Initialize`、`src/memory/epoch_manager.h#EpochManager`、`#MinEpochTable::ReclaimOldEntries` |
| 分配器家族、OOM 行为、构造删同路径文件 | `src/memory/malloc.h#MallocApi`、`src/memory/allocators/concurrent_slab_memory_pool.h#ConcurrentSlabMemoryPool`、`src/memory/allocators/persist_loop_slab_allocator.cc#PersistLoopShmMalloc::New`、`src/memory/malloc.h#ShmEpochRecycle` |
| PetKV 写入、空 flush、unsupported 的 checkpoint/clear | `src/storage/nvm/pet_kv/pet_kv.cc#PetKV::Update`、`src/storage/nvm/pet_kv/persistence.h#clflushopt`、`src/storage/kv_engine/engine_petkv.h#KVEnginePetKV::SaveCheckpoint` |
| GPU 表族、映射与 BagPipe 边界 | `src/storage/gpu_cache/nv_gpu_cache.hpp#gpu_cache`、`#gpu_cache_api.hpp#gpu_cache_api`、`#uvm_table.hpp#UvmTable`、`#gpu_cache_nohash.h#GPUCacheWithNoHash`、`src/gpu_memory/mapping_device_memory.cuh#MappingDeviceMemory`、`src/framework/cache/gpu_embedding_cache.cu` |
| 组合测试矩阵、skip 规则、读缓存与在线准入用例 | `src/test/test_kvengine.cpp#KVEngineCartesianTest`、`#AllCombos`、`src/test/test_ssd_static_layout_value_store.cpp`（`OnlineAdmission*` / `AsyncAdmission*`）、`src/test/scripts/test_build_tiered_dram_profile.py` |
| `Util()` FATAL、tag 位宽、`LRUCachePolicy` 仅测试使用 | `src/storage/index/index.h#Index::Utilization`、`src/optimizer/sparse_tensor.h#MakeTensorTag`、`src/storage/cache/cache_factory.h#CreateCachePolicy` |
