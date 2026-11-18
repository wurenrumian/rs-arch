---
layout: home

hero:
  name: RecStore 架构
  text: 稀疏 embedding 表为什么在训练进程之外
  tagline: 六章 47 块，按“先骨架、再逐块”的节奏拆开：一次读写的调用链、参数服务器的四种传输、存储分层，以及改动之后怎么验证。
  image:
    src: /hero.svg
    alt: RecStore 的三层结构：训练进程、参数服务器、存储层
  actions:
    - theme: brand
      text: 从第 01 章开始
      link: /ch01/
    - theme: alt
      text: 先看十条核心事实
      link: /guide/facts
    - theme: alt
      text: 风险总表
      link: /quality/risks

features:
  - title: 01 · 系统总览、仓库地图与构建
    details: 仓库里 12 个一级模块各管什么，一次 EmbRead / EmbUpdate 怎么跨进程走完，CMake 与配置从哪来。
    link: /ch01/
    linkText: 6 块
  - title: 02 · 计算层：PyTorch 集成与 BagPipe
    details: op 注册、KVClient 与分片客户端、两条更新语义，以及 BagPipe 的“参数在 PS、GPU 上只有有界缓存”。
    link: /ch02/
    linkText: 7 块
  - title: 03 · 参数服务器层与传输
    details: 请求形状、客户端工厂、proto 命令，gRPC / bRPC / local_shm 三条路径的分歧点，分片与 checkpoint。
    link: /ch03/
    linkText: 10 块
  - title: 04 · RDMA 传输深潜
    details: 槽位协议、内存注册、两条 GET 响应模式、lane 重建与错误分层——性能上限和故障边界都在这里。
    link: /ch04/
    linkText: 9 块
  - title: 05 · 存储与内存
    details: 组合矩阵、索引与值存储、slab 分配器、读写下路径，以及 none / lru / clock / adaptive 四种分层策略。
    link: /ch05/
    linkText: 9 块
  - title: 06 · 模型接入、测试、基准与工具
    details: rs_demo 怎么接、测试与基准各覆盖什么、改一处代码该跑哪几条验证、文档门禁在哪。
    link: /ch06/
    linkText: 6 块
---

## 一句话

RecStore 把推荐模型的稀疏 embedding 表放到训练进程之外：Python 侧经 `torch.ops.recstore_ops` 调用进程内单例，
按 `ps_type` 构造 gRPC / bRPC / RDMA / local_shm 分片客户端，把按 key 哈希切分的请求发到参数服务器进程；
服务端把读写翻译成对本地 KV 引擎的批量操作。

<div class="rs-layers">
  <div class="rs-layer">
    <b>计算层</b>
    <span>训练进程：模型、Python 客户端、op 运行时、传输客户端</span>
  </div>
  <div class="rs-layer">
    <b>参数服务器</b>
    <span>独立服务进程：按 key 哈希分片，持有表元数据与优化器</span>
  </div>
  <div class="rs-layer">
    <b>存储层</b>
    <span>同进程内的引擎：索引 + 值存储 + 分配器，默认全在 DRAM</span>
  </div>
</div>

三段之间只有一次真正的跨进程：传输客户端到服务实现。其余都是同进程调用，只是类型上过了一层抽象。

## 从哪里开始

<div class="rs-cards">
  <RsCard to="/guide/lifecycle" title="启动与运行全景">一张图看完构建、启动、建表与稳态训练：谁先起、谁等谁、哪一跳跨进程。</RsCard>
  <RsCard to="/guide/" title="这个站怎么读">阅读约定、证据标签、三条按目标划分的路线。</RsCard>
  <RsCard to="/guide/glossary" title="术语表">每个概念只有一个名字：概念名、一句话定义、对应的代码符号。</RsCard>
  <RsCard to="/guide/code-index" title="代码索引">仓库目录 ↔ 章节的对照表，想改哪里直接跳到对应块。</RsCard>
  <RsCard to="/guide/facts" title="十条核心事实">六章共同核对过的结论，先记住这十条，再看细节。</RsCard>
  <RsCard to="/quality/risks" title="风险总表">15 条按影响面排序的坑：静默补零、无幂等重试、名不副实的持久化。</RsCard>
</div>

## 事实基线

本站正文按 RecStore 上游 `upstream/main` 的 `1f340167d` 核对，写作方式是
<strong>阅读地图 + 分块推进</strong>：每章开头先给部件表与概念表，然后一块一块展开，每块只回答一件事。

<div class="rs-meta">
  <span class="rs-badge">1f340167d</span> 代码在
  <a href="https://github.com/RecStore/RecStore">RecStore/RecStore</a>；
  本站不构建、不运行它，正文里的 <code>相对路径#符号</code> 都是对照源码读出来的。
</div>
