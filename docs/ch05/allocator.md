---
title: 第 4 块：分配器
description: 分配器是值存储背后的字节来源，DRAM 侧只有一套下沉接口。
outline: [2, 3]
---

## 它是什么

分配器是值存储背后的字节来源，DRAM 侧只有一套下沉接口 `MallocApi`；四个实现都经 `ShmFile` 落到 mmap，介质只有匿名私有映射与 `FS_DAX` 文件两种。它们的取舍在回收方式上：

| 分配器 | 结构 | 回收 | 备注 |
|--------|------|------|------|
| `CONCURRENT_SLAB_MEMORY_POOL`（默认） | 1 MiB chunk，8 字节头 + bitmap，按 slab class 绑定 | 每 slab 的 partial/active 队列 + 线程热块；空闲块可重绑 class | 全局空闲块耗尽直接 `LOG(FATAL)`；`size_classes` 只有带 sized 工厂的注册接受 |
| `PERSIST_LOOP_SLAB` | 8 字节 block 位图 + 每次分配 8 字节长度头 | 循环首次适应，从 `last_malloc_block_` 绕圈；fast free list（32 类 × 1M 项） | 单把 `base::Lock`；`FLAGS_shm_malloc_healthy_rate` 默认 0.95 |
| `PERSIST_MEMORY_POOL` | 2 MiB chunk，chunk 头 + bitmap | 按 chunk 归还；恢复时从 chunk 头重建占用 | 构造要求 `nr_chunks >= slab 类数` |
| `R2_SLAB` / `R2ShmMalloc` | r2 的 master + 每线程 arena | `alloc/dealloc` 交给 r2 | `GetMallocSize` 用 `je_malloc_usable_size`，长度带 padding |

介质由 `ShmFile` 决定，"共享内存"这个说法要拆开看：

| `medium` 参数 | 实际后端 | 语义 |
|---------------|----------|------|
| `"DRAM"` | `ANONY_DRAM` | `mmap(MAP_PRIVATE | MAP_ANONYMOUS)`；`filename` 只用于日志 |
| `"SSD"` | `FS_DAX` | 真正 `open + posix_fallocate + mmap(MAP_SHARED)` 的文件 |
| 其他 | `LOG(FATAL)` | 没有 `"PM"` / `"NVM"` 分支 |

`DEV_DAX` 虽然注册了工厂，但 `ConfigForMedium` 里对应分支被注释掉，正常构造选不到它；只有直接调 `PMMmapRegisterCenter::Register` 才会走 dev-dax。另外，`ConcurrentSlabMemoryPool` 构造时会先 `PathExists` 再 `Delete` 同路径文件，`value.path` 指向真实文件会被静默清理。

对齐与 epoch 是两个附带的硬约束。默认索引和可扩展哈希的块都用 `posix_memalign(..., 64, ...)`，slab chunk 页对齐，循环分配器的 offset 必须 8 字节对齐（取 offset 时断言）。epoch 回收解决"读者还握着旧指针"：进程单例表有 128 个 64 字节对齐的槽，线程首次使用时按 `pthread_self()` 哈希占位；共享内存复刻版在回收时记录当前 epoch，每 1000 次回收推进一次，再按安全判定批量释放。表槽的回收函数是空实现，超过 128 个线程同时进入 epoch 路径会在占位时等 2 秒后终止进程。

## 它为什么存在

DRAM 那层自己管字节，是因为值存储要提供两样东西：接近零拷贝的批读取，和可被 RDMA 注册的连续区域。[推断] 通用 malloc 满足不了第二点。分层值存储又需要在同一份配置里表达两段介质，所以分配器必须能在构造期固定容量、运行期不搬动已有块。

## 它和谁接

向上给值存储提供"分配 / 释放 / 取大小 / 取底层区域"四类能力，向下落到 mmap。介质映射同时决定这块内存在进程退出后是否还在，以及 `filename` 是真实文件还是纯日志标签；SSD 侧的 slab / buddy 与页级分配是另一套接口，见第 8 块。

## 代码位置

- `src/memory/malloc.h#MallocApi`、`src/memory/allocators/concurrent_slab_memory_pool.h#ConcurrentSlabMemoryPool` — 下沉接口、默认分配器、构造删同路径文件、耗尽 FATAL。
- `src/memory/allocators/persist_loop_slab_allocator.cc#PersistLoopShmMalloc::New` — 循环首次适应。
- `src/memory/shm_file.cc#ShmFile::ConfigForMedium`、`#AnonyDramShmFile::Initialize`、`#FsDaxShmFile::Initialize` — 介质映射。
- `src/memory/epoch_manager.h#EpochManager`、`src/memory/malloc.h#ShmEpochRecycle` — epoch 与延迟回收。

## 交付一句

第 4 块到此为止，读者应当知道字节来自 mmap、配置里的"DRAM"其实是进程私有映射、退役带一个延迟窗口。[第 5 块](./read-path)接读路径，把这些层串成一次查询。
