---
title: 第 3 块：值存储
description: 值存储把句柄翻成字节，四种基础实现共用一套接口，差别只有三处。
outline: [2, 3]
---

## 它是什么

值存储把句柄翻成字节。四种基础实现共用一套接口，差别只有三处：字节在哪种介质、句柄怎么解释、长度从哪里读；第五种是 tiered 在 `clock` 策略下换上的整体替身。

| 实现（必填字段） | 句柄解释 | 长度来源 | 写语义 |
|------------------|----------|----------|--------|
| `DramValueStore`（`value.path`、`dram_allocator`） | 分配器 offset 编码 | `SlotCapacity`（分配器给的块大小） | 每次 `Alloc` 新槽 |
| `SsdValueStore`（`value.path`、`ssd_allocator` 含 `io`） | 块号 + 块内槽号 | slot 头 4 字节 | 整页读改写 |
| `SsdStaticLayoutValueStore`（`ssd_layout.mapping_path`、`default_value_size_hint`） | `key + 1`（`0` 表示缺失） | artifact 的 `row_size` | 只改已有页槽 |
| `HybridValueStore`（`dram_allocator` + `ssd_allocator`） | 最高位标记介质，低 63 位是子层句柄 | 转交子层 | 按 `Alloc` 时的介质决定 |
| `TieredClockValueStore`（由 `HybridValueStore` 在 `cache_policy=clock` 时构造） | 元数据槽号 + 世代，交换期间不变 | 元数据里的 `size` | 命中 DRAM 原地写，SSD 行改后回写 |

`HybridValueStore`（配置名 `TIERED_VALUE_STORE`）在 `Alloc` 时一次性决定介质：`(dram_bytes_reserved_ + size) / dram_placement_bytes_` 不超过 `high_watermark_ratio`（默认 0.85）就放 DRAM，否则放 SSD。`dram_placement_bytes_` 平时等于 DRAM 的 `capacity_bytes`；打开 LRU 读缓存时它会被减去预算（见第 7 块）。SSD 句柄打上 `kSsdFlag = 1 << 63`，其余位原样保存子层句柄；`DirectPtr` 对 SSD 句柄一律返回 `nullptr`，即使该值正被读缓存持有。

`cache_policy=clock` 时 `HybridValueStore` 不再按句柄最高位分流，而是把全部调用交给 `TieredClockValueStore`：后者自己持有 DRAM 槽与 SSD 行，用"槽号 + 世代"作为逻辑句柄，冷热交换不改变句柄。因此 CLOCK 模式下没有可按介质判定的句柄位，也不提供 `DirectPtr` 与 RDMA backing region，读一律走复制路径。

## 它为什么存在

介质是配置项，不是代码分支。让四种实现共用"分配 / 写入 / 读取 / 取容量 / 释放"这组动作，上层就不必知道自己连的是 DRAM 还是块设备；tiered 再把两种介质放进同一份配置里。默认（`none`）和 LRU 模式下介质一旦选定就不再搬动；CLOCK 把"放错介质"变成可在线纠正：按访问热度交换，代价是每次读都要经过元数据而不是裸指针。

## 它和谁接

向上被引擎的读、写、检查点路径调用；向下要求分配器提供"分配 / 释放 / 取大小 / 取底层区域"。`RDMABackingData()` 只透出 DRAM 子层的连续区域，SSD 子层没有 backing region；CLOCK 模式下 `RDMABackingSize()` 直接返回 0。平铺快路要求 `GetLayoutId().plain()`（见第 5 块）；CLOCK 自己实现 `ReadFlatFixedRows` 与 `BatchRead`，所以平铺读在 CLOCK 下仍然可用，只是要按行拷贝。

## 代码位置

- `src/storage/value_store/value_store.h#ValueStore` — `Alloc`/`Write`/`Read`/`Retire`/`DirectPtr` 的公共形状。
- `src/storage/value_store/dram_value_store.h#DramValueStore::Read`、`#DramValueStore::SlotCapacity` — 槽容量即返回长度。
- `src/storage/value_store/ssd_value_store.h#SsdValueStore`、`src/storage/value_store/ssd_static_layout_value_store.h#SsdStaticLayoutValueStore` — 块号+槽号与长度头、定长布局与页锁。
- `src/storage/value_store/hybrid_value_store.h#HybridValueStore::Alloc`、`#HybridValueStore::ShouldUseDram`、`#HybridValueStore::kSsdFlag` — 介质选择与 handle 最高位。
- `src/storage/value_store/tiered_clock_value_store.h#TieredClockValueStore`、`#TieredClockValueStore::Promote`、`#TieredClockValueStore::FreeLocked` — CLOCK 模式下的句柄、晋升与槽回收。

## 交付一句

第 3 块到此为止，读者应当知道句柄怎么解释、长度谁说了算、tiered 在哪一步定下介质，以及 `clock` 为什么会换掉整个值存储。[第 4 块](./allocator)接这些字节的来源。
