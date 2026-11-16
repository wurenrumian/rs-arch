---
title: 参数服务器层：抽象、协议与传输
description: 一次批量请求从训练进程出发，经路由、切块与传输到达服务端，再按原行序拼回张量。
outline: [2, 3]
---

## 一句话

一个批量请求离开训练进程后，先按 key 落到某个 shard，再被切成不超过上限的小块，交给某条传输送到服务端，最后把各分片的返回按原始行序拼回一块张量。三条传输在这条路上的分工一致，差别在编码方式、并发模型、失败怎么暴露，以及能不能做 checkpoint。

## 本章覆盖什么

覆盖请求从客户端抽象进入 PS、再交给存储实现之前的那一层：

- PS 抽象与核心逻辑：`base_client.h`、`base_ps_server.h`、`cache_ps_impl.h`、`parameters.*`、`Postoffice.*`、`sparse_gradient_commit.h`、`config.*`。
- 客户端工厂与选型：`client_factory.*`、`client_options.h`、`framework/common/ps_client_config_adapter.cc`、`ps_server.cpp`。
- 协议：`proto/ps.proto`、`proto/ps_brpc.proto` 的命令与载荷位置。
- 三条传输与横切面：gRPC、bRPC、local_shm，以及分片路由、批拆分/合并、checkpoint、失败与降级。

不在范围：RDMA 传输内部（`ps/rdma/*`）见[第 04 章](../ch04/)；`BaseKV` 引擎与 checkpoint 文件格式见[第 05 章](../ch05/)；Python 侧 `DistEmb`/`EmbBag` 与训练循环见[第 02 章](../ch02/)。

## 6 个部件

| 编号 | 短名 | 它负责回答的问题 |
| --- | --- | --- |
| 1 | [请求形状](./request-shape) | 一个请求里装了什么，两端对它的格式有哪些硬约定 |
| 2 | [客户端栈与选型](./client-stack) | 训练进程拿到哪个客户端，为什么单机部署也要经过分片层 |
| 3 | [协议与命令](./protocol) | 两份协议文件各自能表达什么，哪些能力在其中一份里根本不存在 |
| 4 | [分片与路由](./sharding) | key 怎么落到 shard，请求怎么部署成进程 |
| 5 | [三条传输](./common-skeleton) | gRPC、bRPC、local_shm 的共同骨架与各自的差异 |
| 6 | [一致性与 checkpoint](./consistency) | 写入顺序、去重、checkpoint 能力与失败边界 |

正文按读者要解决的问题切成 10 块。第 5 个部件占四块：先讲共同骨架，再分别讲三条路径；配置单独作为最末一块。

## 它们怎么串起来

按编号走一遍。调用方交来表名、key 与值或梯度（1）；选型结果决定用哪个客户端、是否套上分片层（2）；客户端把请求编码成两份协议之一里的命令（3）；分片层按 hash 把 key 分到 shard，并在 shard 内二次切块（4）；单分片客户端用 gRPC、bRPC 或共享内存把块送出去、把结果收回来（5）；写路径最后由去重与 checkpoint 规则收口（6）。反向也成立：任何一条线上现象，都能落回这条链上的某一段。

## 核心概念表

| 概念 | 一句话 |
| --- | --- |
| shard | 一份独立持有的表数据，路由的最小单位（也叫分片） |
| 分片客户端 | 只连一个 shard 的传输实现，只有 gRPC/bRPC 有这一层 |
| 分片层 | 负责路由、切块、并发扇出与结果回填的外壳 |
| 压缩块 | wire 上的定长头加 float 行，Get/Put 的载荷单位 |
| 命令 | 协议里的 RPC 或命令枚举，PS 的控制入口 |
| 槽位 | local_shm 里一块定长的请求/响应缓冲区 |
| 提交步 | 稀疏更新的 (session, step, chunk) 三元组，去重的依据 |

## 建议读法

- 想知道一次 Get 从头到尾发生了什么：1 → 3 → 4 → 5（先读共同骨架），再接自己用的那条路径（6、7 或 8）。
- 想确认某个配置到底生不生效：2 → [第 10 块配置表](./config) → 风险条目的降级边界；线上排查则从风险标题定位现象，再回到对应块读机制。

## 与相邻章节的接口

- **[第 02 章（计算层）](../ch02/)**：`BasePSClient` 是唯一入口；`PrefetchParameter/IsPrefetchDone/WaitForPrefetch/GetPrefetchResult` 构成预取句柄协议，`SubmitUpdateParameterAsync/WaitUpdateParameter` 默认抛异常表示后端不支持异步更新。张量只能是 `FLOAT32` 二维，`{0, dim}` 表示「由后端分配」。
- **[第 04 章（RDMA）](../ch04/)**：`RDMAPSClientAdapter` 实现同一个 `BasePSClient`，但有自己的部署校验和 `rdma_control_plane.proto`；本章只把它当作工厂的一个分支。bRPC 的 `use_rdma` 是 bRPC Channel 内部选项，与会话式 raw-verbs 路径不同。
- **[第 05 章（存储）](../ch05/)**：`CachePS` 通过 `BaseKV` 的 `BatchGet/BatchGetFlat/BatchGetDirectFixedRows/BatchPut/BatchGetIndexOnly` 访问存储，并把 `tid` 原样传下去；gRPC/bRPC 恒传 0，local_shm 传 worker 的 `ready_queue_id`。checkpoint 的落盘格式与 `CheckpointRecordCount` 语义由存储层定义。
- **[第 06 章（测试与工具）](../ch06/)**：`grpc_ps_bench.cpp` 只测 `LoadFakeData/DumpFakeData` 的上下行带宽；`ps_transport_benchmark` 与 `mixed` 基准通过 `CreatePSClient` 复用同一套选型逻辑。
