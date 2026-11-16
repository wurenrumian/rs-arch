---
title: 风险、坑与未确认点
description: 近期与本轮已修复的问题，以及仍然存在的坑与未确认点。
outline: [2, 3]
---

## 近期已修复（5f92ba2a → 6d205e98）

| 问题 | 现在的行为 | commit |
| --- | --- | --- |
| 单分片服务端忽略 `cache_ps.servers`，只能听固定默认端口（gRPC `0.0.0.0:15000`，bRPC `--brpc_server_port`） | 单分片分支按 shard 解析 `servers` 的 `host`/`port`，缺失才回退默认地址 | `95616eef` |
| `cache_ps.max_batch_keys_size` 无 C++ 读者，改了没反应 | 字段标为 deprecated，`CachePS` 检测到打 `WARNING` 并忽略；schema 与 `docs/config.md`、`docs/usage/configuration.md` 已同步 | `5530c44a` |
| gRPC 读失败把清零结果当成功返回 | 客户端检查传输完成与每条 RPC `Status`，失败返回 `-1`；prefetch 失败终态化，不再返回半零行 | `e2efe502` |
| 同一张表混用两种更新语义会静默多乘/漏乘 `lr` | 首次使用的模式按 `(client, table)` 记录，改用另一种直接 `RuntimeError` | `f8dc8545` |

## 本轮已修复（6d205e98 → 7c44f83da）

| 问题 | 现在的行为 | commit |
| --- | --- | --- |
| `report()` 只有"远端 HTTP 或本地 JSONL"两条硬编码通道，口径与落盘位置不能配 | 顶层 `observability` 选 sink（`remote`/`csv`/`jsonl`/`glog`/`none`），环境变量可覆盖；`report_API` 作为兼容入口保留；`USE_PERF_REPORT` 不再限定 Debug | `0d4247de` |
| tiered 参数只认 `none`/`lru` | 新增 `clock` 与 `adaptive`，并对每个策略的旋钮逐项校验（预算、分片、队列上限、`expected_dram_bytes`） | `a8c8de32`、`c5155aaf` |
| 客户端与服务端的 `lr` 不可比对 | `UpdateParameterRequest` 与 local_shm 槽位头都带 `learning_rate`，服务端不一致即拒绝 | `606d86f5`、`8a63bfed` |
| 文档坏链只在部署时暴露 | PR 触及 `docs/**` 即跑 `mkdocs build --strict` | `4ccead0c` |

## 仍存在

1. **tag 只有 8 位。** `TAG_TYPE` 是 `uint8_t`，`MakeTensorTag` 在 `table_id * tensors_per_table + role > 255` 时抛异常；Python 侧把 tag 放在 bit 56-63，用户 key 实际只有 56 位可用。多个大 `table_id` 或 AdamW（`TensorsPerTable() == 4`）会更快撞上上限。
2. **两套更新语义仍并存。** 保护只在"同一张表混用"这一层：不同表各走一条仍是合法配置，但迁移时漏改一张表就会在建 `step()` 时抛 `RuntimeError`，且要整表切换而不能按 batch 逐步过渡。跨进程的第二道保护是服务端的 `CheckLearningRate`——只在客户端上报了 `lr` 且与服务端不同时生效；`lr` 为 0 的调用方仍靠自觉。`emb_update`（无 table 名）已在 C++ 侧直接抛 `deprecated`。
3. **配置读取失败被吞成默认值。** `GetGlobalConfig()` 捕获异常后 `return json::object()`，随后 `ResolveFrameworkPSClientType` 对空配置缺省 `GRPC`、transport 缺省 `127.0.0.1:15000`。配置文件写错路径时表现为"静默连本机默认端口"，启动照常成功。
4. **单分片 + 缺 shard 条目会直接退出。** `cache_ps.servers` 存在但没有当前 shard（默认 0）的条目、或字段类型不对时，服务端 `LOG(FATAL)` 而不是回退默认地址；旧配置只为多分片写了部分条目时，单分片启动会失败。
5. **离线加载与在线路由可能不一致。** `ShardManager::KeyPartition` 固定 `GetHash(key) % NumServers()`；在线路由在 `hash_method == "simple_mod"` 时用 `key % num_shards`。配了 `simple_mod` 后，`load_db` 写入的分片与训练读取的分片会错位。
6. **GPU cache 一致性靠清空兜底。** `CacheAwareOp::Update` 在更新抛异常时清整表；`push` / `emb_write` 无条件清表；`local_shm` 下 CPU ids 的 `local_update_flat` 也会清表。清表本身正确，但会造成命中率骤降，性能毛刺容易被误读为存储变慢。
7. **`src/gpu_memory` 是孤立模块。** 它有 `CMakeLists.txt`（`add_library(gpu_memory ...)`），但 `src/CMakeLists.txt` 从未 `add_subdirectory(gpu_memory)`，也没有任何 target 链接它，`memory_pool.cu.cc` 当前不参与构建。
8. **`src/ps/python_client/` 是遗留实现**（`client2.py` 里 `GetParameter` 返回桩数据），只被 `src/test/ps/python_client/*` 引用；真实客户端是 `src/python/pytorch/recstore`。
9. **未确认：Windows 支持与 `RECSTORE_ENABLE_THIRD_PARTY_ENGINES=ON` 的可构建性。** 前者：顶层 CMake 用 `autoconf` 构建 jemalloc、`-faligned-new`、`/tmp` 日志目录、`/dev/shm` 默认值，当前 Windows 检出无法本地验证，仓库构建文档全部以 CentOS 7 容器为前提。后者：要求 `third_party/faster` 与递归初始化的 `third_party/HugeCTR`，HPS 还依赖 CUDA cublas/curand/NVML 头；本轮未构建，只确认 CMake 前置校验会 `FATAL_ERROR`。
