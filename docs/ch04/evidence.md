---
title: 证据索引
description: 本章每一条事实结论对应的源码符号、文件与行级证据。
outline: [2, 3]
---

| 事实 | 证据 |
| --- | --- |
| 描述符 192 字节、commit/status 64 字节对齐 | `src/ps/rdma/rdma_protocol.h#RequestDescriptor` / `#CommitWord` / `#StatusWord` 的 `static_assert` |
| opcode 与 flags、descriptor 校验只做区间检查 | `src/ps/rdma/rdma_protocol.h#RcOp`、`#kRcFlagGetDirectSg`、`#kRcFlagGetAllowFallbackCopy`、`#ValidateRequestDescriptor` |
| 全局地址 64 位打包 | `src/ps/rdma/global_address.h#GlobalAddress` |
| 设备/PD/CQ 每 lane 一份、CQ 深度 4096、send WR 1024 | `src/ps/rdma/raw_verbs_transport.cc#RawVerbsTransport::RawVerbsTransport`、`#kRawVerbsCqDepth` |
| QP 参数（PSN 3185、timeout 14、retry 7） | `src/ps/rdma/raw_verbs_transport.cc#ModifyQpToRts` |
| CQE 分类与「可重建」判定 | `src/ps/rdma/raw_verbs_transport.h#ClassifyRawVerbsCompletionStatus`、`#IsRawVerbsUnreachableError` |
| QP 重建顺序与 CQ drain | `src/ps/rdma/raw_verbs_transport.cc#RawVerbsTransport::RebuildQp` |
| 客户端/服务端 lane 切片与注册长度 | `src/ps/rdma/rc_transport.cc#ClientLaneBytes`、`#ClientShardLaneOffset`、`#ServerLaneBytes`、`RcShardClientTransport::RcShardClientTransport`、`RcShardServerTransport::RcShardServerTransport` |
| slot 内部偏移 | `src/ps/rdma/rc_transport.cc#RcShardClientTransport::OpenSlot`、`#RequestCommitOffset`、`#ResponseStatusOffset` |
| 提交分两次 WRITE、commit 是唯一 signaled 写；响应先 payload 后 status | `src/ps/rdma/rc_transport.cc#RcShardClientTransport::SubmitRequest`、`#RcShardServerTransport::CompleteResponse`、`#CompleteResponseStatusOnly` |
| 响应 epoch 围栏 | `src/ps/rdma/rc_transport.cc#RcShardServerTransport::WriteResponsePayloadSg`、`#RebuildClientLaneIfStale` |
| `num_os_clients != 1` 拒绝重建 | `src/ps/rdma/rc_transport.cc#RcShardClientTransport::RebuildLane`、`#RebuildClientLaneIfStale` |
| 服务端 slot 扫描与 seq 去重 | `src/ps/rdma/petps_server.cc#PetPSServer::ProcessSlot`、`#ScanAssignedSlots` |
| direct_sg 行级条件、整批回退与存储侧前置条件 | `src/ps/rdma/petps_server.cc#HandleGetDirectSg`、`#HandleGet`、`src/storage/kv_engine/engine_composite.h#BatchGetDirectFixedRows`、`src/storage/value_store/dram_value_store.h#GetDirectFixedRows` |
| 零区注册、GET worker 与 stale 丢弃 | `src/ps/rdma/petps_server.cc#PetPSServer::PetPSServer`（`direct_sg_zero_region_`）、`#GetPayloadWorkerLoop`、`#DrainGetPayloadCompletions` |
| 客户端 slot 获取、脏/死 lane 语义、重建触发点与终身预算 | `src/ps/rdma/petps_client.cc#PetPSClient::AcquireIdleSlot`、`#MarkLaneDirty`、`#TryRebuildLaneLocked` |
| 重建后 pending 标 failed 而非删除 | `src/ps/rdma/petps_client.cc#PetPSClient::TryRebuildLaneLocked`、`#RevokeRPCResource` |
| 等待循环里的健康探测与 CQ 收割 | `src/ps/rdma/petps_client.cc#PetPSClient::WaitForStatusWord` |
| direct_sg 客户端置位与模式校验 | `src/ps/rdma/petps_client.cc#PetPSClient::FillGetDescriptor` |
| env 只接受两个值 | `src/ps/rdma/rdma_ps_client_adapter.cc#ApplyRdmaFlagsFromEnv` |
| `auto` 只在工具层 | `tools/benchmarks/run_benchmark_ps.py#resolve_rdma_get_response_mode`、`model_zoo/rs_demo/cli.py`（`RECSTORE_RDMA_GET_RESPONSE_MODE` 赋值） |
| 原地 SGD 更新（无同步） | `src/storage/kv_engine/engine_composite.h#ApplySgdUpdateFlat` |
| UPDATE 携带学习率 | `src/ps/rdma/rdma_protocol.h#RequestDescriptor`（`learning_rate`）、`src/ps/rdma/petps_server.cc` 的 `HandleUpdate*` → `CachePS::UpdateParameter` |
| 控制面 RPC 全集与 meta 编解码/校验 | `src/ps/proto/rdma_control_plane.proto#RdmaControlPlane`、`src/ps/rdma/control_plane.cc#EncodeRawVerbsNodeMeta`、`#DecodeRawVerbsNodeMeta`、`#ValidateRawVerbsPeerMeta` |
| 心跳不创建 READY、READY 唯一入口 | `src/ps/rdma/control_plane.cc#RdmaControlPlaneServer::RecordHeartbeat`、`#RdmaControlPlaneService::PublishServerReady` |
| 健康阈值计算、快照与慢路径探测节流 | `src/ps/rdma/control_plane.h#EvaluateServerHealth`、`#RdmaSlowPathProbeGate`、`src/ps/rdma/control_plane.cc#RdmaControlPlaneServer::ServerHealthSnapshot`、`src/ps/rdma/petps_client.cc#MaybeProbeShardHealth` |
| 拓扑与 digest 契约 | `src/ps/rdma/rdma_deployment.cc#ParseResolvedRdmaDeploymentConfig`、`#StableDigest` |
| flag 默认值 | `src/ps/rdma/rc_options.cc` |
| 分片、批量装配与在途上限 | `src/ps/rdma/shard_routing.h#BuildChunks`、`#MergeBatchRows`、`src/ps/rdma/rdma_distributed_executor.cc#SubmitGetParameter`、`#DrainBatchSlots`、`src/ps/rdma/rdma_ps_client_adapter.cc#MaxInFlightGetRpcs`、`#RDMAPSClientAdapter::PrefetchParameter` |
| `RpcStatus` 取值与文本 | `src/ps/rdma/rdma_status.h#RpcStatus` |
