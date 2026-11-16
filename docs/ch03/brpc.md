---
title: 第 7 块：bRPC 路径
description: bRPC 路径与 gRPC 的外部形状几乎一样，差别在载荷怎么放。
outline: [2, 3]
---

## 它是什么

bRPC 路径与 gRPC 的外部形状几乎一样，差别在载荷怎么放。请求构造时先在本地下一个 Arena，按批创建请求与响应对象；key 与梯度写进 attachment，不走 protobuf 字段；服务端优先从 attachment 取，取不到才退回字段。发出是异步的，完成回调是空的，随后逐个等待调用 id。

## 它为什么存在

把大载荷从 protobuf 消息里挪出去，可以省掉一次拷贝，也让 65536 这个更大的批量上限可行。代价是两端都多了一层「先看 attachment」的判断，并且这份协议独立演化，因此缺了 checkpoint 命令。

## 它和谁接

上游同样是[第 4 块](./sharding)的分片层，下游是 bRPC 服务端。它的超时与重试交给 `brpc::ChannelOptions{timeout_ms, max_retry}`（默认 5000 ms / 3 次）。

## 代码位置

1. 客户端构造 `google::protobuf::Arena` 按批创建请求/响应；key 写入 `controllers[i].request_attachment()`。
2. 对每批调用 `stub.GetParameter(..., done)` 异步发出，`done` 是空回调；随后逐个 `brpc::Join(call_id)` 等待，任一 `controllers[i].Failed()` 直接返回 -1。
3. 服务端 `ExtractPayloadBytes` 优先取 `request_attachment`，把 key 交给 `CachePS`；结果 `compressor.AppendToIOBuf(&cntl->response_attachment())`。客户端 `ExtractGetResponseReader` 同样优先读 attachment，再用 `ParameterCompressReader::Valid` 校验长度后拷贝。
4. 其余差别：Put 在服务端逐 key 调用 `PutSingleParameter`，而 gRPC 是整批；客户端支持 `options.use_rdma`（编译期 `BRPC_WITH_RDMA`，配置 `brpc_ps_use_rdma`），这是 bRPC 自身的传输选项，不是第 04 章的 raw-verbs 路径。
5. 空 payload 的处理比 gRPC 宽松：正常与预取路径都把它当作「该块无行」跳过，保持 0，不返回错误。

## 交付一句

bRPC 路径到此交代完毕：attachment 承载大载荷、Arena 复用对象、更大的批量上限，以及协议里缺失的 checkpoint。下一块讲完全不走 socket 的共享内存路径。
