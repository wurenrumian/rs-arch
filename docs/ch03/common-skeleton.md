---
title: 第 5 块：三条传输的共同骨架
description: 三条传输的外部行为收敛成同一套骨架：一次调用一次响应、先路由后传输、超出上限就切块。
outline: [2, 3]
---

三条网络路径的实现细节各不相同，但调用方看到的形状必须一样。这一页先把它们的共同点立起来，后面三页才好只讲差异。读完你能说出换一条传输时，哪些行为不会变。

## 它是什么

三条传输的外部行为收敛成同一套骨架：

1. 一次调用对应一次响应。
2. 分片层在传输之前就完成路由。
3. 每个 RPC 有 key 上限，超出就串行切块。
4. 服务端最终都调用同一个 PS 核心。

有一条前提贯穿三条路径：值和梯度的二维形状在客户端入口就校验，服务端不再重复校验。结果张量允许先用 `{0, dim}` 占位，需要时就地扩容。读之前会把输出清零；服务端对缺失的 key 回一个维度为 0 的条目，客户端因此把它保留成 0 行。

## 它为什么存在

三个服务端实现共享同一个 PS 核心。所以 Get、Put、Update、InitTable、SparseGradientCommit 的语义在三种传输之间必须一致。

骨架立起来之后，后面三块只需要讲差异：编码放在哪、并发靠什么、失败之后报错还是重建。不立骨架，三条路径会看起来像三个互不相干的系统。

## 它和谁接

上接[第 4 块](./sharding)产出的分片分组与块列表，下接三条具体路径。

还有第四条路是 RDMA。它同样实现客户端接口，内部是另一套会话式协议，见[第 04 章](../ch04/)，本章不展开。

## 代码位置

| 角色 | 位置 |
| --- | --- |
| 服务端抽象与三个实现 | `src/ps/base/base_ps_server.h#BaseParameterServer::Init/Run`；`grpc_ps_server.cpp#ParameterServiceImpl`、`brpc_ps_server.cpp#BRPCParameterServiceImpl`、`local_shm_server.cpp#LocalShmStoreRuntime` |
| 传输无关核心 | `src/ps/base/cache_ps_impl.h#CachePS`（表、优化器、checkpoint 状态） |
| 输出张量就地扩容 | `EnsureEmbeddingOutput`：允许 `{0, dim}` 占位，调用时按需扩容 |
| 读之前清零 | Get 之前把输出 `memset` 为 0 |
| 缺失 key 怎么回 | 服务端回一个 `dim == 0` 的条目，客户端保留成 0 行 |
| 传给存储侧的线程号 | gRPC / bRPC 恒传 0，local_shm 传 worker 的 `ready_queue_id` |

存储侧的线程号三者不一致，这条差异留到风险条目收口。

## 交付一句

共同骨架到此交代完毕：一次调用一次响应、先路由后传输、入口校验形状。下一块讲第一条路径 gRPC。
