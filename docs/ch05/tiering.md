---
title: 第 7 块：分层策略（none / lru / clock / adaptive）
description: cache_policy 在构造期决定 tiered 用哪种安放策略，默认 none。
outline: [2, 3]
---

## 它是什么

`value.tiering.cache_policy` 在构造期决定 tiered 用哪种安放策略，默认 `none`；`HybridValueStore` 校验参数后可能整体换成一个 `TieredClockValueStore`，非法值抛 `std::invalid_argument`。

| 策略 | 实现 | DRAM 预算 | 会不会搬动已有行 |
|------|------|-----------|------------------|
| `none` | `HybridValueStore` 按水位一次性安放 | 全长 `capacity` | 不会 |
| `lru` | `HybridValueStore` + `TieredReadCache` | 预扣 `cache_budget_ratio`，主安放上限降到 `high_watermark * (capacity - budget)` | 只把读过的 SSD 行提升进缓存 |
| `clock` | 整体换成 `TieredClockValueStore` | 共享 `high_watermark * capacity` 全长 | DRAM 与 SSD 按热度双向交换，脏行先回写 |
| `adaptive` | 构造期在以上三者中选一个 | 由 `expected_dram_bytes` 估算 | 同被选中的策略 |

`lru` 的机制分两半。结构与淘汰：按 SSD 子层 handle 分片，每分片一把 `mutex`、一条 LRU 链、一个字节上限；命中时在同一把锁下 `memcpy` 拷出，淘汰同一槽也要这把锁。每分片上限 = 生效预算 / 分片数；分片满时先淘汰 LRU 再分配，单个 value 大于分片上限时放弃提升。一致性与准入：读 SSD 前取 per-key token，`Promote` 校验 token 仍是该 key 的当前值；写、`BatchWrite`、`Free` 都会 bump token，`WriteThrough` 先 bump 再更新副本（值变短时不会暴露旧尾巴），`Invalidate` 在 `Free` 时清掉准入计数。准入计数与 token 都是每分片 1024 项直映射表，冲突只漏一次提升（保守），不会留下陈旧副本。

`clock` 把安放本身变成可纠正的：句柄是"元数据槽号 + 世代"，交换期间不变；SSD 行达到 `promote_min_misses` 次成功读后尝试复用同分片中较冷 DRAM 行的槽位，每次最多检查 64 个候选（分片内 CLOCK 环，`try_lock` 抢不到的跳过）。候选被淘汰时，需要回写的才写：初始安放在 DRAM 或已被修改的行先写 SSD 再复用槽位，已有有效 SSD 副本的直接复用；回写失败保留原安放。三个可选开关改变选谁：

- `retain_backing_copies`（默认 `true`）：晋升后保留 SSD 副本，之后淘汰不必重写；设为 `false` 时晋升即释放 SSD 槽，只有 plain SSD 布局允许（静态布局下构造直接抛错），以后每次淘汰都要再写一遍。
- `clock_cost_aware`（默认 `false`）：热度相同时优先淘汰"已有有效 SSD 副本、不必回写"的行——不会为省一次写而牺牲更热的数据。
- `clock_frequency_admission`（默认 `false`）：两层的访问频率按同一衰减周期比较，候选要有明确频率优势（至少高出 1/4）才交换；开启后 SSD 行也累计热度，否则只比较 DRAM 侧的二次机会位与局部热度。

`clock_async_exchange`（默认 `false`）把候选放进有界队列交给后台线程执行交换与回写，前台只做入队；队列按条目数（`clock_exchange_queue_entries`，默认 256）和字节数（`clock_exchange_queue_bytes`，默认 4 MiB）双上限，队列满、锁忙或 handle 版本已变时放弃本次晋升，后续访问可重试。缓冲区不计入驻留预算，但确实多占内存。

读保护在 CLOCK 下换了形态：读者先发布一个 hazard 再检查 `readable`，写、释放、淘汰先撤销 `readable` 再等待相关读者退出，所以热路径上没有共享读锁；批量读每 64 行发布一次快照，`ReadFlatFixedRows` 与 `BatchRead` 都按这个节奏拷贝。代价是 CLOCK 模式不提供 `DirectPtr` 行地址，也不提供 RDMA backing region。

`adaptive` 只看一个输入：`expected_dram_bytes` 是完整工作集经分配器档位取整后的 value 字节数，`0` 表示未知。工作集不超过 `high_watermark * capacity` 时连缓存都不开（走 `none`，读仍可直接给指针）；溢出量不超过估计工作集的 0.1% 时用 `lru`，保留量按溢出量折算成比例后预扣；其余情况（包括未知）用 `clock`。

`tiering.dram_keys_path` 是另一条与策略正交的入口：读一个排序去重、原生字节序的二进制 `uint64` 数组作为初始 DRAM 名单，用于"按历史热度先摆对位置"。名单只在带 key 的分配里生效（`AllocAndWrite(key, ...)` 与 `BatchAllocAndWrite(keys, ...)`），不带 key 的 `Alloc` 一律落 SSD；它和 CLOCK 互斥（构造抛错）。

`tiering.online_admission=true` 让这份名单在运行期可改写，代价是一整套前置条件与一层全局读写门禁：

| 条件 | 不满足时 |
|------|----------|
| `dram_keys_path` 非空，且 `cache_policy` 不是 `clock` | `HybridValueStore` 构造抛 `invalid_argument` |
| SSD 子层是 `plain` 布局（静态布局不支持） | 同上 |
| `default_value_size_hint` 非 0 且是 `sizeof(float)` 的整数倍 | `KVEngineComposite` 构造抛错 |
| 优化器是 `SGD` | `CachePS` 构造抛错：在线交换只对定长 float 行的 SGD 成立 |
| `async_admission` 只在 `online_admission` 之上打开 | `KVEngineComposite` 构造抛错 |

准入判据是"二次未命中"：某 key 第一次以冷行身份被读到时只进 ghost 集（FIFO，容量 `max(名单行数 / 20, 1)`），第二次命中才把值拷成快照去换一个 DRAM 位。每批最多准入 `min(256, 16 × ceil(请求行数 / 500))` 行，所以 LOCAL_SHM 把多个 500 行窗口合成一次大请求时不会退化成 16 行上限。交换是双向的：沿 `online_residents_` 游标找仍驻 DRAM 的受害者，受害者写 SSD、热点写 DRAM，两侧新句柄都备好后一次 `Index::BatchPutWithOld` 发布，再 `Retire` 旧句柄、让名单槽位指向新热点。

一致性靠一把 `generation` 计数器：任何前台写（`Put` / `BatchPut` / `BatchDelete` / `ApplySgdUpdateFlat` / `BulkLoad` / 检查点加载 / `clear`）先取 `online_mu_` 独占锁再自增它，正在准备的交换发现世代变了就整批放弃（计 `online_stale_jobs`）。同步路径在发布前逐个复核源句柄未被替换；异步路径下前台只把值快照拷走，后台线程做 `PrepareExchange`（私有目的槽）再发布，失败时释放刚分配的句柄并原样抛错。

`async_admission` 只有**一个**待处理批次和一个工作线程：新快照并进待处理批次（同 key 去重，满 256 行计 `online_queue_drops`），后台失败会存下异常并置停止位，之后任一前台调用或 `DrainBackgroundWork()` 重新抛出。`SaveCheckpoint` / `LoadCheckpoint` / `clear` / `ResetStats` 与基准收尾都先排空后台，保证检查点和统计看到的是静止状态。

## 它为什么存在

`none` 和 `lru` 下介质由写入顺序决定，DRAM 层留下的是"先写进来的"行，与访问热度无关——训练里初始化写序和真实访问分布几乎不相关。`lru` 只补读侧热度且不动初始安放；`clock` 连已经放错的行也换回来，代价是每次命中都要查元数据、拿到的是拷贝而不是裸指针。`adaptive` 存在的理由是"少估一点就别付迁移成本"：工作集能装下时 CLOCK 的元数据纯属浪费。

## 它和谁接

`lru` 只挂在 `HybridValueStore` 的 `Read` / `BatchRead` 上，`Write` / `BatchWrite` 同步写穿透，`Free` 让该 key 失效；`DirectPtr` 对 SSD 句柄仍返回 `nullptr`。`clock` 替换了整个值存储：引擎的 `Get` / `BatchGetFlat` / `ApplySgdUpdateFlat` / 检查点仍走同一套 `ValueStore` 接口，但 `RDMABackingSize() == 0`，RDMA 的零拷贝读路径在 CLOCK 下不可用。三种模式的统计都出现在 `ExtraResultFields()`：`tiered_cache_*` 一组，CLOCK 另有 `tiered_clock_*`（晋升、降级、回写、拒绝、交换队列的水位与峰值），online admission 另有 `online_*`（晋升行数、交换批数、容量拒绝、提交/过期/丢弃的作业、ghost 规模）。引擎自己在更外层再加 `tier_{sgd_read,sgd_write,migration_read,migration_prepare,migration_publish}_{ns,max_ns,calls}` 五组计时；`CachePS::ExtraResultFields()` 与 `LocalShmParameterServer::ExtraResultFields()` 会先 `DrainBackgroundWork()` 再取数，后者目前还没有调用方。

## 代码位置

- `src/storage/value_store/hybrid_value_store.h#HybridValueStore::HybridValueStore` — 策略解析、参数校验、`adaptive` 选择、CLOCK 构造。
- `src/storage/cache/tiered_read_cache.h#TieredReadCache`、`#WriteBarrier`、`#Promote`、`#WriteThrough`、`#Invalidate`、`#EffectiveBudgetBytes` — `lru` 的结构、一致性与生效预算。
- `src/storage/value_store/tiered_clock_value_store.h#TieredClockValueStore`、`#TieredClockValueStore::Promote`、`#TieredClockValueStore::ReadFlatFixedRows` — CLOCK 的句柄、候选扫描、回写与按批读保护。
- `src/storage/value_store/hybrid_value_store.h#HybridValueStore::PrepareExchange`、`#HybridValueStore::ExchangeDramKeys`、`#HybridValueStore::KeyUsesDram` — `online_admission` 下的名单改写与准入判定。
- `src/storage/kv_engine/engine_composite.h#KVEngineComposite::MaybeAdmit`、`#KVEngineComposite::RunBackgroundJob`、`#KVEngineComposite::BackgroundLoop`、`#KVEngineComposite::DrainBackgroundWork` — ghost 准入、同步/异步交换、后台失败传播。
- `tools/benchmarks/build_tiered_dram_profile.py#build_profile` — 从历史稀疏窗口生成 `dram_keys.bin`（frequency / density，contiguous / fused）。

## 交付一句

第 7 块到此为止，读者应当知道四种策略各自的预算来源与迁移代价，以及打开 `clock` 会失去零拷贝读。[第 8 块](./ssd-nvm)接它下面的页与共享内存。
