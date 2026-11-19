---
title: 代码索引
description: RecStore 仓库目录与本站章节的对照表——想改哪里，直接跳到对应块。
outline: [2]
---

# 代码索引

这份表解决一个具体问题：你手上有个改动，不知道从哪读起。左列是仓库里的位置，
右列是讲它的那一块。路径相对仓库根目录，符号用 `#` 分隔。

这页是查表用的，不是用来读的：按目录扫，找到你的改动落在哪一格，再跳过去。

::: tip 这里没有代码副本
本站不 vendor RecStore，也不拉 `third_party` 子模块——仓库里只有文档。
需要跳过去看源码时，用上游 [RecStore/RecStore](https://github.com/RecStore/RecStore)，
版本对得上 `a1cfcc81f` 即可。
:::

## 一次读写的四个落点

想按调用顺序走完整条路，用[第 07 章 · 代码导读](/ch07/)：它从训练侧的 forward 开始，一直跟到引擎里的 `BatchGetFlat` 与 `ApplySgdUpdateFlat`。下面是四个最常打开的落点：

| 位置 | 是什么 | 在哪读 |
|---|---|---|
| `src/python/pytorch/recstore/KVClient.py` | Python 侧门面：`init`, `emb_read`, `emb_update_table`, 两种更新语义的守卫 | [02 · 客户端与分片](/ch02/client-shard) |
| `src/framework/pytorch/op_torch.cc` | `TORCH_LIBRARY(recstore_ops, m)` 注册，张量校验与借用视图 | [02 · op 入口](/ch02/op-entry) |
| `src/ps/client_factory.cc` | `CreatePSClient`：按 `ps_type` 造客户端，RDMA 与 local_shm 的分支在这里 | [03 · 客户端栈与选型](/ch03/client-stack) |
| `src/ps/base/cache_ps_impl.h` | 服务端 `CachePS`：接请求、做学习率校验、调优化器与 KV 引擎 | [03 · 请求形状](/ch03/request-shape) |

## 顶层目录

| 路径 | 是什么 | 在哪读 |
|---|---|---|
| `src/` | 全部 C++ 与 Python 包源码，下面按模块再拆 | [01 · 仓库地图](/ch01/repo-map) |
| `model_zoo/`、`examples/` | 可运行样例：`criteo_kaggle/`、`rs_demo/`、`torchrec_dlrm/` | [06 · 训练接入](/ch06/training-integration) |
| `tools/` | 基准 runner、注册式性能套件 `perf/`、配置 schema、CI 与打包 | [06 · 基准地图](/ch06/benchmark-map) |
| `third_party/` | 15 个 git submodule 加脚本生成的安装前缀（本站不拉取） | [01 · 构建与打包](/ch01/build) |
| `docs/`、`mkdocs.yml` | 上游自己的 mkdocs 文档站 | [06 · 工程工具](/ch06/tooling) |
| `CMakeLists.txt`、`VERSION`、`pyproject.toml` | 构建入口；`VERSION` 是版本唯一来源，CMake 与 pyproject 都读它 | [01 · 构建与打包](/ch01/build) |

## `src/` 的 12 个模块

| 路径 | 职责 | 在哪读 |
|---|---|---|
| `src/base` | 与框架无关的基础设施：日志、JSON、Tensor 视图、工厂、hash、位图、线程与计时 | [01 · 仓库地图](/ch01/repo-map) |
| `src/framework` | 框架无关 op 运行时 + PyTorch 绑定 + GPU cache 适配 + BagPipe 元数据 | [02 · op 入口](/ch02/op-entry)、[02 · BagPipe](/ch02/bagpipe) |
| `src/ps` | 参数服务器全部传输与协议：`base/`、`proto/`、`grpc/`、`brpc/`、`rdma/`、`local_shm/` | [03](/ch03/)、[04](/ch04/) |
| `src/storage` | KV 引擎、索引、值存储、分层读缓存、SSD/NVM、GPU cache kernel | [05](/ch05/) |
| `src/memory` | 共享内存文件、epoch 回收、DRAM 分配器实现 | [05 · 分配器](/ch05/allocator) |
| `src/optimizer` | 服务端稀疏优化器与 key tag 键空间 | [03 · 请求形状](/ch03/request-shape) |
| `src/python` | Python 包源码与 CMake 版本模板 | [02 · 客户端与分片](/ch02/client-shard) |
| `src/benchmark` | C++ 基准二进制：`ps/`、`storage/`、`mixed/`、`dataset/` | [06 · 基准地图](/ch06/benchmark-map) |
| `src/test` | C++ / Python 测试与配置样本 | [06 · 测试地图](/ch06/test-map) |
| `src/executable` | 独立可执行与实验入口，只有 `executable/uvm` 有 CMake 入口 | [01 · 仓库地图](/ch01/repo-map) |
| `src/gpu_memory` | GDRCopy 与设备显存映射工具，未接入构建 | [05 · GPU 侧存储](/ch05/gpu) |
| `src/optimization` | 只有头文件 `bagpipe/cache_metadata.h`，被 framework 包含 | [02 · BagPipe](/ch02/bagpipe) |

## `src/ps` 与 `src/storage` 再往下

| 路径 | 是什么 | 在哪读 |
|---|---|---|
| `src/ps/base` | `BasePSClient`、`CachePS`、单分片监听端点解析 `shard_endpoint.h` | [03 · 分片与路由](/ch03/sharding) |
| `src/ps/proto` | gRPC 与 bRPC 两份 `.proto`，命令枚举差异在这里 | [03 · 协议与命令](/ch03/protocol) |
| `src/ps/rdma` | 槽位协议、lane、内存注册与重建 | [04](/ch04/) |
| `src/ps/local_shm` | POSIX 共享内存环形队列与槽位头 | [03 · local_shm 路径](/ch03/local-shm) |
| `src/storage/kv_engine` | `base_kv.h`、`engine_composite.h`、`engine_petkv.h`、`engine_factory.h` | [05 · 组合矩阵](/ch05/composite-matrix) |
| `src/storage/index` | DRAM PetHash、Extendible Hash、SSD 侧索引 | [05 · 索引](/ch05/index-engine) |
| `src/storage/value_store` | DRAM / SSD / tiered 值存储，含 `tiered_clock_value_store.h` | [05 · 值存储](/ch05/value-store)、[05 · 分层策略](/ch05/tiering) |
| `src/storage/cache` | 分层读缓存 `tiered_read_cache.h` | [05 · 分层策略](/ch05/tiering) |
| `src/storage/allocator`、`src/memory/allocators` | slab 分配器与并发内存池 | [05 · 分配器](/ch05/allocator) |
| `src/storage/gpu_cache` | GPU 侧缓存 kernel 与无 hash 变体 | [05 · GPU 侧存储](/ch05/gpu) |
| `src/python/pytorch/torchrec_kv` | torchrec 适配层：融合 id、预取、行读取 | [07 · 一条读的代码路径](/ch07/read-route) |

## 只想跑起来

| 目标 | 去处 |
|---|---|
| 编出来 | [01 · 构建与打包](/ch01/build)，配置字段见 [01 · 配置与开关](/ch01/config) |
| 起一个 PS 和一次读写 | [06 · 训练接入](/ch06/training-integration)的 `rs_demo` |
| 改完确认没坏 | [06 · 改动 → 验证路径](/ch06/verification) |
| 看性能有没有变化 | [06 · 基准地图](/ch06/benchmark-map) |
