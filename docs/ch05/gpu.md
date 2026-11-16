---
title: 第 9 块：GPU 侧存储
description: 显存侧有两套代码：设备侧数据结构与 kernel，和显存分配与主机映射。
outline: [2, 3]
---

## 它是什么

显存侧有两套代码：设备侧数据结构与 kernel，和显存分配与主机映射。前者只提供表的读写，淘汰策略不在其中。

| 组件 | 结构 | 用途/限制 |
|------|------|-----------|
| `gpu_cache_api` | 纯虚接口 | `Query`/`Replace`/`Update`/`Remove` + 只读扩展 `GetAssumingHits`/`Contains` + 调用方自管淘汰的 `TryInsertNoEvict`/`RemoveWithMask` |
| `gpu_cache`（`nv_gpu_cache`） | 组相联：`SET_ASSOCIATIVITY=2`、`SLAB_SIZE=32`、每组一把 mutex、`MurmurHash3_32` | 每 set 64 行，容量按 `capacity_in_set × 64` 行；`Query` 会等 miss 计数，`GetAssumingHits` 不加锁不 touch |
| `StaticHashTable` / `static_table` | 静态链地址：key 表 + slot 索引 + value 表 | `insert` 要求无重复且不超容量；`static_table` 只支持 `Query`/`Init`/`Clear` |
| `UvmTable` | 设备表 + 主机表两级 `HashBlock`，双缓冲 H2H 拷贝线程 | 设备 miss 时查主机表并批量拷贝；显存与主机内存各存一份 |
| `GPUCacheWithNoHash` | 一块连续 `cudaMalloc` 数组，构造要求 `end - start == capacity` | `UVAQuery` 按 `key * emb_dim` gather，隐含要求 key 从 0 起；无淘汰、无 miss |
| `PoolMemoryResource` / `FixedLengthMemoryResource` / `MappingDeviceMemory` | rmm 池/定长资源；GDRCopy `gdr_pin_buffer` + `gdr_map` | 定长资源明确"not thread safe"；映射预分配 `1024 * GPU_PAGE_SIZE`（GPU 页 64 KiB） |

`src/gpu_memory/` 没有接入构建：`src/CMakeLists.txt` 的 `add_subdirectory` 列表里没有它；`src/gpu_memory/gdrcopy/` 是 vendored 的 NVIDIA GDRCopy（含 `LICENSE`、`src/`、预编译 `libgdrapi.so.2.3`）。与[第 02 章](../ch02/)的边界：驻留决策、LRU 元数据、admission/invalidation、跨流顺序在 `src/framework/cache/gpu_embedding_cache.{h,cu}` 与 `src/python/pytorch/recstore/bagpipe_cache/` 里，本章的 `gpu_cache` 只提供设备侧表与 kernel。

## 它为什么存在

显存里的 embedding 访问是训练热路径，一次 kernel 内要按 key 直接寻址，所以表必须常驻设备并且不持锁。[推断] 设备侧不适合做淘汰判定，接口因此把"插入但不淘汰"和"带掩码删除"单独暴露出来，让上层的缓存控制器统一决策。

## 它和谁接

向上被计算层的缓存控制器调用，向下使用显存分配资源与主机映射。它不参与前八块的 key→字节路径，所以本章的读写路径结论不适用于它。

## 代码位置

- `src/storage/gpu_cache/gpu_cache_api.hpp#gpu_cache_api`、`src/storage/gpu_cache/nv_gpu_cache.hpp#gpu_cache` — 接口与组相联表。
- `src/storage/gpu_cache/static_hash_table.hpp#StaticHashTable`、`#static_table.hpp#static_table`、`#uvm_table.hpp#UvmTable`、`#gpu_cache_nohash.h#GPUCacheWithNoHash` — 表族。
- `src/gpu_memory/mapping_device_memory.cuh#MappingDeviceMemory`、`src/gpu_memory/gdrcopy/LICENSE`、`src/framework/cache/gpu_embedding_cache.cu`、`docs/architecture/bagpipe_cache.md` — 映射、vendored 来源与 BagPipe 分界。

## 交付一句

第 9 块到此为止，显存侧只提供表，不提供策略。九块走完，剩下的[配置总表](./appendix)、章节接口与风险清单可以按需查阅。
