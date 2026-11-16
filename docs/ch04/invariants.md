---
title: 第 9 块：不变量
description: 把散落的前提条件集中成一张表，这些假设一旦不成立就会静默出错。
outline: [2, 3]
---

## 它是什么

这一块把前面散落的前提条件集中成一张表。它们属于「一旦不成立就会静默出错」的假设，与可以随手调整的参数不同；读代码时发现某条被打破，通常意味着真实的 bug。

## 它为什么存在

RDMA 数据面没有校验和，也没有重传兜底。协议的正确性建立在一组内存布局与线程归属的约定上，这些约定不写在类型里，只写在注释与静态断言里。

## 它和谁接

上接[第 1 块](./slot-protocol)的 slot 形状、[第 2 块](./connect-mr)的地址换算、[第 8 块](./lane-lifecycle)的世代围栏。下游是任何想改 slot 布局、改响应模式或改线程模型的改动。

## 代码位置

| # | 不变量 | 证据 |
| --- | --- | --- |
| 1 | 描述符 192 字节、载荷从 192 开始；两端控制字的 `seq` 必须匹配、`state == kRcSlotDone`；`payload_offset` 只被校验不做寻址 | `rdma_protocol.h#RequestDescriptor`、`#StatusWordDone`、`#ValidateRequestDescriptor` |
| 2 | commit/status 是唯一「就绪」信号，都在 payload 之后发布，依赖 RC 保序而非 fence | `rc_transport.cc#SubmitRequest`、`#CompleteResponse` |
| 3 | 一条 lane 只有一个 owner 线程：客户端由 `PetPSClient::mu_` 串行化 submit/harvest/rebuild；服务端由 `qp_index % thread_count` 决定 slot 扫描、响应完成与重建检查在同一 poll 线程 | `petps_client.cc#SubmitRpcLocked`、`petps_server.cc#PollingThread` |
| 4 | 服务端 GET payload worker 是唯一由非 poll 线程发起响应写入的路径，由 `Lane::rebuild_mu` + `response_epoch` 双重保护：`WriteResponsePayloadSg` 持锁比对 `expected_epoch` 再 post，`DrainGetPayloadCompletions` 在 `CompleteResponseStatusOnly` 前再比对一次 | `rc_transport.cc#WriteResponsePayloadSg`、`#RebuildClientLaneIfStale`、`petps_server.cc#DrainGetPayloadCompletions` |
| 5 | slot `seq` 在同一 lane 上单调递增，服务端用 `last_seq_` 去重；跨 lane 不保证顺序 | `petps_client.cc#SlotContext::next_seq`、`petps_server.cc#ProcessSlot` |
| 6 | `GlobalAddress.offset` 是 48 位；跨出本 lane 切片的指针被 `LocalAddress` / `LocalPointer` 直接抛错 | `global_address.h` |
| 7 | MR 权限一律 `LOCAL_WRITE \| REMOTE_READ \| REMOTE_WRITE \| REMOTE_ATOMIC`，没有只读 MR，包括那块只读零区 | `raw_verbs_transport.cc#RegisterMemoryRegion` |

## 交付一句

不变量到此交代完毕：七条前提覆盖布局、控制字、线程归属与权限。接下来是跨章节接口、风险清单与证据索引。
