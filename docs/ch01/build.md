---
title: 第 5 块：构建与打包
description: CMake 选项、第三方依赖与打包配置三者一起决定能否编出来。
outline: [2, 3]
---

## 它是什么

一套 CMake 顶层选项、一批必须存在的第三方依赖、一份 scikit-build-core 的打包配置。三者串起来决定"能不能编出来"和"编出来是什么形状"。

## 它为什么存在

依赖面比一般 C++ 项目宽：CUDA、gRPC、bRPC、folly、libtorch 都要在 configure 阶段找到。缺一个就失败，而失败信息往往指向一个不在仓库里的目录。先把这条约束讲清，能省掉一轮盲试。

## 它和谁接

上游是第 1 块的模块清单（选项决定哪些模块进构建），下游是第 6 块的运行时配置（编出来的二进制读哪些字段）。

## 代码位置

**目标（顶层选项）**

| 选项 | 默认 | 影响 |
| --- | --- | --- |
| `ENABLE_CUDA` | `ON` | 决定 `project(... LANGUAGES ... CUDA)`、CUDA arch（`RECSTORE_CUDA_ARCHITECTURES` 默认 `80;86`）、`storage/gpu_cache`、`framework/cache`、`executable/uvm` 是否构建 |
| `RECSTORE_ENABLE_GPU_CACHE` | `ON` | 与 CUDA 同时满足才构建 `framework/cache`，并定义 `RECSTORE_ENABLE_GPU_CACHE` |
| `RECSTORE_ENABLE_THIRD_PARTY_ENGINES` | `OFF` | 打开 `storage/external/fasterkv` 与 `storage/external/hps`；强制要求 `ENABLE_CUDA=ON`、`third_party/faster` 与递归初始化的 `third_party/HugeCTR`，否则 `FATAL_ERROR` |
| 其余开关 | 均 `OFF` | `USE_PERF_REPORT`（任意构建类型；打开后编 `report_client`，sink 由运行时 `observability` / 环境变量选择）、`USE_BRPC_CPU_PROFILER`（需 `libtcmalloc_and_profiler`）、`RECSTORE_ENABLE_HDRHISTOGRAM_PROGRAMS`（只影响 ycsb 的 CTest 注册）、`USE_FAKE_KVCLIENT`（`common/op_mock.cc` 替掉真实客户端）、`RECSTORE_ENABLE_TENSORFLOW`、`ENABLE_RDMA_INTEGRATION_TESTS`、`RECSTORE_ENABLE_SPDK`/`USE_PMKV`/`USE_PIBENCH` |

**依赖（缺一即 configure 失败）**：`OpenMP`、`Protobuf CONFIG`、`gRPC CONFIG`、`Torch`（`third_party/libtorch/libtorch/share/cmake/Torch`）、`folly CONFIG`、`gflags`、`glog`、`TBB`、`pybind11`、`Python >= 3.10`、`ZLIB`、`Threads`、`ibverbs`（RDMA 无条件构建）、以及 `bRPC` + 自定义 `protobuf`（`src/ps/brpc/CMakeLists.txt` 缺失时直接 `FATAL_ERROR`）。`jemalloc` 通过 `ExternalProject_Add` 跑 `autoconf` + `--with-jemalloc-prefix=je` 现场编译。`third_party` 分两类：`.gitmodules` 声明的 15 个子模块（`fmt`、`folly`、`glog`、`googletest`、`gperftools`、`json`、`grpc`、`HugeCTR`、`cpptrace`、`jemalloc`、`liburing`、`spdk`、`brpc`、`cityhash`、`faster`），以及代码里引用的**生成前缀**——不在仓库内，由 `dockerfiles/setup_centos7.sh` 等脚本产出：`third_party/grpc-install`、`protobuf-install`、`brpc-install`、`libtorch`、`leveldb`、`ycsb`、`glog/glog-install-fPIC`、`folly/folly-install-fPIC`。当前 Windows 检出这 8 个路径全部不存在，所以"仅 clone + cmake"必定失败，必须先跑环境装配脚本。folly 不再只是"配置阶段要找到"：`src/storage/kv_engine/CMakeLists.txt` 显式链 `Folly::folly`，`engine_composite.h` 直接 `#include <folly/SharedMutex.h>`，所以存储引擎的单测目标也依赖它。

最小构建（仍可跑 CPU 训练/PS 单测）：

```bash
cmake -DCMAKE_BUILD_TYPE=Release -DCMAKE_POLICY_VERSION_MINIMUM=3.5 \
      -DENABLE_CUDA=OFF -DRECSTORE_ENABLE_GPU_CACHE=OFF \
      -DRECSTORE_ENABLE_THIRD_PARTY_ENGINES=OFF ..
cmake --build . -j
```

即使最小构建也仍需全部生成前缀（folly/gRPC/bRPC/leveldb/libtorch/protobuf）与 `recstore_deps`（fmt/gflags/boost/TBB/OpenSSL）；可跳过的只有 `third_party/faster`、`HugeCTR`、`spdk`。全功能构建在此基础上加 `-DENABLE_CUDA=ON`、`-DRECSTORE_ENABLE_GPU_CACHE=ON`、`-DRECSTORE_ENABLE_THIRD_PARTY_ENGINES=ON`、`-DUSE_PERF_REPORT=ON`，按需 `RECSTORE_ENABLE_SPDK` / `USE_PMKV` / `ENABLE_RDMA_INTEGRATION_TESTS`，并递归初始化 `third_party/faster`、`third_party/HugeCTR`。

**打包（产物）**

- C++ 产物：`build/lib`（`lib_recstore_ops.so`、`libbrpc_ps_client.so`、`libdist_brpc_ps_client.so`、`liblocal_shm_ps_client.so`、`libwq_ps_client.so` …）与 `build/bin`（`ps_server`、`petps_server`、`local_shm_ps_server`、各类 `*_test`、`grpc_ps_bench`）。
- wheel：scikit-build-core 复用 `build/` 目录，只构建 `recstore_torch_ops`，只安装 `COMPONENT python`；扩展落到 `recstore/lib/`，runtime rpath 为 `$ORIGIN:$ORIGIN/../native`，非 torch 运行库按 soname 列表 vendored 进 `recstore/native/`（`src/framework/pytorch/CMakeLists.txt#_recstore_wheel_sonames`）。`libtorch*` / `libc10*` 故意不打包，`torch==2.7.1` 是硬运行依赖。
- 版本与分发：`VERSION` 是唯一来源；`configure_file` 把 `src/python/version_info.py.in` 渲染到构建树**和源码树** `src/python/pytorch/recstore/version_info.py`（configure 会写源码树，属已知副作用）。二进制分发用 `tools/packaging/pack_artifact.sh <out.tar.gz> <artifact...>` 收集可执行/`.so` 及其 `ldd` 依赖到 `bin/`、`lib/`、`deps/lib/` 并写 `manifest.txt`。

**静态注册**：`src/storage/kv_engine/kv_engine_register.cc#RecStoreForceLinkKVEngineRegistrations` 是给静态链接构建用的显式入口。该编译单元只放工厂注册与一个静态初始化器，静态库会把它丢掉，随后所有 `BaseKV` / index / value-store / allocator 查找在运行时报 "no Factory instance"；共享库构建靠 `--no-as-needed` 保持加载，不需要它。`benchmark_kv_engine.cc` 已显式调用。

## 交付一句

第 5 块到此为止：能编出来，且知道产物落在哪。下一块接配置，讲编出来的二进制运行时读哪些字段。
