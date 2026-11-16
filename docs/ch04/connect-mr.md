---
title: 第 2 块：连接与内存注册
description: 地址不是本机虚拟地址，而是「节点编号加节点内全局偏移」的 64 位打包。
outline: [2, 3]
---

## 它是什么

地址不是本机虚拟地址，而是「节点编号加节点内全局偏移」的 64 位打包。每条 lane 只注册自己需要的那一片，对外仍用全局偏移寻址，靠一个原点偏移把「全局窗口」换算成「本地那一段」；这样客户端不需要注册整块服务端内存，服务端也不需要知道客户端的虚拟地址。服务端一条 lane 上有两块自用内存（所有客户端的请求 slot 与响应 staging），此外还额外注册两类来源：KV 值区（`direct_sg` 的 SGE 源）和一块只读零区（缺失行用它填 0）。

## 它为什么存在

如果每条 lane 都注册整个进程的地址空间，MR 数量与页表压力会随 lane 数线性放大，而实际访问只落在自己那一片。切片注册加原点换算，让「只注册本 lane」和「按全局偏移寻址」两个目标同时成立。每条 lane 独占设备、PD、CQ，则是为了重建：QP reset 后要把该 CQ 彻底 drain，前提是这条 CQ 上只有本 lane 的 QP 在投递。

## 它和谁接

上游是部署配置里的节点编号与设备选择，下游是第 3、4 块的读写路径：所有偏移都从这套换算里来。请求 slot 的数量决定同一时刻能有多少在途请求，响应 slot 的大小决定单次读能返回多少行。

## 代码位置

地址模型：`GlobalAddress` 是 64 位打包的 `{nodeID:16, offset:48}`（`global_address.h`，有 `sizeof == 8` 静态断言）。`LocalAddress()` 输出 `region_origin_offset + (ptr - local_base)`，`LocalPointer()` 反向减去 origin，`LocalMeta()` 发布 `base_addr = local_base - region_origin_offset`，于是对端算出的 `base_addr + offset` 正好落进本端切片；对端 `Write/Read` 用 `remotes[n].base_addr + remote.offset` 与 `rkey`。

客户端 lane 布局：每个 client、每 shard、每 lane 的注册长度是 `ClientLaneBytes = slots_per_qp * (response_slot_bytes + request_slot_bytes)`，起点是 `ClientShardLaneOffset = (shard_id * raw_lanes_per_os_client + raw_lane) * lane_bytes`。`RcShardClientTransport::OpenSlot` 是唯一构造 `RcClientQpView` 的地方；`SubmitRequest` 把 descriptor 与 payload 拷进本地 staging slot，再分两次 WRITE 到服务端的请求 slot。本地 staging 从不被对端读取，它只是 WRITE 的源缓冲区。

服务端 lane 布局：`RcShardServerTransport` 每条 raw lane 一次性 bump 分配两块，`ServerLaneBytes = num_clients * slots_per_qp * request_slot_bytes` 的请求区，以及 `num_clients * slots_per_qp` 个 `response_slot_bytes` 的 response staging 区，两者之和就是该 lane 的 `local_region_bytes`。请求 slot 的全局编号是 `client_id * total_slots_per_shard + qp_index * slots_per_qp + slot_in_qp`，`DecodeSlotIndex` 是它的逆运算，也是服务端 `last_seq_` / `inflight_seq_` 数组的下标。服务端另外把两类本地内存注册进每一条 lane（`RegisterLocalMemoryRegion` 内部遍历所有 lane）：`CachePS::GetRDMABackingRegion()` 返回的 KV value 区，作为 `direct_sg` 的 SGE 源；启动时 `posix_memalign` + `memset(0)` 的只读零区，长度等于一个 `response_slot_bytes`，用于 miss 行。

资源粒度：`raw_verbs_transport.cc` 的构造函数每条 lane 都 `ibv_open_device` 一次，然后各自 `ibv_alloc_pd`、`ibv_create_cq(depth=4096)`、`ibv_reg_mr`、每对端一个 `ibv_create_qp`（`IBV_QPT_RC`，`max_send_wr=1024`、`max_recv_wr=1024`、`max_send_sge=32`、`max_recv_sge=1`）。这不是浪费而是必要：lane 重建要在 reset 后把该 CQ 彻底 drain，前提是这条 CQ 只有本 lane 的 QP 在投递。控制面通道也按同一粒度分配：`RawVerbsTransport::ControlPlane()` 每个 transport 实例一份，所以 16 lane 的客户端进程会惰性开出 16 条 gRPC channel（外加 `PetPSClient` 自己那条）。

注册尺寸以 lane 切片为准：`RawVerbsConfig::local_region_bytes` 的结构体默认值是 128 MiB，但 `MakeRawConfig` 的实参是 `ClientLaneBytes(config_)`（客户端）或 `ServerLaneBytes + response_slots * response_slot_bytes`（服务端），默认配置下客户端每条 lane 是 1 × (1 MiB + 1 MiB) = 2 MiB。`RcTransportConfig` 头文件里 `qps_per_client_per_shard = 32` 也只是默认值，实际由 flag（默认 16）覆盖。

本章涉及的文件与关键符号，按事实逐条列在章末「证据索引」，这里不重复。

## 交付一句

连接与内存注册到此交代完毕：全局偏移加原点换算、按 lane 切片注册、每条 lane 独占一套 verbs 资源。下一块接[第 3 块](./get)，讲一次读请求怎么走完这条 lane。
