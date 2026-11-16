---
title: RDMA 传输深潜
description: 一条 lane 的一生只做三件事：把请求写进对端预注册的 slot、让对端看见「就绪」、把结果写回本端 slot。
outline: [2, 3]
---

## 一句话

一条 lane 的一生只做三件事：把请求写进对端预注册的 slot、让对端看见「就绪」、把结果写回本端 slot。数据面不经过内核、不经过 RPC 框架，是一套自建的 RC-write slot 协议。控制面是 shard 0 上的一个 gRPC 服务（默认 `127.0.0.1:25100`），只交换 QP 元数据、READY 与健康状态，从不进入读写热路径。

## 本章覆盖什么

覆盖：slot 协议与全局地址、verbs/lane 资源、客户端批量栈、服务端扫描与响应、控制面与部署契约、两种响应模式的真实差异。不在本章：其它三种传输与客户端工厂、存储引擎、Python 计算层、benchmark 工具，见「与相邻章节的接口」。

## 7 个部件

| 编号 | 短名 | 它负责回答的问题 | 块 |
| --- | --- | --- | --- |
| 1 | [slot 协议](./slot-protocol) | 两端对一块注册内存的约定形状是什么，什么算「就绪」 | 1 |
| 2 | [连接与内存注册](./connect-mr) | 这条 lane 的内存怎么分配、怎么按全局偏移寻址 | 2 |
| 3 | [一次读写](./get) | GET 与 PUT/UPDATE/INIT 各自走哪几步 | 3、4 |
| 4 | [响应模式](./response-modes) | direct_sg 与 staging_copy 差在哪，auto 为什么在运行时不存在 | 5 |
| 5 | [控制面与部署](./control-plane) | 两端怎么确认「同一次部署」，启动顺序与参数是什么 | 6 |
| 6 | [错误分层](./errors) | 哪一层检测、谁标记 lane 脏、哪些错误不该重试 | 7 |
| 7 | [lane 生命周期](./lane-lifecycle) | lane 什么时候重建、怎么对齐、为什么有人不能重建 | 8 |

[第 9 块](./invariants)把散落的前提条件收成一张不变量表。

## 它们怎么串起来

先看控制面：两端各自发布 QP 元数据，客户端等到目标 shard 的 READY 之后才建立 slot 视图（6）。数据面按 slot 协议工作：客户端把描述符与载荷写进对端的请求 slot，最后单独写一个 commit 字表示就绪（1）；服务端轮询到就绪后取出请求，读请求按响应模式决定直接 scatter 真实行还是先拷进本地 staging（5），写请求按载荷类型落到更新或建表（4）；结果连同状态字写回客户端 slot（3）。任何一步出错都进错误分层：谁能检测、是否置脏、能不能靠重建治好都在那里判定（7）；重建本身是双边握手，靠世代号把旧连接的迟到完成挡掉（8）。

## 核心概念表

| 概念 | 一句话 |
| --- | --- |
| slot | 一块按固定偏移切好的注册内存，请求与响应各占一半 |
| lane | 一条独立的 RC 连接及其独占的 verbs 资源（设备、PD、CQ、MR 视图） |
| 控制字 | 64 字节的 commit 或 status，唯一表示「就绪」的信号 |
| 世代 | 一次重建的编号，用来拦住旧连接的迟到完成 |
| 脏 | lane 暂时不可用，等待者立即失败而不是阻塞 |
| 回退 | 就绪行无法直接寻址时，整批改走拷贝路径 |

## 建议读法

- 只关心一次读怎么完成：1 → 2 → 3 → 5。
- 关心自愈与故障：7 → 8，顺序不要颠倒，否则「谁标记脏、谁去重建」会失去上下文；参数与部署看[第 6 块](./control-plane)的 flag 表和第 9 块的不变量表。

## 与相邻章节的接口

- **[第 03 章（参数服务器与传输）](../ch03/)**：`PetPSClient` 实现 `recstore::ShardClient`；`RDMAPSClientAdapter` 实现 `BasePSClient`，由 `CreatePSClient` 按 `ps_type == "RDMA"` 构造。gRPC/bRPC/local_shm 的分片与请求形态在第 03 章，本章只讲 RDMA lane。
- **[第 05 章（存储与内存）](../ch05/)**：`HandleGet` / `HandleGetDirectSg` / `HandlePut` / `HandleUpdate*` 调用的 `CachePS` → `BaseKV` 接口；`direct_sg` 的可行性最终由 `KVEngineComposite::BatchGetDirectFixedRows` 与 value store 的 `GetDirectFixedRows` / `RDMABackingData` 决定。
- **[第 02 章（Python 计算层）](../ch02/)／[第 06 章（model zoo / 测试 / 工具）](../ch06/)**：`PrefetchParameter` / `GetPrefetchResult` 的语义（异步 GET + 延迟取结果）是 Python 侧 `emb_read` 的实现基础；`resolve_rdma_get_response_mode`、`RECSTORE_RDMA_*` 注入、`run_rdma_rc_transport_benchmark.py` 的 profile 解读都在第 06 章。本章只覆盖 RPC 侧句柄，并只声明「`auto` 属于工具层」这一事实。
