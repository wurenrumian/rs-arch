---
title: 证据索引
description: 本章各条结论与对应源码证据的逐条对照表。
outline: [2, 3]
---

| 结论 | 证据 |
| --- | --- |
| 工厂四种类型、`ps_type` 映射、单 shard 合成、服务端入口只接受 GRPC/BRPC | `src/ps/client_factory.cc#CreatePSClient`、`src/ps/client_options.h#PSClientType`、`src/framework/common/ps_client_config_adapter.cc#ResolveFrameworkPSClientType`、`#ResolvePSClientOptionsFromFrameworkConfig`、`src/ps/ps_server.cpp#main` |
| 单分片客户端契约与监听地址解析 | `src/ps/base/shard_client.h#ShardClient`、`src/ps/grpc/grpc_ps_client.h#GRPCParameterClient`、`src/ps/base/shard_endpoint.h#SelectSingleShardEndpoint`、`grpc_ps_server.cpp`、`brpc_ps_server.cpp` |
| 分片、切块、并发 fan-out、结果散射；`city_hash` 即 CityHash64 | `src/ps/base/dist_sharded_client.h#DistributedShardedClient::GetParameter`、`#PartitionKeys`、`#GetShardId`、`src/base/hash.h#GetHash` |
| gRPC 批大小 2000、共享 CQ、只用 stubs_[0]、deadline/状态/空 payload 判错 | `src/ps/grpc/grpc_ps_client.h#MAX_PARAMETER_BATCH`、`src/ps/grpc/grpc_ps_client.cpp#kDefaultRpcDeadlineMs`、`#GRPCParameterClient::GetParameter` |
| gRPC 预取失败记录与 30 s 空闲上限 | `src/ps/grpc/grpc_ps_client.cpp#MarkPrefetchFailed`、`#ConsumePrefetchCompletion`、`#WaitForPrefetch` |
| bRPC 批大小 65536、Arena、attachment、超时与重试默认值 | `src/ps/brpc/brpc_ps_client.h#MAX_PARAMETER_BATCH_BRPC`、`src/ps/brpc/brpc_ps_client.cpp#BRPCParameterClient::GetParameter`、`#FLAGS_brpc_timeout_ms`、`#FLAGS_brpc_max_retry` |
| bRPC checkpoint 显式 unsupported；proto 缺枚举 | `src/ps/brpc/brpc_ps_client.cpp#BRPCParameterClient::SaveCheckpoint`、`#LoadCheckpoint`、`#BRPCParameterClient::Command`、`src/ps/proto/ps_brpc.proto#PSCommand` |
| 服务端 Command 的 LOG(FATAL) 兜底与 gRPC checkpoint 校验 | `grpc_ps_server.cpp#ParameterServiceImpl::Command`、`brpc_ps_server.cpp#BRPCParameterServiceImpl::Command` |
| CachePS 的 checkpoint 身份/dirty 约束、每 shard 文件与失败汇总 | `src/ps/base/cache_ps_impl.h#CachePS::LoadCheckpoint`、`#CachePS::SaveCheckpoint`、`src/ps/base/dist_sharded_client.h#ShardCheckpointPath`、`#FanOutCheckpoint` |
| `max_batch_keys_size` 废弃告警 | `src/ps/base/cache_ps_impl.h#CachePS::CachePS` |
| 更新携带学习率、服务端校验不匹配即拒绝 | `src/ps/proto/ps.proto#UpdateParameterRequest`、`src/ps/local_shm/local_shm_protocol.h#LocalShmSlotHeader`、`src/ps/base/cache_ps_impl.h#CachePS::CheckLearningRate`、`#CachePS::UpdateParameter` |
| 稀疏提交的 step 顺序、去重、v4 约束、默认 256 KiB 切块 | `src/ps/base/sparse_gradient_commit.h#SparseGradientCommitCoordinator::Exchange`、`#DecodeSparseGradientCommit`、`#ExchangeExact`、`#SparseGradientCommitClient::SparseGradientCommit` |
| key 高 8 位 tag 与 v4 校验 | `src/optimizer/sparse_tensor.h#KeyTagShift`、`#ExtractKeyTag`、`#MakeTensorTag`、`src/ps/base/cache_ps_impl.h#CachePS::SparseGradientCommit` |
| local_shm 布局、控制块与槽位状态 | `src/ps/local_shm/local_shm_layout.h#TotalRegionBytes`、`#SlotPayloadOffset`、`local_shm_protocol.h#LocalShmControlBlock`、`#LocalSlotState`、`#LocalOpcode` |
| 无锁 MPMC 队列、futex、region 校验 | `local_shm_queue.cpp#LocalShmQueueEnqueue`、`local_shm_futex.cpp#FutexWaitUntilValueChange`、`local_shm_region.cpp#LocalShmRegion::Attach` |
| 客户端槽位获取/等待/释放与服务端 drain/CAS/worker tid | `src/ps/local_shm/local_shm_client.cpp#LocalShmPSClient::AcquireSlot`、`#WaitForSlot`、`#ReleaseSlot`、`src/ps/local_shm/local_shm_server.cpp#LocalShmStoreRuntime::DrainReadyQueue`、`#ProcessSlot`、`#FinishWithStatus` |
| epoch 只写不读、无 Command/checkpoint、独立入口 | `local_shm_client.cpp#LocalShmPSClient::SubmitGetParameterFlat`（写 `server_seen_epoch`）、`#LocalShmPSClient::Command`、`local_shm_server.cpp#LocalShmStoreRuntime::ProcessSlot`、`local_shm_server_main.cpp#main`、`src/ps/base/base_client.h#BasePSClient::SaveCheckpoint` |
| 共享 CachePS 的 server 实现 | `grpc_ps_server.cpp#ParameterServiceImpl`、`brpc_ps_server.cpp#BRPCParameterServiceImpl`、`local_shm_server.cpp#LocalShmStoreRuntime` |
| 压缩 wire 格式与 PS 级 gflag 默认值 | `src/ps/base/parameters.h#ParameterCompressItem`、`src/ps/base/parameters.cpp#Pack<ParameterCompressItem>::CompressAppend`、`src/ps/base/config.cc#FLAGS_value_size`、`#FLAGS_max_kv_num_per_request` |
| 遗留 `ShardManager` 只服务离线加载；文档漂移 | `src/ps/base/shard_manager.h#ShardManager::KeyPartition`、`src/storage/kv_engine/load_db.h`、`docs/parameter_server/grpc.md`、`proto.md`、`base.md` |
