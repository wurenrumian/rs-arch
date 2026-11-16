---
title: 附：本章文件索引
description: 本章涉及的文件、职责与关键符号索引。
outline: [2, 3]
---

| 路径 | 职责 |
| --- | --- |
| `src/framework/op.h` / `op.cc` | 框架无关的 embedding op 抽象与 `KVClientOp` 实现；`ps_type` → grpc/distributed_grpc/brpc/distributed_brpc/rdma/local_shm/hierkv |
| `src/framework/common/op_runtime_support.{h,cc}`、`ps_client_config_adapter.{h,cc}` | 配置定位（`RECSTORE_CONFIG` 或默认路径）、glog 初始化、单分片 `distributed_client` 合成、local_shm 默认 transport |
| `src/framework/common/local_shm_op_component.{h,cc}`、`local_shm_kv_client_op.cc`、`hierkv_local_runtime.{h,cc}` | local_shm flat 读/更新、借出 payload 的 submit/wait/release、lease 绑定 shared_ptr 析构；`hierkv` 的进程内 `unordered_map` 后端（显式 lr 优先，缺省 0.01） |
| `src/framework/common/owner_merged_plan.h` / `sparse_gradient_commit_runtime.h` | 双 rank、city_hash 分片的 owner 路由计划；稀疏提交异步句柄（`std::async`、ready 回调、按 committed step 轮询、60s 超时、失败 abort） |
| `src/framework/common/op_mock.cc` / `recstore.cc` | `USE_FAKE_KVCLIENT` 的内存 KV；后者是**空翻译单元**（只有 `namespace recstore {}`） |
| `src/framework/pytorch/op_torch.cc` | 唯一 `TORCH_LIBRARY` 注册点：`RegisterBaseOps` / `FlatOps` / `PrefetchOps` / `GpuCacheOps` / `SparseGradientCommitOps` / `BagpipeMetadataOps` / `ProfileOps` |
| `src/framework/pytorch/op_internal.h`、`op_cuda_runtime.{h,cu}` | Tensor ↔ `RecTensor`、pinned staging、CUDA 事件、`RetainUntilCudaComplete` |
| `src/framework/pytorch/op_base.cc` / `op_flat.cc` / `op_prefetch.cc` | `emb_read(_into)` / `emb_write` / `emb_update_table` / checkpoint；local_shm flat 快路径；prefetch 句柄 |
| `src/framework/pytorch/op_sparse_gradient_commit.cc` / `op_profile.cc` | v1 稀疏提交、v4 owner 整行替换、close/wait；thread-local profile 暴露 |
| `src/framework/cache/cache_aware_op.h`、`gpu_embedding_cache.{h,cu}` | 缓存编排 Query → read_missing → fill → scatter、低命中 bypass；GPU cache 单例（capacity 以 set 计） |
| `src/framework/pytorch/cache/tensor_adapter.cc` | `CachedReadTorch`：cache lookup 接 Torch，借出 payload → pinned `from_blob` → H2D，stream 完成后释放 lease |
| `src/framework/pytorch/cache/bagpipe_bindings.cc` | `optimization::bagpipe::CacheMetadata` → Torch 自定义类 `BagPipeCacheMetadata` |
| `src/python/pytorch/recstore/canonical_ps.py` | 特征主序 ID → 排序 key/counts/positions/table_types 的 CPU ticket（`make_ticket`，26×1024 上限） |
| `src/python/pytorch/torchrec_kv/fused_preload.py` | 把第 i 张表的行预建到 master 键空间（`register_tensor_meta` + `init_embedding_table` + `push`） |
