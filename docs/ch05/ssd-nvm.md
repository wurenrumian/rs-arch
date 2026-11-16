---
title: 第 8 块：SSD 与 NVM
description: 块设备侧以页为唯一读写单位，共享内存侧是一组分片的 KV。
outline: [2, 3]
---

## 它是什么

块设备侧以页为唯一读写单位，句柄编码块号与槽号；共享内存侧是一组分片的 KV，索引、值区、有效标记各存一个文件。

## 它为什么存在

DRAM 放不下全部 embedding 时只有两条路：把冷数据放到块设备，或者把整个索引和值区放进可映射的内存镜像。前者要处理随机小写的写放大，后者要在重启后重建索引。

## 它和谁接

向上被值存储调用，向下落到页级异步 IO 或共享内存文件。页分配由同一个 IO 抽象负责，所以 SSD 索引和 SSD 值存储共享一套页号空间。

页级 IO：分配页号单调递增；单页读写一次一页；批量读写按"连续页段"合并提交，在途窗口取 `max(queue_depth / 2, 1)`，一个提交项可覆盖 `page_count` 页；缓冲区按页对齐，文件以 `O_DIRECT` 打开，因此 SSD 值路径的所有读写都是整页读改写。`IoUringBackend` 每线程一个 ring（`io_uring_queue_init(queue_cnt)`），`init()` 用文件大小推导 `next_page_id`（存在则 `size/PAGE_SIZE`，否则 1）；完成收割先自旋 `completion_poll_spins`（默认 8192，∈ [0, 1e6]），为 0 时直接阻塞等待、不忙轮询。`SpdkBackend` 是同接口的 SPDK 实现，是否可用取决于构建。`page_id_offset` 只在 `IOBackend::AllocatePage` 里作为起始页号使用；`SsdValueStore` 从不调用 `AllocatePage`，所以该字段在 plain 路径上基本无效，真正的基址偏移被 `SsdSlabAllocator` 烘进块地址。

批量路径做了三件事，代价与边界都在这一层：读先去重页——同一批里多行落在同一页只读一次，跨批次的同页请求共享仍在飞行中的那次 IO，但完成后的页不会被留下当缓存；写先把同一页上的补丁合并，长度头与载荷一起提交，且提交期间补丁缓冲必须存活；分配后写失败会把刚拿到的槽位释放回去，避免容量只出不进。跨槽的行读取会按槽边界分段，坏的 4 字节长度头不能让它越界读到相邻槽。

SSD 值存储与静态布局：`SsdSlabAllocator` 默认块大小 64 MiB（`1 << 26`），`kHeaderSize = 4`（存实际长度），默认 class `{128,256,512,1024,4096}`，每 class 一把 `mutex`，全局空闲块表一把 `mutex`，另有 2048 条页锁 stripe；写一个小 value 的代价是一次整页读 + 两次 patch（长度头 + 载荷）+ 一次整页写，同页多槽合并成一次读改写。`SsdBuddyAllocator` 用 8 字节头（`data_size` + `level`）和每层空闲集合，`SlotCapacity` 由 level 反推。`SsdValueStore::BatchRead` 一次最多 32768 条（`kMaxBatchIoEntries`），写入按 1024 条分批；单条 `Read` 也是一次批量页读。静态布局把 key 排到固定页槽，运行时只查 artifact：`Artifact` 含 `strategy`、`page_size`、`row_size`、`keys`、`copies` 与 checksum；handle 是 `key + 1`，`Alloc` 与批量分配直接抛异常、`Free` 空实现——布局固定，不能新增 key。单条读只读 primary；批量读每轮选"覆盖未完成 key 最多"的页，一页可同时满足多个 key（MaxEmbed 还能命中副本页）。写必须 `size == row_size`，并对该 key 的每个副本所在页各做一次读改写；页锁只有 64 条 stripe。

写侧现在可计量：`IOBackend` 除读计数外还维护 `page_writes` 与 `bytes_written`，各后端在自己的页写路径里记一次（批量写记整批，单页写记一页），`ResetStats` 同时清读写两侧；`SsdValueStore` 与静态布局另记 payload 字节，于是 `layout_page_writes` / `layout_bytes_written` 与 `layout_payload_bytes_{read,written}` 能直接读出写放大。静态布局的批量写也合并成"每页一次读改写"：每行（以及 MaxEmbed 的每个副本）拆成 `RowPatch`，按页号排序后逐页 `memcpy` 补丁、按页锁 stripe 锁一次、写回一页；原来是同页多行各自读改写整页。

共享内存 KV：`KVEnginePetKV` 把索引和值区都放进共享内存镜像，容量平均分给若干分片（默认 16），每片一个目录，目录下三个文件。

| 文件 | 内容 | 结构 |
|------|------|------|
| `dict` | key → `PetKVData` | `PetHash<uint64, PetKVData, true>`，大小由 `MemorySize(capacity)` 算出 |
| `value` | embedding 字节 | `PersistMemoryPool<true>`，固定 slab 等于 `value_size` |
| `valid` | 4 字节有效标记 | 仅用于判定是否需要 `Initialize` |

`PetKVData` 是 8 字节打包值：低位存过期时间，高位存 8 字节对齐后的 value offset；`DoFlush()` 对这一个 8 字节做 `clflushopt_range`。`Update` 顺序是：`PersistMemoryPool::New` → `memcpy` → `clflushopt_range` → 写 dict entry → `DoFlush` → 旧槽交给 `ShmEpochRecycle`，整条更新在 `modify_lock_` 下串行。删除现在也按 chunk 加锁：沿探测链每进入一个 chunk 取它的 `lock_`，命中后由 `DeleteLocked` 在持锁状态下递减沿途 `OverflowCount` 再删条目；遇到正在迁移的 chunk 重试整条探测。恢复时 `dict_->Valid(file_size)` 校验 `capacity_`、`chunk_num_ * 14 == capacity_`、`MemorySize` 与遍历计数一致；通过则 `Reload` 并行重建 size/overflow 链，并对每个 value 调 `shm_malloc_->AddMallocs4Recovery`（该方法只打日志 "not implement"，占用位图实际靠 chunk 头里的 bitmap 恢复）。`BatchGet` 受 gflag `prefetch_method` 控制：`0` 逐 key `Get`，`1` 走 `PetMultiKV::BatchGet`（预取下一个 key 的 shard）。刷新仍是空操作：`persistence.h#clflushopt` 首行 `return;`，`clflushopt_range` 只做 `sfence`，`PetMultiKV` 没有任何 flush/checkpoint 接口；`KVEnginePetKV` 因此显式重写 `SaveCheckpoint` / `LoadCheckpoint` / `clear()`，打 `ERROR` 说明共享内存不持久，前两者返回 `false`，`clear()` 直接不改动存储。

## 代码位置

- `src/storage/io_backend/io_backend.h#IOBackend`、`src/storage/io_backend/iouring/io_uring_backend.cpp#IoUringBackend::BatchIO`、`#IoUringBackend::BatchReadPages` — 页语义、连续页段提交、完成收割与 `completion_poll_spins`。
- `src/storage/allocator/ssd/ssd_slab_allocator.h#SsdSlabAllocator::BatchRead`、`#SsdSlabAllocator::ReadSharedPages`、`#SsdSlabAllocator::BatchWrite`、`#Free`、`#kPageLockStripes`、`src/storage/value_store/ssd_static_layout_value_store.h#SsdStaticLayoutValueStore::BatchRead`、`#LockPages`、`src/storage/ssd_layout/ssd_layout.h#Artifact` — 页去重、补丁合并、块级 tombstone、静态布局读与页锁。
- `src/storage/nvm/pet_kv/pet_kv.cc#PetKV::Update`、`#PetMultiKV`、`src/storage/nvm/pet_kv/pet_hash.h#PetHash::Delete`、`#PetHash::DeleteLocked`、`src/storage/nvm/pet_kv/persistence.h#clflushopt`、`src/storage/kv_engine/engine_petkv.h#KVEnginePetKV::SaveCheckpoint`、`#KVEnginePetKV::clear` — 共享内存写入、按 chunk 串行删除、空 flush 与显式 unsupported。

## 交付一句

第 8 块到此为止，SSD 侧的代价集中在整页读改写，PetKV 侧既不能 checkpoint 也不能 clear。[第 9 块](./gpu)接显存侧的表。
