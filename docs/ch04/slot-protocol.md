---
title: 第 1 块：请求 slot 协议
description: 两端对一块内存的约定只有四件事：描述符放在哪、载荷从哪开始、就绪怎么写、完成怎么表示。
outline: [2, 3]
---

## 它是什么

两端对一块内存的约定只有四件事：描述符放在哪、载荷从哪开始、就绪怎么写、完成怎么表示。请求侧是一段 192 字节的描述符加紧随其后的载荷，最后 64 字节是 commit 字；响应侧是一段载荷，最后 64 字节是 status 字。描述符与载荷都用普通 RDMA WRITE 写过去，只有 commit 字那一次写是 signaled，也就是它要等一个完成事件。

```text
lane_base + slot_in_qp * (resp + req)
├── response slot  [0 .. resp)
│   ├── payload            @ 0
│   └── StatusWord         @ resp - 64     (kRcSlotDone 表示 payload 已可读)
└── request staging slot
    ├── RequestDescriptor  @ 0             (192 字节, alignas(64))
    ├── payload            @ Align64(192)  (固定 192)
    └── CommitWord         @ req - 64
```

「就绪」不靠消息，靠顺序：commit 字是独立的一次写，跑在同一个 RC 连接上，而 RC 连接保序，所以服务端看到 commit 状态是就绪时，描述符与载荷一定已经落地。响应方向同理，先写载荷再写状态字，客户端看到完成状态就等于载荷完整。

## 它为什么存在

RDMA 的写操作没有「消息边界」，只有字节落点。要给一串字节赋予「这是一整个请求」的含义，最省的办法是在末尾补一个控制字，用连接保序当作隐式屏障。这样两端都不需要额外的 fence，也不需要应用层握手。slot 固定长度则让寻址退化成一次乘加，服务端可以预先把每个 slot 的偏移算好，轮询时只比一个整数。

## 它和谁接

上游是客户端的 slot 分配器：它先挑一个空闲 slot，再按固定偏移填描述符与载荷。下游是服务端的扫描循环：它按 slot 偏移轮询 commit 字，取出请求后交给处理分支。[第 2 块](./connect-mr)讲这块内存怎么被注册与寻址，第 3、4 块讲两个方向的处理分支。

## 代码位置

- `RequestDescriptor` 固定 192 字节、64 字节对齐（`static_assert`）。载荷永远从 `Align64(sizeof(RequestDescriptor)) == 192` 开始；`payload_offset` 只被 `ValidateRequestDescriptor` 做区间检查，服务端读取时用的是固定 192，不读这个字段。
- 每个 slot 两端各有一个 64 字节控制字：请求端 `CommitWord{seq,state}`，响应端 `StatusWord{seq,state,status,response_bytes}`。两者 `seq` 必须相等、`state == kRcSlotDone`（`StatusWordDone`）才算完成。
- 提交顺序即协议：`SubmitRequest` 先把描述符与载荷拷进本地 staging slot，再用一次 unsignaled WRITE 送到对端请求 slot，最后单独写 commit（signaled）。提交前 `ResetStatusWord` 把响应状态重置为 `kPending`，避免上一轮的 `kDone` 被误认。
- `seq` 是 lane 本地单调序号，`SlotContext::next_seq` 从 1 开始。服务端同时看 `commit.seq != last_seq_[slot]` 与 `commit.state == READY`；重复 seq、seq==0、仍在 `inflight_seq_` 的 slot 都跳过。跨 lane 不保证顺序。
- slot 释放是写 commit 字（`ClearRequestSlot` → `commit.state = 0`）。服务端不依赖释放信号推进状态，它靠 seq 变化识别新请求。

## 交付一句

slot 协议到此交代完毕：192 字节描述符、两个 64 字节控制字、靠保序实现的就绪语义。下一块接[第 2 块](./connect-mr)，讲这些偏移落在哪块已注册内存上。
