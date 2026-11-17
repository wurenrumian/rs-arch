---
title: 风险、坑与未确认点
description: 共享内存、长度语义、tiered 策略与显存侧的风险、坑与未确认点清单。
outline: [2, 3]
---

1. [源码事实] "共享内存/持久内存"名不副实。`ShmFile::ConfigForMedium("DRAM")` 返回 `ANONY_DRAM`，实现是 `MAP_PRIVATE | MAP_ANONYMOUS`，`filename` 只用于日志；`DramValueStore` 又把 medium 写死成 `"DRAM"`。根配置里的 `/dev/shm/recstore_kv/value` 不会创建文件，进程退出即丢，跨进程也不共享。更危险的是 `ConcurrentSlabMemoryPool` 构造时会先 `PathExists` 再 `Delete` 同路径文件，把 `value.path` 指向真实文件（例如 checkpoint）会被静默清理。证据：`src/memory/shm_file.cc#ShmFile::ConfigForMedium`、`#AnonyDramShmFile::Initialize`、`src/storage/value_store/dram_value_store.h#DramValueStore::DramValueStore`、`src/memory/allocators/concurrent_slab_memory_pool.h#ConcurrentSlabMemoryPool::ConcurrentSlabMemoryPool`。
2. [源码事实] PetKV 不能 checkpoint、不能 clear，flush 仍是空操作。`clflushopt()` 首行 `return;`，`clflushopt_range` 只做 `sfence`，`PetMultiKV` 没有 flush 接口；`ConfigForMedium` 永不返回 `DEV_DAX`；`PersistMemoryPool::AddMallocs4Recovery` 只打 "not implement"。因此"从停机恢复"只在手工走 `PMMmapRegisterCenter` 时可能成立，而 `SaveCheckpoint`/`LoadCheckpoint`/`clear()` 现在会明确报 unsupported 并保持存储不变。证据：`src/storage/nvm/pet_kv/persistence.h#clflushopt`、`src/memory/allocators/persist_loop_slab_allocator.h#PersistMemoryPool::AddMallocs4Recovery`、`src/storage/kv_engine/engine_petkv.h#KVEnginePetKV::SaveCheckpoint`。
3. [源码事实] `none` / `lru` 下 tiered 仍是立即释放，没有延迟队列。`HybridValueStore` 在这两种模式下没有覆写 `Retire`，旧 handle 立即 `Free`，而 `DramValueStore::Retire` 是 1 ms 延迟队列；`clock` 覆写为把槽位放进分片 `free_slots`，复用前把世代加一，拿着旧 handle 的读者会匹配失败而不是读到复用槽。残留风险在 SGD 原地更新：`ApplySgdUpdateFlat` 的 DRAM 命中路径直接改池内字节，若另一线程仍持有 `DirectPtr` 视图，`BatchDelete` 后可能读到已回收槽。证据：`src/storage/value_store/value_store.h#ValueStore::Retire`、`src/storage/value_store/hybrid_value_store.h#HybridValueStore`、`src/storage/value_store/tiered_clock_value_store.h#TieredClockValueStore::FreeLocked`、`src/storage/value_store/dram_value_store.h#DramValueStore::Retire`。
4. [源码事实] DRAM 的"变长"在非 flat 路径上不可靠。`SlotCapacity` 对 `R2_SLAB` 返回 jemalloc 可用大小（带 padding），`Get`/`BatchGet` 会返回比写入更长的行；`CachePS::GetParameter` 会因 `slice.Size() != embedding_dim` 直接失败。证据：`src/storage/value_store/dram_value_store.h#DramValueStore::Read`、`src/memory/allocators/r2_slab_allocator.h#R2alloc::GetMallocSize`、`src/ps/base/cache_ps_impl.h#CachePS::GetParameterFlat`。
5. [源码事实] `Util()` 在默认引擎上会 FATAL。`KVEngineComposite::Util` 调 `index_->Utilization()`，而基类 `Index::Utilization` 是 `LOG(FATAL) << "not implemented"`；`DramPetHashIndex` 与 `DramUnorderedMapIndex` 都没有覆盖，只有 `DRAM_EXTENDIBLE_HASH` 能安全调用。证据：`src/storage/index/index.h#Index::Utilization`、`src/storage/kv_engine/engine_composite.h#KVEngineComposite::Util`。
6. [源码事实] `tid` 越界会直接 abort。`checkpoint_keys_by_thread_` 按 `config.num_threads_` 分配，`TrackKey` 在 `tid >= size` 时 `LOG(FATAL)`；`CachePS` 用 `cache_ps.num_threads` 传入，任何外部线程用更大 tid 调 `Put`/`BulkLoad` 都会崩。证据：`src/storage/kv_engine/engine_composite.h#KVEngineComposite::CheckpointKeysForThread`。
7. [源码事实] 8 位 tag 压缩了 key 空间。`ApplySgdUpdateFlat` 用 `(tag << 56) | (key & 0x00FF_FFFF_FFFF_FFFF)` 还原被标记的 key，隐含 key < 2^56；`MakeTensorTag` 只检查 tag 是否 > 255，不检查 key 宽度。证据：`src/storage/kv_engine/engine_composite.h#KVEngineComposite::ApplySgdUpdateFlat`、`src/optimizer/sparse_tensor.h#MakeTensorTag`。
8. [源码事实] DRAM 水位的预留是原子的，但"满了落 SSD"仍取决于分配器行为。`TryAllocDram` 先分配、再按实际槽容量做 compare-exchange 预留，超水位就 `Free` 回退并返回 `kValueHandleNone`；CLOCK 的 `TryDram` 用同一水位判定，超限直接不进 DRAM。可默认分配器 `ConcurrentSlabMemoryPool` 在池耗尽时 `LOG(FATAL)` 而不是返回 nullptr，所以"DRAM 满了落 SSD"在默认分配器下仍不能兜底。证据：`src/storage/value_store/hybrid_value_store.h#HybridValueStore::TryAllocDram`、`src/storage/value_store/tiered_clock_value_store.h#TieredClockValueStore::TryDram`、`src/memory/allocators/concurrent_slab_memory_pool.h#ConcurrentSlabMemoryPool::AcquireChunk`。
9. [源码事实] `page_id_offset` 在两条 SSD 路径语义不同。plain 值路径从不调 `AllocatePage`，且 `IoUringBackend::init` 会用文件大小覆盖 `next_page_id`；静态布局路径则显式把 `base_offset_bytes/PAGE_SIZE` 加到页号。同一字段一边近乎无效、一边生效，容易配错。两条路径的并发度也不同：静态布局只有 64 条页锁 stripe，写一次要更新所有副本（MaxEmbed）；plain SSD 有 2048 条 stripe，但每个小写都要整页读改写。两者都不做 compaction，删除只释放槽位（静态布局甚至 `Free` 空实现）。证据：`src/storage/io_backend/io_backend.h#IOBackend::AllocatePage`、`src/storage/io_backend/iouring/io_uring_backend.cpp#IoUringBackend::init`、`src/storage/value_store/ssd_static_layout_value_store.h#SsdStaticLayoutValueStore::ReadRawPage`。
10. [源码事实] PetKV 要求 `Put` 长度精确等于 `value_size`，但没有运行时校验。`PersistMemoryPool<true>` 只注册了一个 slab，`New(log_size)` 把请求长度当 slab key 去查 `size_to_chunks_`；长度不一致时查到/插入的是空指针，实际是崩溃而不是报错（Debug 构建才有 `CHECK` 拦一下）。对比 `KVEngineFasterKV::Put` / HPS 都会显式抛 `invalid_argument`。证据：`src/storage/nvm/pet_kv/pet_kv.cc#PetKV::Update`、`src/memory/allocators/persist_loop_slab_allocator.h#PersistMemoryPool::New`。
11. [源码事实] `MinEpochTable` 的线程槽永不回收。`ReclaimOldEntries()` 是空函数，`ReserveEntry` 在 128 个槽全占后 2 秒 `LOG(FATAL)`；任何线程频繁创建/销毁并触碰 `ShmEpochRecycle` 都会耗尽。证据：`src/memory/epoch_manager.h#MinEpochTable::ReclaimOldEntries`。
12. [源码事实] tiered 的 `dram_allocator.path` 实际必填。`HybridValueStore` 用 `BuildDramConfig` 构造 DRAM 子 store：只有 `dram_allocator.path` 存在时才把它复制到 `value.path`；文档称该字段"可选"，但 `DramValueStore` 会因 `value.path` 为空直接抛异常，所以不写就构造失败。证据：`src/storage/value_store/hybrid_value_store.h#HybridValueStore::BuildDramConfig`、`src/storage/value_store/dram_value_store.h#DramValueStore::DramValueStore`。
13. [源码事实] 文档、注释与代码不一致。`base_kv.h` 顶部注释称 `KVEngineComposite` 会拒绝遗留的顶层 `path`/`index_type`/`value_type` 和嵌套 `file_path`，但构造函数只读 `index.type` 与 `value.type`，全仓也没有这段校验；`src/ps/grpc/ps_server.md` 仍在描述按 `index_type`/`value_type` 解析引擎；`docs/storage/composite_kvengine.md` 已写明四种 tiering 策略，组合表却仍把 SSD 索引 × DRAM value 标为"不推荐"、SSD 索引 × tiered 标为"需自行验证"，而代码层没有这些检查、测试是直接 skip。证据：`src/storage/kv_engine/engine_composite.h#KVEngineComposite::KVEngineComposite`、`src/storage/kv_engine/base_kv.h`（顶部配置注释）。
14. [源码事实] CLOCK 的默认参数会放大 SSD 占用与读延迟。`retain_backing_copies=true` 时晋升行在 SSD 上保留副本，SSD 容量要按"全量数据"而不是"冷却部分"规划；`clock` 模式下 `RDMABackingSize() == 0`、不提供 `DirectPtr`，RDMA 零拷贝读与依赖裸指针的调用方不可用；`clock_async_exchange` 的队列缓冲与在执行的候选占额外内存，不计入 resident 预算。证据：`src/storage/value_store/tiered_clock_value_store.h#TieredClockValueStore`（构造函数与 `ReleasePromotedBacking`）、`src/storage/value_store/hybrid_value_store.h#HybridValueStore::RDMABackingSize`。
15. [源码事实] CLOCK 的淘汰是分片内单锁的，没有跨分片平衡。晋升扫描持有分片 `mutex`，对手用 `try_lock` 抢候选；代码注释明确只做到"shard-local CLOCK"，可用受害者集中在别的分片时晋升会反复失败。证据：`src/storage/value_store/tiered_clock_value_store.h#TieredClockValueStore::Promote`。
16. [待验证] SPDK 后端在目标机器上的实际可用性与 `queue_cnt` 语义未验证（未构建、未运行）；`GPUCacheWithNoHash` 的 `start != 0` 场景未确认（kernel 直接按 key 索引，构造只检查 `end - start == capacity`）；`PAGE_SIZE` 没有在仓库内定义，来自 Linux 系统头（`<sys/user.h>`），移植性未验证；`completion_poll_spins` 的最优值与 CLOCK 的晋升/回写开销都只有上游单机基准，未在本机复现。
17. [源码事实] `online_admission` 把读路径换成全拷贝，一批快路接口直接失效。`BatchGetDirectFixedRows`、`BulkLoadIndexedFloatRange`、`BatchGetFlatRangeImpl`、带 `update_offset`/`update_dim` 的 flat 更新都返回 `false`；`BatchGetFlat` 不再走 `ReadFlatFixedRows`，`DirectPtr` 命中也 `memcpy`。收益对比时不能把这些接口的吞吐当成"开了 profile 之后仍然成立"。证据：`src/storage/kv_engine/engine_composite.h#KVEngineComposite::BatchGetFlat`、`#BatchGetDirectFixedRows`、`#BatchGetFlatRangeImpl`、`#ApplySgdMixedRows`。
18. [源码事实] 交换以整批世代替换为粒度，前台写一多就换不动。任一次 `Put` / `BatchPut` / `BatchDelete` / SGD / `BulkLoad` 都会使在准备的交换作废（`online_stale_jobs`），异步队列只有一个待处理批次、满 256 行后新快照被丢弃（`online_queue_drops`）；失败全部静默，只能从 `ExtraResultFields()` 的计数看出来。证据：`src/storage/kv_engine/engine_composite.h#KVEngineComposite::MaybeAdmit`、`#RunBackgroundJob`。
19. [源码事实] `dram_keys_path` 是信任输入，引擎只校验"尺寸是 8 的倍数、排序、唯一"。key 是否在容量内、是否与 `fusion_k`/`tensor_tag`/分片命名空间一致，全靠生成端（`build_tiered_dram_profile.py`）；名单行数 × 行宽超过 DRAM 水位时，第一次交换起就持续计 `online_capacity_rejects`，而名单本身不会被裁剪。证据：`src/storage/value_store/hybrid_value_store.h#HybridValueStore::HybridValueStore`、`src/storage/kv_engine/engine_composite.h#KVEngineComposite::RunBackgroundJob`、`tools/benchmarks/build_tiered_dram_profile.py#build_profile`。
20. [源码事实] 新开关没进 schema，也没进上游文档。`tools/config/recstore_config.schema.json` 的 `tiering` 是 `additionalProperties: true`，`dram_keys_path` / `online_admission` / `async_admission` 既无约束也无说明；`docs/storage/tiered_storage_foundation.md` 只有一句 "Online admission remains disabled by default"。`LocalShmParameterServer::ExtraResultFields()` 目前没有调用方，服务端统计拿不到。证据：`tools/config/recstore_config.schema.json`（`value.tiering`）、`docs/storage/tiered_storage_foundation.md`、`src/ps/local_shm/local_shm_server.h#LocalShmParameterServer::ExtraResultFields`。
21. [源码事实] `DrainBackgroundWork()` 是阻塞等待。`SaveCheckpoint` / `LoadCheckpoint` / `clear` / `ResetStats` 与 `CachePS::ExtraResultFields()` 都会等后台批次跑完；SSD 写慢或卡住时这些调用一起卡住，检查点延迟不再只取决于检查点本身。证据：`src/storage/kv_engine/engine_composite.h#KVEngineComposite::DrainBackgroundWork`、`src/ps/base/cache_ps_impl.h#CachePS::ExtraResultFields`。

## 近期已修复（5f92ba2a → 6d205e98）

| 问题 | 现在的行为 | commit |
|------|------------|--------|
| `tiering.cache_policy` 是无人读取的惰性字段，DRAM/SSD 层没有 LRU 淘汰 | 打开后是按读访问提升的 DRAM 读缓存，带 LRU 淘汰、写穿透、`Free` 失效与写屏障；默认仍关闭 | `71da4896`、`67f79aac`、`bd3faef2` |
| 读缓存参数只做强制转换，负数会变成巨值 | 四个旋钮全部校验，非法值抛 `invalid_argument` | `bd3faef2` |
| PetKV 的 checkpoint/clear 静默失败 | 显式重写，打 `ERROR` 并返回 `false`，`clear()` 不改动存储 | `2af03910` |
| CCEH 全局 `thread_local` 与 io_uring 同名符号在静态构建下冲突，测试从未编译 | 删除死变量；`test_cceh` 编入 `CCEH.cpp` 并注册 ctest，旧 `test_ssd_extendible_hash.cpp` 删除 | `6f07e3bd`、`942468d9` |
| 平铺区间读无法报告哪些行缺失 | 新增 `BatchGetFlatRangeWithMissing` 与 `MissingPositionsOutput` | `c8890dd4` |
| 静态库下工厂注册整单元被链接器丢弃 | `RecStoreForceLinkKVEngineRegistrations()` 显式保留 | `6509a273` |
| `docs/storage/` 未写明介质真实后端与读缓存参数 | 已补：匿名 mmap 的语义、读缓存参数与预算预扣 | `6e3b5734`、`3f80e5b8` |

## 本轮已修复（6d205e98 → 7c44f83da）

| 问题 | 现在的行为 | commit |
|------|------------|--------|
| tiered 只有 LRU 读缓存，DRAM/SSD 之间没有冷热交换 | 新增 `clock` 策略：按热度交换、脏行回写、可选频率准入/成本感知/后台交换，句柄在交换期间不变 | `a8c8de32`、`2af143e0`、`d7f9cd9d`、`1fac6b56` |
| SSD 批量读写按单页提交，同页重复读不合并 | 连续页段合并提交、批内与跨批页去重（只共享在飞读）、同页写补丁合并 | `01e5176f`、`c5155aaf` |
| 混合层 SGD 在 SSD 行的临时拷贝上原地改，改动丢失 | `ApplySgdMixedRows` 聚合重复 key、改完显式 `BatchWrite` 写回 | `c5155aaf` |
| DRAM 水位判断在多线程下可同时通过 | `TryAllocDram` 按实际槽容量 CAS 预留，超出即回退释放 | `c5155aaf` |
| PetHash 删除不持 chunk 锁，与迁移/探测竞争 | 删除沿探测链逐 chunk 加锁，`DeleteLocked` 在持锁下更新溢出计数 | `01af2ef7` |
| 静态布局批量读的条数上限偏小 | 单次最多 32768 条，写入按 1024 条分批 | `c5155aaf` |

## 本轮已修复（7c44f83da → f8fde5af4）

| 问题 | 现在的行为 | commit |
|------|------------|--------|
| SSD 只有读计数，写放大不可见 | `IOBackend::GetWriteStats/ResetWriteStats` 记页写与写字节，两个 SSD 值存储补 payload 字节，输出 `layout_page_writes` 等字段 | `8edd10be` |
| 静态布局批量写按行、按副本各做一次整页读改写 | 补丁按页合并后一页一次 RMW（6 行 Bandana 2 页、MaxEmbed 3 页） | `2c107b30` |
| `tiering.online_admission` 只有名单与 `PrepareExchange`，引擎从不调用 | 引擎接入二次未命中准入、同步/异步交换、世代失效、后台失败传播与 `DrainBackgroundWork` | `cb296098`、`f9d98eef` |
| 没有生成 DRAM 名单的工具，基准也不能回放文本 query log | `tools/benchmarks/build_tiered_dram_profile.py`（含 ctest 单测）、`benchmark_kv_engine --read_trace_path`、`--load_batch_keys` | `cb296098` |
| `BatchPut` 遇到第一个重复 key 就停，后面的行不校验 | 整批先校验行宽与重复 key，非法批次抛 `invalid_argument` 且不写任何一行 | `cb296098` |
