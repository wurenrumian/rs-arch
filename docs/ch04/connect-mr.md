---
title: 第 2 块：连接与内存注册
description: 一条 lane 的内存怎么切、地址怎么在两端对齐——十六位节点编号加四十八位偏移，配一次原点换算。
outline: [2, 3]
---

上一块讲格子里的偏移，这一块讲它们落在哪块内存、对端怎么算。答案在注册时就定好了。

## 它是什么

地址不是本机虚拟地址，而是「节点编号加节点内全局偏移」压进一个 64 位字。

注册内存（MR）则是登记给网卡、由网卡直接读写的一段缓冲区。

### 全局地址与原点换算

高 16 位节点号，低 48 位偏移。每条 lane 只注册自己那一片，对外仍按全局偏移寻址：本端发布基点，对端算出的「基点加偏移」就落进这片内存。两端都不必知道对方的虚拟地址。

### 客户端那片

每个客户端、每个分片、每条 lane 各注册一段，长度是槽位数乘「响应槽位加请求槽位」，起点由分片号与 lane 号算出。本地暂存区只当写的源，对端从不读它。

### 服务端那片

每条 lane 两块自用内存一次分配：所有客户端写来的请求槽位，加一块响应暂存，两者之和就是该 lane 注册的字节数。请求槽位的全局编号拆回客户端、lane、槽内序号，就是序号数组的下标。

此外每 lane 还注册 KV 值区与只读零区。

### 每条 lane 独占的资源

每条 lane 自己开一次设备，再分配保护域、建完成队列、注册内存，给每个对端建一个队列对。队列对（QP）是发送、接收两条队列，RC 两端各持一个；完成队列（CQ）收网卡的完成报告。

### 实际注册多大

配置默认是 128 MiB，但实际注册的是算出来的长度：默认配置下客户端每条 lane 是 1 × (1 MiB + 1 MiB) = 2 MiB。lane 数头文件默认 32，实际由启动参数覆盖，默认 16。

## 它为什么存在

每条 lane 都注册整个地址空间，注册数量与页表压力随 lane 数线性放大，而访问只落在自己那一片。切片注册加原点换算让两个目标同时成立。

独占设备与完成队列是为重建：队列对 reset 后要排空完成队列，前提是这条队列上只有本 lane 投递。对端写本端内存要带远程键（rkey），即这张内存注册的通行证。

## 它和谁接

上游是部署配置里的节点编号与设备选择。下游是第 3、4 块的读写路径，偏移全从这套换算来。请求槽位数决定同时在途请求数，响应槽位大小决定单次读返回行数。

## 代码位置

- 地址模型：`GlobalAddress` 是 64 位打包的 `{nodeID:16, offset:48}`（`global_address.h`，有 `sizeof == 8` 静态断言）。`LocalAddress()` 输出 `region_origin_offset + (ptr - local_base)`；`LocalPointer()` 反向减去 origin；`LocalMeta()` 发布 `base_addr = local_base - region_origin_offset`，于是对端算出的 `base_addr + offset` 正好落进本端切片。对端 `Write/Read` 用 `remotes[n].base_addr + remote.offset` 与 `rkey`。
- 客户端布局：`ClientLaneBytes = slots_per_qp * (response_slot_bytes + request_slot_bytes)`，起点是 `ClientShardLaneOffset = (shard_id * raw_lanes_per_os_client + raw_lane) * lane_bytes`。`RcShardClientTransport::OpenSlot` 是唯一构造 `RcClientQpView` 的地方；`SubmitRequest` 把描述符与载荷拷进本地暂存槽位，再分两次写送到服务端的请求槽位。
- 服务端布局：`RcShardServerTransport` 每条 raw lane 一次性 bump 分配两块，`ServerLaneBytes = num_clients * slots_per_qp * request_slot_bytes` 的请求区，以及 `num_clients * slots_per_qp` 个 `response_slot_bytes` 的 response 暂存区，两者之和就是该 lane 的 `local_region_bytes`。请求槽位的全局编号是 `client_id * total_slots_per_shard + qp_index * slots_per_qp + slot_in_qp`，`DecodeSlotIndex` 是它的逆运算，也是服务端 `last_seq_` / `inflight_seq_` 数组的下标。
- 服务端额外注册：`RegisterLocalMemoryRegion` 内部遍历所有 lane。`CachePS::GetRDMABackingRegion()` 返回的 KV value 区，作为 `direct_sg` 的 SGE 源（SGE 是一次写里「从哪块内存取多少字节」的描述项）；启动时 `posix_memalign` + `memset(0)` 的只读零区，长度等于一个 `response_slot_bytes`，用于 miss 行。
- 资源粒度：`raw_verbs_transport.cc` 的构造函数每条 lane 都 `ibv_open_device` 一次，然后各自 `ibv_alloc_pd`、`ibv_create_cq(depth=4096)`、`ibv_reg_mr`、每对端一个 `ibv_create_qp`（`IBV_QPT_RC`，`max_send_wr=1024`、`max_recv_wr=1024`、`max_send_sge=32`、`max_recv_sge=1`）。这一层网卡接口即 verbs。控制面通道按同一粒度：`RawVerbsTransport::ControlPlane()` 每个 transport 实例一份，所以 16 lane 的客户端进程会惰性开出 16 条 gRPC channel（外加 `PetPSClient` 自己那条）。
- 注册尺寸：`RawVerbsConfig::local_region_bytes` 的结构体默认值是 128 MiB，但 `MakeRawConfig` 的实参是 `ClientLaneBytes(config_)`（客户端）或 `ServerLaneBytes + response_slots * response_slot_bytes`（服务端）。`RcTransportConfig` 头文件里 `qps_per_client_per_shard = 32` 也只是默认值，实际由 flag（默认 16）覆盖。

本章涉及的文件与关键符号，按事实逐条列在章末「证据索引」，这里不重复。

## 交付一句

至此交代完毕：全局偏移加原点换算、按 lane 切片注册、每条 lane 独占一套 verbs 资源。下一块接[第 3 块](./get)，讲一次读请求。
