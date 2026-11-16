---
title: 第 4 块：分片与路由
description: 路由回答的问题是 key 归谁，由 hash 决定，再按单次 RPC 上限二次切块。
outline: [2, 3]
---

## 它是什么

路由回答一个问题：这个 key 归谁。答案是 `hash(key) % num_shards`：`city_hash` 时 hash 为 CityHash64，`simple_mod` 时直接取 `key % num_shards`。分片层先用它把一批 key 分组，每组再按单次 RPC 的 key 上限切块，发给对应的单分片客户端。返回时顺序已乱，要靠事先记下的原始下标把行搬回原位。

## 它为什么存在

一次批量请求的 key 可能横跨所有 shard，而单次 RPC 又有 key 上限，两个约束叠在一起，就必须两级切分：先按 shard 切，再按上限切。没有第一级，请求会发错地方；没有第二级，单个 RPC 会超限。返回时必须回填原始行序，否则调用方拿到的张量行序和请求对不上，梯度会写到错误的行上。

## 它和谁接

上游是[第 2 块](./client-stack)的分片层外壳与[第 1 块](./request-shape)的 key 数组。下游是[第 5–8 块](./common-skeleton)的传输。它不关心载荷是读还是写，但读写两条路对失败的要求不同：读要求每块都与请求对得上，写不接受部分成功。

## 代码位置

在线路由：

- `dist_sharded_client.h#GetShardId`：`city_hash` 用 `GetHash(key) % num_shards_`（`src/base/hash.h#GetHash` 即 CityHash64），`simple_mod` 用 `key % num_shards_`；未知方法打日志后回退 `city_hash`。`shard_to_client_index_` 来自配置 `servers[].shard`，请求按逻辑 shard 选对应的单分片客户端。
- `shard_manager.h#ShardManager::KeyPartition` 用的是 `XPostoffice::NumServers()`，但只被 `storage/kv_engine/load_db.h` 的离线加载路径使用；在线客户端不走它。

服务端按 shard 部署：

- 判定条件是 `cache_ps.num_shards > 1`。多分片要求 `servers` 数量等于 `num_shards`，gRPC 在进程内为每个 `servers[]` 起一个线程，bRPC 为每个起一个 `brpc::Server`。
- 单分片时监听地址由 `src/ps/base/shard_endpoint.h#SelectSingleShardEndpoint` 解析：`cache_ps.servers` 存在则取其中对应 shard（默认 shard 0）的 `host`/`port`；`servers` 缺失时回退 gRPC 的 `0.0.0.0:15000`、bRPC 的 `0.0.0.0:<brpc_server_port>`；`servers` 存在但缺该 shard 或字段非法则抛异常，服务端 `LOG(FATAL)`。gRPC 的 `ParameterServiceImpl` 用解析出的 shard id（写进 checkpoint metadata），不再是常量 0。
- `-grpc_local_shard_id` / `-local_shard_id` 让一个进程只起指定 shard；该值不在 `servers` 里时 `LOG(FATAL)`。

跨 shard 的批拆分与结果合并：

- Get：按 shard 分区并记录原下标（`key_index_mapping_`），每个 shard 一次 `std::async`，shard 内按 `max_keys_per_request` 串行分块；全部完成后 `ScatterEmbeddingRows` 把「按 shard 顺序」的结果写回原行序；任一分片返回非 0 则整体返回 -1。
- Put / Update：先用 `GatherEmbeddingRows` 按原下标抽出每个 shard 的行，再按同样的 shard→chunk 顺序发送；任一分片失败即整体 -1，已发送的分片不回滚。
- SparseGradientCommit：按 `shard_to_client_index_.at(GetShardId(key))` 分桶，串行调用每个分片；即使某分片没有行也发一个结束标记（`dist_sharded_client.h#SparseGradientCommit` 注释明确「Every shard receives an end marker」）；返回值取所有分片的 `min(committed)`。
- Prefetch：分片层为每个 shard 的每个 chunk 生成子 prefetch id 并保存 `original_indices`；`GetPrefetchResult` 逐块读回并按下标散射。

## 交付一句

路由与两级切分到此交代完毕：一段哈希决定归属，两级切分决定单次 RPC 的大小，回填保证行序。下一块讲这些块送出去时共用的那套骨架。
