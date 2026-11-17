---
title: 第 4 块：分片与路由
description: 一段哈希决定 key 归哪个分片，超长的批再按单次 RPC 上限切块，返回时按原下标把行搬回去。
outline: [2, 3]
---

一次批量请求的 key 常常横跨好几个分片，而单次 RPC 又有 key 数量上限。这一页讲这两级切分各在哪一步发生，返回的行又靠什么搬回原顺序。读完你能判断某个 key 落在哪个分片，也能解释写入为什么整批失败。

## 它是什么

路由只回答一个问题：这个 key 归谁。默认做法是先把 key 过一次哈希，再对分片数取余。配置成另一种方法时，直接拿 key 对分片数取余。

分片层用这个结果把一批 key 分成几组，再按单次 RPC 的 key 上限切块，然后逐块发给对应分片的客户端。四步：

1. 算归属：逐个 key 算出分片号。
2. 分桶：把 key 和它的原始下标一起放进那个分片的桶。
3. 切块：桶里的 key 超过单次上限，就按上限切成若干块。
4. 发送：每块发给该分片的客户端。

返回时顺序已经乱了。分片层按第 2 步记下的下标把行搬回原位。

## 它为什么存在

两个约束逼出两级切分。

1. 一次批量请求的 key 可能横跨所有分片。少了第一级，请求会发错地方。
2. 单次 RPC 有 key 上限。少了第二级，单个 RPC 会超限。

返回时也必须回填原始行序。不回填，调用方拿到的张量行序就和请求对不上，梯度会写到错误的行上。

## 它和谁接

上游是[第 2 块](./client-stack)的分片层外壳，和[第 1 块](./request-shape)给出的 key 数组。下游是[第 5–8 块](./common-skeleton)的传输。

分片层不关心载荷是读还是写，但两条路对失败的要求不同：读要求每块都和请求对得上，写不接受部分成功。

## 代码位置

在线路由：

| 角色 | 位置 |
| --- | --- |
| 分片号怎么算 | `dist_sharded_client.h#GetShardId`：等价于 `hash(key) % num_shards`；`city_hash` 走 `GetHash(key) % num_shards_`，`simple_mod` 走 `key % num_shards_` |
| 未知方法怎么办 | 打日志后回退 `city_hash` |
| 哈希函数本体 | `src/base/hash.h#GetHash`，即 CityHash64 |
| 分片到客户端的映射 | `shard_to_client_index_`，来自配置 `servers[].shard`；请求按逻辑分片选对应的单分片客户端 |
| 离线用的另一套分区 | `shard_manager.h#ShardManager::KeyPartition` 用 `XPostoffice::NumServers()`，只被 `storage/kv_engine/load_db.h` 的离线加载路径使用，在线客户端不走它 |

服务端按分片部署：

| 角色 | 位置 |
| --- | --- |
| 是否多分片 | 判定条件是 `cache_ps.num_shards > 1`；多分片要求 `servers` 数量等于 `num_shards` |
| 多分片怎么起 | gRPC 在进程内为每个 `servers[]` 起一个线程，bRPC 为每个起一个 `brpc::Server` |
| 单分片的监听地址 | `src/ps/base/shard_endpoint.h#SelectSingleShardEndpoint`：`cache_ps.servers` 存在则取其中对应分片（默认分片 0）的 `host`/`port` |
| 没有 `servers` 时 | 回退 gRPC 的 `0.0.0.0:15000`、bRPC 的 `0.0.0.0:<brpc_server_port>` |
| `servers` 存在但缺该分片或字段非法 | 抛异常，服务端 `LOG(FATAL)` |
| checkpoint 里的分片号 | gRPC 的 `ParameterServiceImpl` 用解析出的分片号（写进 checkpoint 元数据），不再是常量 0 |
| 一个进程只起指定分片 | `-grpc_local_shard_id` / `-local_shard_id`；该值不在 `servers` 里时 `LOG(FATAL)` |

跨分片的批拆分与结果合并，按路径分开看。

Get：

1. 按分片分区，把每个 key 的原始下标记进 `key_index_mapping_`。
2. 每个分片起一次 `std::async`。
3. 分片内按 `max_keys_per_request` 串行分块发送。
4. 全部完成后用 `ScatterEmbeddingRows` 把「按分片顺序」的结果写回原行序。
5. 任一分片返回非 0，整体返回 -1。

Put / Update：

1. 先用 `GatherEmbeddingRows` 按原下标抽出每个分片的行。
2. 再按同样的 分片 → 块 顺序发送。
3. 任一分片失败即整体 -1，已发送的分片不回滚。

SparseGradientCommit：

1. 按 `shard_to_client_index_.at(GetShardId(key))` 把梯度分桶。
2. 串行调用每个分片；某分片没有行也发一个结束标记。`dist_sharded_client.h#SparseGradientCommit` 的注释原话是「Every shard receives an end marker」。
3. 返回值取所有分片的 `min(committed)`。

Prefetch：

1. 为每个分片的每个块生成子 prefetch id，并保存 `original_indices`。
2. `GetPrefetchResult` 逐块读回，按 `original_indices` 散射到原位置。

## 交付一句

路由与两级切分到此交代完毕：一段哈希决定归属，两级切分决定单次 RPC 的大小，回填保证行序。下一块讲这些块送出去时共用的那套骨架。
