---
title: 第 9 块：不变量
description: 七条一旦不成立就会静默出错的前提，每条附上「破了会怎样」和源码证据。
outline: [2, 3]
---

这一页把前面几块依赖的前提收成一张表，每条都指到源码里的证据。它们不是能随手调的参数，而是不成立就会静默出错的假设。所以每条后面都补了一句「破了会怎样」，用来判断一个可疑改动值不值得追。

## 它是什么

七条前提集中在一张表里。判断依据是「破了之后会不会报错」：会报错的属于参数，不会报错、只是算错的才是不变量。

## 它为什么存在

RDMA 数据面没有校验和，也没有重传兜底。协议的正确性建立在一组内存布局与线程归属的约定上，这些约定不写在类型里，只写在注释与静态断言里。

## 它和谁接

上接[第 1 块](./slot-protocol)的槽位形状、[第 2 块](./connect-mr)的地址换算、[第 8 块](./lane-lifecycle)的世代围栏。下游是任何想改槽位布局、改响应模式或改线程模型的改动。

## 代码位置

| # | 不变量 | 破了会怎样 | 证据 |
| --- | --- | --- | --- |
| 1 | 描述符 192 字节、载荷从 192 开始；两端控制字的 `seq` 必须匹配、`state == kRcSlotDone`；`payload_offset` 只被校验不做寻址 | 服务端按错的偏移读头部，字段错位；控制字对不上时，会把上一轮的完成当成本轮，读回一份不相干的数据 | `rdma_protocol.h#RequestDescriptor`、`#StatusWordDone`、`#ValidateRequestDescriptor` |
| 2 | 提交字/状态字是唯一「就绪」信号，都在载荷之后发布，依赖 RC 保序而非 fence | 载荷还没落地就被当成就绪，服务端读到半截请求，而且不报错 | `rc_transport.cc#SubmitRequest`、`#CompleteResponse` |
| 3 | 一条 lane 只有一个 owner 线程：客户端由 `PetPSClient::mu_` 串行化 submit/harvest/rebuild；服务端由 `qp_index % thread_count` 决定槽位扫描、响应完成与重建检查在同一个轮询线程 | 两个线程同时提交或收割，完成事件会被对方抢走，配到错误的请求上 | `petps_client.cc#SubmitRpcLocked`、`petps_server.cc#PollingThread` |
| 4 | 服务端 GET 载荷 worker 是唯一由非轮询线程发起响应写入的路径，由 `Lane::rebuild_mu` + `response_epoch` 双重保护：`WriteResponsePayloadSg` 持锁比对 `expected_epoch` 再 post，`DrainGetPayloadCompletions` 在 `CompleteResponseStatusOnly` 前再比对一次 | 重建后旧 worker 把上一代的行写进新一代的槽位，覆盖别人的响应 | `rc_transport.cc#WriteResponsePayloadSg`、`#RebuildClientLaneIfStale`、`petps_server.cc#DrainGetPayloadCompletions` |
| 5 | 槽位 `seq` 在同一 lane 上单调递增，服务端用 `last_seq_` 去重；跨 lane 不保证顺序 | 同一个槽位被处理两次，同一份更新乘两遍 | `petps_client.cc#SlotContext::next_seq`、`petps_server.cc#ProcessSlot` |
| 6 | `GlobalAddress.offset` 是 48 位；跨出本 lane 切片的指针被 `LocalAddress` / `LocalPointer` 直接抛错 | 一个 lane 的指针能寻到另一个 lane 的内存，越界写没人拦 | `global_address.h` |
| 7 | MR 权限一律 `LOCAL_WRITE \| REMOTE_READ \| REMOTE_WRITE \| REMOTE_ATOMIC`，没有只读 MR，包括那块只读零区 | 某个 MR 收窄成只读之后，走这条路径的写或原子操作要到运行期才失败，注册期看不出来 | `raw_verbs_transport.cc#RegisterMemoryRegion` |

## 交付一句

不变量到此交代完毕：七条前提覆盖布局、控制字、线程归属与权限。接下来是跨章节接口、风险清单与证据索引。
