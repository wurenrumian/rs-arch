---
title: 第 1 块：请求槽位协议
description: 一块注册内存被切成定长格子，每格里装描述符、载荷，和一个 64 字节的完成标记。
outline: [2, 3]
---

这一页讲一条请求落在对端内存哪几个字节上，对方怎么知道它到齐了。答案只有几个固定偏移和两次写。

## 它是什么

两端只约定四件事：描述符放在哪、载荷从哪开始、就绪怎么写、完成怎么表示。

RDMA 的写是网卡直接送数据进对方内存，不经对方 CPU。一条 lane 是一条独立的 RC 连接：可靠有序，同一条连接上的写按发出顺序落地。

请求侧是 192 字节描述符加紧随其后的载荷，末尾 64 字节是提交字；描述符写明这次读什么、写什么。响应侧是载荷加末尾 64 字节状态字。两者都以普通写送达，只有提交字那次写等完成事件。

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

## 它为什么存在

「就绪」不靠消息，靠顺序。

RDMA 的写没有消息边界，只有字节落点。要让一串字节成为「一个请求」，最省的办法是末尾单独写提交字，拿连接顺序当屏障。

这省掉 fence 和握手。同一条 RC 连接上后发的写落在前一个之后，提交字又是独立的一次写：服务端看到它已就绪，描述符与载荷必然落地，不用内存屏障。客户端也不必等回执，一个状态字就够。响应侧同理，先载荷后状态字，看到完成即载荷完整。

格子定长还让寻址退化成乘加：服务端预先算好偏移，轮询只比一个整数。

## 它和谁接

上游是客户端槽位分配器：挑空闲槽位，按偏移填内容。下游是服务端扫描循环：轮询提交字，交给处理分支。[第 2 块](./connect-mr)讲注册与寻址，第 3、4 块讲读写两侧分支。

## 代码位置

- 描述符定长：`RequestDescriptor` 固定 192 字节、64 字节对齐（`static_assert`）。载荷永远从 `Align64(sizeof(RequestDescriptor)) == 192` 开始；`payload_offset` 只被 `ValidateRequestDescriptor` 做区间检查，服务端读取时用的是固定 192，不读这个字段。
- 两个控制字：请求端 `CommitWord{seq,state}`，响应端 `StatusWord{seq,state,status,response_bytes}`，各占 64 字节。两者 `seq` 必须相等、`state == kRcSlotDone`（`StatusWordDone`）才算完成。
- 提交顺序即协议：`SubmitRequest` 先把描述符与载荷拷进本地暂存槽位，再用一次不 signaled 的写送到对端请求槽位，最后单独写提交字（signaled）。提交前 `ResetStatusWord` 把响应状态重置为 `kPending`，避免上一轮的 `kDone` 被误认。
- 序号：`seq` 是 lane 本地单调序号，`SlotContext::next_seq` 从 1 开始。服务端同时看 `commit.seq != last_seq_[slot]` 与 `commit.state == READY`；重复 seq、seq==0、仍在 `inflight_seq_` 的槽位都跳过。跨 lane 不保证顺序。
- 释放：写提交字（`ClearRequestSlot` → `commit.state = 0`）。服务端不依赖释放信号推进状态，它靠 seq 变化识别新请求。

## 交付一句

至此交代完毕：192 字节描述符、两个 64 字节控制字、靠保序实现的就绪语义。下一块[第 2 块](./connect-mr)讲这些偏移的落点。
