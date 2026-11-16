---
title: 证据索引
description: 本章各条结论与支撑它的代码证据对照表，逐行给出文件与符号位置。
outline: [2, 3]
---

| 结论 | 证据 |
| --- | --- |
| 四类客户端由 `PSClientType` 枚举分派 | `src/ps/client_factory.cc#CreatePSClient`、`src/ps/client_options.h#PSClientType` |
| 单分片 grpc/brpc 也被合成为一分的 `distributed_client` | `src/framework/common/ps_client_config_adapter.cc#ResolvePSClientOptionsFromFrameworkConfig` |
| 服务端由工厂键选择 GRPC/BRPC 实现 | `src/ps/ps_server.cpp#main`、`src/ps/grpc/grpc_ps_server.cpp#GRPCParameterServer`、`src/ps/brpc/brpc_ps_server.cpp#BRPCParameterServer` |
| gRPC/bRPC 读走压缩包路径，shm/RDMA 走 flat 路径 | `grpc_ps_server.cpp#ParameterServiceImpl::GetParameter`（`GetParameterRun2Completion`）；`local_shm_server.cpp` 的 `GetParameterFlat`；`petps_server.cc` 的 `GetParameterDirectFixedRows` |
| `CachePS` 用 `ResolveEngine` + 工厂造 `BaseKV`，并造 `Optimizer` | `src/ps/base/cache_ps_impl.h#CachePS::CachePS` |
| 建表只注册 tag/形状，不填数据 | `src/ps/base/cache_ps_impl.h#CachePS::InitTable`、`src/optimizer/optimizer.cpp#SGD::Init` |
| 单分片监听地址来自 `cache_ps.servers`，缺失回退、非法 `FATAL` | `src/ps/base/shard_endpoint.h#SelectSingleShardEndpoint`、`grpc_ps_server.cpp#GRPCParameterServer::Run`、`brpc_ps_server.cpp#BRPCParameterServer::Run` |
| gRPC 读失败向上返回错误，不再静默补零 | `src/ps/grpc/grpc_ps_client.cpp#GRPCParameterClient::GetParameter`（`return -1` 分支）、`#set_deadline` |
| `max_batch_keys_size` 已废弃，只打 `WARNING` | `src/ps/base/cache_ps_impl.h#CachePS::CachePS`、`tools/config/recstore_config.schema.json` |
| 配置搜索顺序（服务端三段，`RECSTORE_CONFIG` 仅客户端）与异常吞掉 | `src/ps/ps_server.cpp#main`、`src/base/config.h#ResolveRecStoreConfigPath`、`src/framework/common/op_runtime_support.cc#GetGlobalConfig`（`catch (const std::exception&) { return json::object(); }`） |
| `gpu_memory` 未接入构建；生成前缀不在仓库内 | `src/gpu_memory/CMakeLists.txt` 存在但 `src/CMakeLists.txt` 无 `add_subdirectory(gpu_memory)`；顶层 `CMakeLists.txt` 引用 `third_party/grpc-install`、`protobuf-install`、`brpc-install`、`libtorch`、`glog/glog-install-fPIC`、`folly/folly-install-fPIC`，本地检出均不存在 |
| wheel 只装 python component，torch 不 vendored | `pyproject.toml#[tool.scikit-build]`、`src/framework/pytorch/CMakeLists.txt#install(TARGETS recstore_torch_ops ...)` |
| `VERSION` 是版本唯一来源 | `CMakeLists.txt#file(READ ... VERSION)`、`pyproject.toml#[[tool.dynamic-metadata]]`、`src/python/version_info.py.in` |
| 静态链接需要显式保留工厂注册 | `src/storage/kv_engine/kv_engine_register.cc#RecStoreForceLinkKVEngineRegistrations`、`src/storage/kv_engine/benchmark_kv_engine.cc` 调用点 |
