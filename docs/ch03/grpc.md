---
title: 第 6 块：gRPC 路径
description: gRPC 把请求塞进 protobuf 消息，走 HTTP/2 上的 RPC。
outline: [2, 3]
---

## 它是什么

gRPC 路径把请求塞进 protobuf 消息，走 HTTP/2 上的 RPC。单分片客户端把 key 原始字节写进请求字段，每 2000 个 key 发一个请求，全部挂在第一个 stub 上，用同一个完成队列收事件。服务端用异步接口接请求，取到 PS 核心返回的行后打包成压缩块写回。多 shard 时各 shard 的这条链路并行，最后由分片层 `ScatterEmbeddingRows` 统一回填。

## 它为什么存在

gRPC 是默认路径，也是唯一完整支持 checkpoint 的路径。它用 protobuf 承载大载荷，实现简单、跨语言，代价是多一次拷贝，批量上限只能取 2000。Put 走整批交给 PS 核心的批量入口；checkpoint 的 fan-out、元数据校验、身份约束也都只在这条路径上实现。

## 它和谁接

上游是[第 4 块](./sharding)的分片层，下游是 gRPC 服务端，再往下是共享的 PS 核心。它的失败语义与 bRPC 基本一致：任一 RPC 失败就整块失败；差异只在空 payload 的处理。

## 代码位置

- 单分片客户端把 key 原始字节写入 `GetParameterRequest.keys`，每 2000 key 一个请求，全部挂在 `stubs_[0]` 上，用同一个 `cq_` 收完成事件（`grpc_ps_client.cpp#GRPCParameterClient::GetParameter`）。
- 服务端 `ParameterServiceImpl::GetParameter` 用 `base::ConstArray<uint64_t>(request->keys())` 直接解释字节，经 `CachePS::GetParameterRun2Completion` 取 `ParameterPack`，再用 `ParameterCompressor` 打包进 `parameter_value`；Put 则整批交给 `CachePS::PutParameter`（内部 `BatchPut`），与 bRPC 的逐 key 写入不同。
- 超时按 RPC 分别设置：普通 RPC 15 s，checkpoint 600 s，`LoadCkpt` 30 s，建表请求没有设置（`SetRpcDeadline`）。
- 失败不再静默：每个 `ClientContext` 都带 15 s deadline；完成循环把 `ok == false`（传输未完成）与「完成但 `status.ok() == false`」分开记录，任一失败返回 -1；非空请求收到空 payload、payload 长度或行数对不上，同样返回 -1。分片层把非 0 视为该分片失败，整批返回 -1。缺失 key 仍返回 0 行，这是数据语义，不是错误。
- 预取：`PrefetchBatch` 自带独立完成队列；`ConsumePrefetchCompletion` 把传输失败与非 OK 状态交给 `MarkPrefetchFailed`，只记首个原因；`IsPrefetchDone` 把失败批次当作已完成，避免调用方空转；`WaitForPrefetch` 以 200 ms 轮询、最多 150 轮（30 s）无事件即判超时；`GetPrefetchResult` 遇到失败批次返回 `false`。

## 交付一句

gRPC 路径到此交代完毕：protobuf 编码、2000 key 一批、单个完成队列，以及一条「任一 RPC 失败就整批 -1」的失败路径。下一块讲把大载荷挪到 attachment 上的 bRPC。
