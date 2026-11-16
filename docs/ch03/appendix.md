---
title: 附：本章文件索引
description: 本章涉及的文件路径、角色与关键符号汇总表。
outline: [2, 3]
---

| 路径 | 角色 | 关键符号 |
| --- | --- | --- |
| `src/ps/base/base_client.h` | 客户端抽象、table 配置、行 gather/scatter | `BasePSClient`、`EmbeddingTableConfig`、`IsFloatEmbeddingValues` |
| `src/ps/base/base_ps_server.h` | 服务端抽象 | `BaseParameterServer::Init/Run` |
| `src/ps/base/shard_client.h` | 单分片客户端契约 | `ShardClient`、prefetch 四件套 |
| `src/ps/base/shard_endpoint.h` | 单分片监听地址解析 | `SelectSingleShardEndpoint` |
| `src/ps/base/dist_sharded_client.h` | 路由、拆分、并发 fan-out、合并、prefetch 状态机 | `DistributedShardedClient<ClientT>` |
| `src/ps/base/cache_ps_impl.h` | 传输无关的 PS 核心：表、优化器、checkpoint 状态 | `CachePS`、`SparseGradientCommit`、`GetParameterFlat` |
| `src/ps/base/parameters.h/.cpp` | wire 格式 | `ParameterCompressItem`、`ParameterPack`、`ParameterCompressor` |
| `src/ps/base/sparse_gradient_commit.h` | 稀疏提交协议与去重 | `SparseGradientCommitHeader`、`SparseGradientCommitCoordinator` |
| `src/ps/base/shard_manager.h` | 遗留 key→server 划分（仅加载路径使用） | `ShardManager::KeyPartition` |
| `src/ps/base/Postoffice.*` | 进程角色/编号（server/client） | `XPostoffice` |
| `src/ps/base/config.*` | PS 级 gflag | `value_size`、`max_kv_num_per_request` |
| `src/ps/client_factory.*`、`client_options.h` | 传输选型 | `PSClientType`、`CreatePSClient` |
| `src/ps/proto/ps.proto` | gRPC 协议 | `ParameterService`、`PSCommand` |
| `src/ps/proto/ps_brpc.proto` | bRPC 协议（`cc_generic_services`） | `recstoreps_brpc::PSCommand` |
| `src/ps/grpc/grpc_ps_client.*` | 单分片 gRPC 客户端 | `GRPCParameterClient`、`PrefetchBatch` |
| `src/ps/grpc/dist_grpc_ps_client.*` | gRPC 分片客户端 | `DistributedGRPCParameterClient` |
| `src/ps/grpc/grpc_ps_server.*` | gRPC 服务与进程入口 | `ParameterServiceImpl`、`GRPCParameterServer` |
| `src/ps/grpc/grpc_ps_bench.cpp` | Load/Dump 假数据带宽基准 | `RunBench` |
| `src/ps/brpc/brpc_ps_client.*` | 单分片 bRPC 客户端 | `BRPCParameterClient`、`MAX_PARAMETER_BATCH_BRPC` |
| `src/ps/brpc/dist_brpc_ps_client.*` | bRPC 分片客户端 | `DistributedBRPCParameterClient` |
| `src/ps/brpc/brpc_ps_server.*` | bRPC 服务与进程入口 | `BRPCParameterServiceImpl` |
| `src/ps/local_shm/local_shm_layout.h` | 共享内存区布局 | `TotalRegionBytes`、`SlotPayloadOffset` |
| `src/ps/local_shm/local_shm_protocol.h` | 控制块/槽位/状态码 | `LocalShmSlotHeader`、`LocalOpcode` |
| `src/ps/local_shm/local_shm_queue.*` | 有界 MPMC 队列 | `LocalShmQueueEnqueue/Dequeue` |
| `src/ps/local_shm/local_shm_futex.*` | Linux futex 等待/唤醒 | `FutexWaitUntilValueChange` |
| `src/ps/local_shm/local_shm_region.*` | shm 创建/挂接/校验 | `LocalShmRegion` |
| `src/ps/local_shm/local_shm_client.*` | 共享内存客户端 | `LocalShmPSClient`、`LocalShmFlatGetHandle` |
| `src/ps/local_shm/local_shm_server.*` | 共享内存服务端 worker | `LocalShmStoreRuntime`、`LocalShmParameterServer` |
| `src/ps/base/cache_ps_impl.h#CachePS::ExtraResultFields`、`src/ps/local_shm/local_shm_server.h#LocalShmParameterServer::ExtraResultFields` | 把引擎统计透给进程内调用方 | 取数前先 `DrainBackgroundWork()`；服务端这层目前没有调用方 |
| `src/ps/local_shm/local_shm_stage_report.h` | 分阶段指标上报 | `ReportLocalShmStageMetric` |
| `src/ps/ps_server.cpp` | 统一服务端入口（仅 GRPC/BRPC） | `ps_type` → factory key |
