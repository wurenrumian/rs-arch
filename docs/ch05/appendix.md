---
title: 附：配置与开关总表
description: 本章配置项、默认值、生效位置与约束的汇总表。
outline: [2, 3]
---

| 配置项 | 默认值 | 生效位置 | 说明 |
|--------|--------|----------|------|
| `engine_type` | `KVEngineComposite` | `engine_selector.h#ResolveEngine` | 白名单校验；出现 `external_engine_type` 直接抛错 |
| `capacity` | 无（必填） | `DramPetHashIndex` 构造、Python 侧算容量 | PetHash 的 90% 装载上限据此推导 |
| `index.type` / `value.type` | 无（必填） | `engine_composite.h` 工厂查表 | 见第 2、3 块两张表 |
| `value.default_value_size_hint` | `0`（`BulkLoad` 为 0 时 FATAL） | `KVEngineComposite` 构造 + 平铺快路径判定 | 必须等于行字节数才能走 flat 快路径 |
| `value.path` | 无 | DRAM / SSD / 静态布局 | DRAM 时只作标签（匿名 mmap）；SSD 时是真实文件 |
| `value.dram_allocator.type` / `capacity_bytes` | `R2_SLAB` / 无（必填） | `DramValueStore` 构造 | `allocator_factory.h#NormalizeAllocatorConfig` 的另一套默认是 `PERSIST_LOOP_SLAB`；池耗尽行为随实现不同 |
| `value.dram_allocator.size_classes` | `{40,72,88,136,280,520,1032}`（8 字节头 + 池默认档） | `ConcurrentSlabMemoryPoolSized` | 只有 sized 工厂接受，其他分配器配它会抛异常 |
| `value.ssd_allocator.type` / `capacity_bytes` | `SSD_SLAB` / 无（必填） | `SsdValueStore` 构造 | 另一选项 `SSD_BUDDY`；slab 按 64 MiB 切块 |
| `value.ssd_allocator.size_classes` | `{128,256,512,1024,4096}` | `SsdSlabAllocator` | 超出最大 class 抛异常 |
| `value.ssd_allocator.min_block_size` / `max_block_size` | `128` / `4096` | `SsdBuddyAllocator` | buddy 层数由两者推导 |
| `value.ssd_allocator.base_offset_bytes` | `0` | slab/buddy 块起始地址；静态布局另加页号 | 静态布局要求页对齐 |
| `*.io.type` / `*.io.queue_depth` / `*.io.base_offset_bytes` | `IOURING` / `512` / `0` | `SsdValueStore`、静态布局、SSD 索引 | 另一选项 `SPDK`；深度决定在途窗口；`base_offset_bytes` 映射为 `page_id_offset`，静态布局显式加页号，plain 值路径基本无效 |
| `*.io.completion_poll_spins` | `8192` | `IoUringBackend` 构造 | 完成收割的自旋次数，∈ [0, 1e6]；`0` 表示不忙轮询、直接阻塞等待 |
| `value.tiering.high_watermark_ratio` | `0.85` | `HybridValueStore::ShouldUseDram`、CLOCK 的 DRAM 上限 | `none` / `lru` 只影响分配时的介质选择；`clock` 用它算可驻留总量 |
| `value.tiering.cache_policy` | `none` | `HybridValueStore` 构造 | `lru` / `clock` / `adaptive`（大小写不敏感），其他值抛异常 |
| `value.tiering.cache_budget_ratio` | `0.05` | LRU 预算预扣（`adaptive` 会改写） | 仅 `lru` 使用，∈ (0, 1]；`clock` 不预扣 |
| `value.tiering.cache_shards` / `promote_min_misses` | `16` / `2` | 缓存与 CLOCK 分片、晋升门槛 | 分片数 ∈ [1, 4096]；成功读次数达到门槛才尝试晋升，≥ 1 |
| `value.tiering.expected_dram_bytes` | `0` | `adaptive` 策略选择 | 完整工作集的 value 字节数，`0` 为未知；≤ 水位时不开缓存 |
| `value.tiering.retain_backing_copies` | `true` | CLOCK 晋升后是否保留 SSD 副本 | `false` 仅允许 plain SSD 布局，之后每次淘汰都要重写 |
| `value.tiering.clock_frequency_admission` / `clock_cost_aware` / `clock_async_exchange` | `false` / `false` / `false` | CLOCK 的准入、淘汰与交换方式 | 频率准入要求明确优势；成本感知优先淘汰无需回写的行；异步交换走有界队列 |
| `value.tiering.clock_exchange_queue_entries` / `clock_exchange_queue_bytes` | `256` / `4194304` | 异步交换队列上限 | 两个都必须为正，包含在执行中的候选 |
| `value.tiering.dram_keys_path` | 无 | `HybridValueStore` 构造 | 排序去重、原生字节序的二进制 `uint64` 名单；与 `clock` 互斥；只在带 key 的分配里生效 |
| `value.tiering.online_admission` | `false` | 引擎准入与交换（`MaybeAdmit`） | 要求 `dram_keys_path` 非空、plain SSD 布局、定长 float 行、SGD 优化器；打开后读路径全拷贝 |
| `value.tiering.async_admission` | `false` | 后台交换线程 | 只在 `online_admission` 之上生效；单批次 + 单工作线程，失败延迟到前台抛出 |
| `value.ssd_layout.strategy` | `plain`（tiered 选子层时）/ 必填（直接构造静态 store 时） | `HybridValueStore::SsdStoreType` | `bandana` / `maxembed` / `plain` |
| `value.ssd_layout.mapping_path` | 无（必填） | `SsdStaticLayoutValueStore` | artifact 路径 |
| PetKV `shard_num` / `value_size` / `value_capacity` | `16` / 必填 / 必填 | `KVEnginePetKV` 构造 | 每 shard 至少 2 MiB value 区；`value_size` 决定 slab 与 `pre_known_value_size` |
| `FLAGS_shm_malloc_healthy_rate` | `0.95` | `PersistLoopShmMalloc::Healthy` | `fast_malloc` 可关 |
| `FLAGS_prefetch_method` | `0` | `KVEnginePetKV::BatchGet` | `0` 逐 key，`1` 批量预取 |
| `cache_policy` | `LRU` | `storage::cache::CreateCachePolicy` | 只被 `test_storage_cache_lru` 调用，与读缓存无关 |
