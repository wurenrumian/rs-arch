---
title: 第 7 块：bRPC 路径
description: bRPC 路径与 gRPC 的外部形状几乎一样，差别在 key 与梯度放到 attachment 里，不走 protobuf 字段。
outline: [2, 3]
---

bRPC 和 gRPC 在调用方看来几乎一样，区别藏在大载荷放在哪个字段里。这一页讲这批数据怎么绕过 protobuf、服务端又怎么把它捞出来。看完你能明白这条路径的批量上限为什么大得多，也能明白它为什么做不了 checkpoint。

## 它是什么

bRPC 路径与 gRPC 的外部形状几乎一样，差别在载荷怎么放。

请求构造时先在本地下一个内存池，按批创建请求与响应对象。key 与梯度写进 attachment，不走 protobuf 字段。服务端优先从 attachment 取，取不到才退回字段。发出是异步的，完成回调是空的，随后逐个等待调用 id。

## 它为什么存在

把大载荷从 protobuf 消息里挪出去，省掉一次拷贝，也让 65536 这个更大的批量上限可行。

代价有两处。一是两端都多了一层「先看 attachment」的判断。二是这份协议独立演化，因此缺了 checkpoint 命令。

## 它和谁接

上游同样是[第 4 块](./sharding)的分片层，下游是 bRPC 服务端。

超时与重试不在这条路径里自己管，交给 bRPC 的通道选项：默认 5000 ms、最多重试 3 次。

## 代码位置

1. 建通道：超时与重试由 `brpc::ChannelOptions{timeout_ms, max_retry}` 承担，默认 5000 ms / 3 次。
2. 客户端准备对象：构造 `google::protobuf::Arena`，按批创建请求与响应对象。
3. 客户端装载荷：key 写入 `controllers[i].request_attachment()`。
4. 客户端发出：对每批调用 `stub.GetParameter(..., done)` 异步发出，`done` 是空回调。
5. 客户端等结果：逐个 `brpc::Join(call_id)` 等待。
6. 客户端判失败：任一 `controllers[i].Failed()` 为真，直接返回 -1。
7. 服务端取载荷：`ExtractPayloadBytes` 优先取 `request_attachment`，把 key 交给 `CachePS`。
8. 服务端写结果：结果由 `compressor.AppendToIOBuf(&cntl->response_attachment())` 写回 attachment。
9. 客户端读结果：`ExtractGetResponseReader` 同样优先读 attachment，再用 `ParameterCompressReader::Valid` 校验长度后拷贝。
10. 其余差别：Put 在服务端逐 key 调用 `PutSingleParameter`，而 gRPC 是整批。
11. 其余差别：客户端支持 `options.use_rdma`（编译期 `BRPC_WITH_RDMA`，配置 `brpc_ps_use_rdma`），这是 bRPC 自身的传输选项，不是第 04 章的 raw-verbs 路径。
12. 其余差别：空载荷的处理比 gRPC 宽松，正常与预取路径都把它当作「该块无行」跳过，保持 0，不返回错误。

## 交付一句

bRPC 路径到此交代完毕：attachment 承载大载荷、内存池复用对象、更大的批量上限，以及协议里缺失的 checkpoint。下一块讲完全不走 socket 的共享内存路径。
