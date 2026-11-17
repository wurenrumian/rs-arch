---
title: 第 2 块：连接与内存注册
description: 一条 lane 的内存怎么切、地址怎么在两端对齐——十六位节点编号加四十八位偏移，配一次原点换算。
outline: [2, 3]
---

上一块讲格子里的偏移，这一块讲格子落在哪块内存、对端怎么算到它。答案在注册时就定了：一个 64 位地址里塞节点号与偏移，再用一次原点换算把偏移变成本端指针。

## 它是什么

举例：16 条 lane，每条 1 MiB 请求槽位加 1 MiB 响应槽位，一个客户端进程为单个分片就注册 32 MiB；服务端为每个客户端在每条 lane 上留 1 MiB 请求位。两端始终不交换虚拟地址，只交换一个基点和一张远程键。

对端算出的地址怎么正好落进本端注册区？

```mermaid
flowchart LR
  A["对端收到的全局地址"] -->|"拆出"| B["全局偏移"]
  M["本端注册时发布基点"] -->|"经控制面送一次"| C["对端算出基点加偏移"]
  B -->|"代入"| C
  C -->|"远程写落到"| D["本端注册区"]
  D -->|"按槽位切"| E["请求槽位与响应槽位"]
```

读图：图里有两条跨进程箭头——发布基点走控制面、只发生一次，对端的每次写入走数据面；拆偏移与加法都在对端本地完成。节点号不参与计算，它只是本端用来确认「这个地址确实属于我」的一道校验。

地址不是虚拟地址：高 16 位是节点号，低 48 位是节点内偏移。客户端每条 lane 里还有一段本地暂存区，只当写的源，对端从不读它。

同一条 lane 上不止一个客户端。多个客户端在同一条 lane 上的槽位怎么排？

```mermaid
flowchart LR
  A["客户端 0 的请求槽位"] -->|"占第一段"| B["客户端 1 的请求槽位"]
  B -->|"依次排到"| C["最后一个客户端的请求槽位"]
  C -->|"合成"| D["服务端这条 lane 的请求区"]
  D -->|"编号反解"| E["客户端号与槽内序号"]
  E -->|"同一编号"| F["响应暂存里对应的一格"]
```

读图：这张图里没有网络，全是服务端本地的排布；寻址靠乘加，客户端号乘每客户端槽位数再加槽内序号。响应暂存单独一格一份，服务端写回时按同一个编号挑格。

## 它为什么存在

每条 lane 都注册整个地址空间，注册数量与页表压力会随 lane 数线性放大，而访问只落在自己那一片。切片注册加原点换算让两个目标同时成立：对外仍按全局偏移寻址，实际只登记了本端要用的字节。

独占设备与完成队列是为重建服务的：队列对是发送、接收两条队列，完成队列收网卡的完成报告；队列对 reset 之后要排空完成队列，前提是这条队列上只有本 lane 投递。此外每条 lane 还注册 KV 值区与一个只读零区，零区长度等于一个响应槽位，用来补缺失的行。对端要写进本端内存还必须带远程键，那是这张内存注册的通行证，没它写不进来。

## 它和谁接

上游是部署配置里的节点编号与设备选择。下游是第 3、4 块的读写路径，所有偏移都从这套换算来。请求槽位数决定同时在途请求数，响应槽位大小决定单次读能返回多少行。

## 代码位置

要改代码时再看这里。

- 地址模型：`GlobalAddress` 是 64 位打包的 `{nodeID:16, offset:48}`（`global_address.h`，有 `sizeof == 8` 静态断言）。`LocalAddress()` 输出 `region_origin_offset + (ptr - local_base)`；`LocalPointer()` 反向减去 origin；`LocalMeta()` 发布 `base_addr = local_base - region_origin_offset`，于是对端算出的 `base_addr + offset` 正好落进本端切片。对端 `Write/Read` 用 `remotes[n].base_addr + remote.offset` 与 `rkey`。
- 客户端布局：`ClientLaneBytes = slots_per_qp * (response_slot_bytes + request_slot_bytes)`，起点是 `ClientShardLaneOffset = (shard_id * raw_lanes_per_os_client + raw_lane) * lane_bytes`。`RcShardClientTransport::OpenSlot` 是唯一构造 `RcClientQpView` 的地方；`SubmitRequest` 把描述符与载荷拷进本地暂存槽位，再分两次写送到服务端的请求槽位。
- 服务端布局：`RcShardServerTransport` 每条 raw lane 一次性 bump 分配两块，`ServerLaneBytes = num_clients * slots_per_qp * request_slot_bytes` 的请求区，以及 `num_clients * slots_per_qp` 个 `response_slot_bytes` 的 response 暂存区，两者之和就是该 lane 的 `local_region_bytes`。请求槽位的全局编号是 `client_id * total_slots_per_shard + qp_index * slots_per_qp + slot_in_qp`，`DecodeSlotIndex` 是它的逆运算，也是服务端 `last_seq_` / `inflight_seq_` 数组的下标。
- 服务端额外注册：`RegisterLocalMemoryRegion` 内部遍历所有 lane。`CachePS::GetRDMABackingRegion()` 返回的 KV value 区，作为 `direct_sg` 的 SGE 源（SGE 是一次写里「从哪块内存取多少字节」的描述项）；启动时 `posix_memalign` + `memset(0)` 的只读零区，长度等于一个 `response_slot_bytes`，用于 miss 行。
- 资源粒度：`raw_verbs_transport.cc` 的构造函数每条 lane 都 `ibv_open_device` 一次，然后各自 `ibv_alloc_pd`、`ibv_create_cq(depth=4096)`、`ibv_reg_mr`、每对端一个 `ibv_create_qp`（`IBV_QPT_RC`，`max_send_wr=1024`、`max_recv_wr=1024`、`max_send_sge=32`、`max_recv_sge=1`）。这一层网卡接口即 verbs。控制面通道按同一粒度：`RawVerbsTransport::ControlPlane()` 每个 transport 实例一份，所以 16 lane 的客户端进程会惰性开出 16 条 gRPC channel（外加 `PetPSClient` 自己那条）。
- 注册尺寸：`RawVerbsConfig::local_region_bytes` 的结构体默认值是 128 MiB，但 `MakeRawConfig` 的实参是 `ClientLaneBytes(config_)`（客户端）或 `ServerLaneBytes + response_slots * response_slot_bytes`（服务端）。`RcTransportConfig` 头文件里 `qps_per_client_per_shard = 32` 也只是默认值，实际由 flag（默认 16）覆盖。

本章涉及的文件与关键符号，按事实逐条列在章末「证据索引」，这里不重复。

## 交付一句

连接与注册到此交代完毕：全局偏移加原点换算、按 lane 切片注册、每条 lane 独占一套 verbs 资源。下一块接[第 3 块](./get)，讲一次读请求。
