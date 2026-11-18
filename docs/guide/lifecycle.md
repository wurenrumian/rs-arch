---
title: 启动与运行全景
description: 一张图把构建、启动、首次建表和稳态训练串起来：谁先起、谁等谁、哪一跳跨进程。
outline: [2, 3]
pageClass: rs-panorama
aside: false
---

# 启动与运行全景

这一页不拆块，只把前六章的流程收进一张图：从代码编出来，到第一个读写请求发出，再到训练循环稳定转起来。每一步的细节都在对应章节，这里只保留顺序、等待关系和进程边界。

## 它是什么

举例：一机多分片，每个分片一个服务进程，十六个训练进程。从空目录到第一步训练，中间要过四道门：编出来、起服务、客户端接入、建表写初始行。图上按"谁在动"分成五条泳道：构建与部署、控制面、服务进程、训练进程、稳态之外；泳道内从上往下是先后，跨泳道的那根线就是交接。

```mermaid
swimlane-beta TB
  subgraph build ["构建与部署 离线"]
    b1["备齐依赖与生成前缀\nconfigure 开关定型 编出产物"]
    b2["部署配置\n分片数 端点 部署 id 与世代"]
    b1 --> b2
  end

  subgraph cp ["控制面 仅 rdma"]
    cp1["0 号分片起控制面 监听 25100\n存两端元数据 回已连对端"]
    cp2["记 READY\n按心跳刷新健康快照"]
  end

  subgraph srv ["服务进程 每个分片一个"]
    s1["按传输起进程 监听端点 或建共享内存区\nrdma 再逐 lane 建队列 注册内存"]
    s2["发布本端元数据 拉对端\n逐字段校验是否同一次部署"]
    s3["挂接收请求 轮询线程全起来\n报 READY"]
    s4["首次建表\n注册形状与 tag 不写数据"]
    s5["缓存编排\n存储引擎逐行取"]
    s6["优化器读改写\n写回存储"]
    s1 --> s2
    s2 -->|"发布并拉取"| cp1
    s2 -->|"校验通过"| s3
    s3 -->|"报 READY"| cp2
    s3 --> s4
  end

  subgraph cli ["训练进程"]
    c1["客户端接入 发布本端 校验对端\nrdma 等 READY 再建槽位视图"]
    c2["首次建表 再写初始行 整行推送"]
    c3["前向读一批行\n先查缓存"]
    c4["缺失 或整批直读\n按哈希分片 切块发出"]
    c5["回程按原序回填\n前向 dense 与反向 归并梯度"]
    c6["带学习率提交写\n客户端乘完推回 或只交梯度"]
    c7["按 key 失效缓存"]
    c1 --> c2
    c2 -->|"建表请求"| s4
    c2 --> c3
    c3 --> c4
    c4 -->|"唯一出进程的一跳"| s5
    s5 --> c5
    c5 --> c6
    c6 -->|"整行 或 梯度"| s6
    s6 --> c7
  end

  subgraph side ["稳态之外"]
    h1["心跳与健康探测\n过期 已死 置脏 lane 可选重建"]
    h2["checkpoint 与观测\ngrpc 能存 brpc 没有 上报可选"]
    h1 --> h2
  end

  b2 -->|"rdma 先起控制面"| cp1
  b2 -->|"其它传输直接起"| s1
  cp2 -->|"本分片就绪"| c1
  s3 -.->|"心跳"| h1
  c7 -.->|"步末或定期"| h2
```

读图：从左往右换泳道，从上往下走时间。构建与部署那条最先走完，产物和配置定了型，运行期不再重编。服务进程那条里，gRPC 与 bRPC 只监听、共享内存只建区，只有 RDMA 要控制面、逐 lane 建资源和两端比对这一串；比对不一致就在建连阶段失败，不会带着错配去写内存。训练进程那条分两截：接入与建表在启动阶段，读、前向反向、提交写在稳态阶段，中间靠"本分片就绪"这根线接上。

三处先后不能倒：控制面先于服务端发布，READY 先于客户端建槽位视图，建表先于任何读写。真正跨进程的只有两处：稳态一步里"切块发出"那一跳，以及提交写与服务端优化器之间那一次；启动阶段的发布、校验、等 READY 也跨进程，但不在数据面上。

| 段 | 谁在动 | 卡住会怎样 | 细节在 |
| --- | --- | --- | --- |
| 0 构建与配置 | 构建机 | configure 缺依赖直接停，没有半份产物 | [构建与打包](/ch01/build)、[配置与开关](/ch01/config) |
| 1 起服务进程 | 各分片服务进程 | 客户端一直等不到 READY，或建连阶段快速失败 | [控制面与部署](/ch04/control-plane) |
| 2 客户端接入 | 训练进程 | 第一次读写报错，表还没登记 | [连接与内存注册](/ch04/connect-mr)、[客户端栈](/ch03/client-stack) |
| 3 稳态一步 | 训练进程与服务进程 | 性能与数值正确性都在这段 | [读路径](/ch01/read-path)、[写路径](/ch01/write-path)、[梯度提交](/ch02/write-path) |
| 4 稳态之外 | 两端的后台线程 | 故障恢复慢，或存档直接报错 | [lane 生命周期](/ch04/lane-lifecycle)、[一致性](/ch03/consistency) |

## 它为什么必须是这个顺序

数据面自己不建连。这是整套启动顺序的由来：客户端要发请求时，连接和队列其实已经在启动阶段建好了，运行期只写槽位、写提交字。既然数据面不负责握手，那么「两端属于同一次部署」「元数据是最新的」「这个分片能接请求」这三件事，就只能放在带外的控制面上确认，或者在监听端点那里隐式确认。

三种传输的把关点因此不同。gRPC 与 bRPC 连上端点就能发，部署一致性靠配置本身；共享内存靠同一块映射，两端挂上同一块区就算接通；RDMA 最严，逐字段比对节点角色、部署 id、世代和两个摘要，任何一项不一致都在建连阶段失败，而不是带着错配去写内存。代价是它多一个控制面服务，也多了 READY 这个等待点——客户端在 READY 之前连槽位视图都不建。

## 稳态之外的旁路

心跳每秒一次，健康快照按三档判定：三秒没刷新算过期，九秒算已死。判定为死的分片会把对应 lane 置脏，重建默认关闭，要两端同时打开才生效。存档只有 gRPC 那条协议带命令，bRPC 没有就直接报错，没有回退；共享内存那一档显式拒绝存档与清空，因为它的内存本来就是匿名映射。观测上报与这些无关，按配置选远端、CSV、JSONL、日志或关掉。

## 它和谁接

上游是[构建](/ch01/build)与[配置](/ch01/config)两页给出的产物和字段，下游是每一块的细节页。把这张图和[三层调用链](/ch01/call-chain)、[十条核心事实](/guide/facts)一起看，能先建立"哪里是进程边界"的直觉，再进各章。

## 代码位置

要改代码或核对顺序时再看这里。

| 阶段 | 关键入口 |
| --- | --- |
| 构建 | 顶层 `CMakeLists.txt`、`src/framework/pytorch/CMakeLists.txt#_recstore_wheel_sonames` |
| 配置定位 | `src/base/config.cc#ResolveRecStoreConfigPath`、`src/framework/common/op_runtime_support.cc#GetGlobalConfig` |
| 服务端入口 | `src/ps/ps_server.cpp#main`、`petps_server`、`local_shm_ps_server` |
| 控制面与 READY | `RdmaControlPlaneServer::Start`、`RcShardServerTransport::PublishAndConnect`、`ValidateRawVerbsPeerMeta`、`MaybePublishServerReady` |
| 客户端接入 | `PetPSClient::InitializeTransport`、`WaitServer`、`OpenSlot` |
| 建表与初始行 | `RecStoreClient.init_embedding_table`、`CachePS::InitTable`、`emb_write` |
| 读 | `KVClientOp::EmbRead`、`DistributedShardedClient::GetParameter`、`CachePS::GetParameterRun2Completion` |
| 写 | `SparseSGD.step`、`update_async`、`KVClientOp::EmbUpdate`、`CachePS::UpdateParameter`、`Optimizer::Update` |
| 旁路 | `MarkLaneDirty`、`SaveCheckpoint` / `LoadCheckpoint`、`report()`、`observability.sinks` |

## 交付一句

整条链的顺序就这一张图：离线定型、服务先起、客户端接入、建表、稳态循环，外加三条旁路。下一块需要细节时，按上表跳进对应章节。
