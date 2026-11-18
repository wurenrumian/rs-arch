import { defineConfig } from 'vitepress'
import { mermaidToSvg } from './diagrams'

/**
 * 站点基线：上游 RecStore 1f340167d。
 * 部署在 rumian 聚合站点的 /rs-arch/ 子路径下，本地可用
 * VITEPRESS_BASE=/ 覆盖（`npm run dev` 会自动读这个变量）。
 */
const base = process.env.VITEPRESS_BASE || '/rs-arch/'

const REPO = 'https://github.com/wurenrumian/rs-arch'

type Item = { text: string; link: string }
type Group = { text: string; collapsed?: boolean; items: Item[] }

const ch01: Item[] = [
  { text: '阅读地图', link: '/ch01/' },
  { text: '1 · 仓库地图', link: '/ch01/repo-map' },
  { text: '2 · 三层调用链', link: '/ch01/call-chain' },
  { text: '3 · 读路径', link: '/ch01/read-path' },
  { text: '4 · 写路径与两种更新语义', link: '/ch01/write-path' },
  { text: '5 · 构建与打包', link: '/ch01/build' },
  { text: '6 · 配置与开关', link: '/ch01/config' },
  { text: '附录 · 术语与代码位置', link: '/ch01/appendix' },
  { text: '风险与未确认点', link: '/ch01/risks' },
  { text: '证据索引', link: '/ch01/evidence' }
]

const ch02: Item[] = [
  { text: '阅读地图', link: '/ch02/' },
  { text: '1 · op 入口', link: '/ch02/op-entry' },
  { text: '2 · 客户端与分片', link: '/ch02/client-shard' },
  { text: '3 · 读路径', link: '/ch02/read-path' },
  { text: '4 · 写路径与梯度提交', link: '/ch02/write-path' },
  { text: '5 · BagPipe 驻留', link: '/ch02/bagpipe' },
  { text: '6 · ps_pipeline', link: '/ch02/pipeline' },
  { text: '7 · 配置与开关', link: '/ch02/config' },
  { text: '附录 · 本章文件索引', link: '/ch02/appendix' },
  { text: '风险与未确认点', link: '/ch02/risks' },
  { text: '证据索引', link: '/ch02/evidence' }
]

const ch03: Item[] = [
  { text: '阅读地图', link: '/ch03/' },
  { text: '1 · 请求形状', link: '/ch03/request-shape' },
  { text: '2 · 客户端栈与选型', link: '/ch03/client-stack' },
  { text: '3 · 协议与命令', link: '/ch03/protocol' },
  { text: '4 · 分片与路由', link: '/ch03/sharding' },
  { text: '5 · 三条传输的共同骨架', link: '/ch03/common-skeleton' },
  { text: '6 · gRPC 路径', link: '/ch03/grpc' },
  { text: '7 · bRPC 路径', link: '/ch03/brpc' },
  { text: '8 · local_shm 路径', link: '/ch03/local-shm' },
  { text: '9 · 一致性与 checkpoint', link: '/ch03/consistency' },
  { text: '10 · 配置与开关', link: '/ch03/config' },
  { text: '附录 · 本章文件索引', link: '/ch03/appendix' },
  { text: '风险与未确认点', link: '/ch03/risks' },
  { text: '证据索引', link: '/ch03/evidence' }
]

const ch04: Item[] = [
  { text: '阅读地图', link: '/ch04/' },
  { text: '1 · 请求槽位协议', link: '/ch04/slot-protocol' },
  { text: '2 · 连接与内存注册', link: '/ch04/connect-mr' },
  { text: '3 · 一次 GET', link: '/ch04/get' },
  { text: '4 · 一次 PUT / UPDATE / INIT', link: '/ch04/put-update-init' },
  { text: '5 · 响应模式', link: '/ch04/response-modes' },
  { text: '6 · 控制面与部署', link: '/ch04/control-plane' },
  { text: '7 · 错误分层与恢复', link: '/ch04/errors' },
  { text: '8 · lane 生命周期与重建', link: '/ch04/lane-lifecycle' },
  { text: '9 · 不变量', link: '/ch04/invariants' },
  { text: '风险与未确认点', link: '/ch04/risks' },
  { text: '证据索引', link: '/ch04/evidence' }
]

const ch05: Item[] = [
  { text: '阅读地图', link: '/ch05/' },
  { text: '1 · 组合矩阵', link: '/ch05/composite-matrix' },
  { text: '2 · 索引', link: '/ch05/index-engine' },
  { text: '3 · 值存储', link: '/ch05/value-store' },
  { text: '4 · 分配器', link: '/ch05/allocator' },
  { text: '5 · 读路径', link: '/ch05/read-path' },
  { text: '6 · 写路径与退役', link: '/ch05/write-path' },
  { text: '7 · 分层策略', link: '/ch05/tiering' },
  { text: '8 · SSD 与 NVM', link: '/ch05/ssd-nvm' },
  { text: '9 · GPU 侧存储', link: '/ch05/gpu' },
  { text: '附录 · 配置与开关总表', link: '/ch05/appendix' },
  { text: '风险与未确认点', link: '/ch05/risks' },
  { text: '证据索引', link: '/ch05/evidence' }
]

const ch06: Item[] = [
  { text: '阅读地图', link: '/ch06/' },
  { text: '1 · 训练接入', link: '/ch06/training-integration' },
  { text: '2 · 其它模型与例子', link: '/ch06/model-examples' },
  { text: '3 · 测试地图', link: '/ch06/test-map' },
  { text: '4 · 基准地图', link: '/ch06/benchmark-map' },
  { text: '5 · 改动 → 验证路径', link: '/ch06/verification' },
  { text: '6 · 工程工具与文档构建', link: '/ch06/tooling' },
  { text: '附录 · 测试与基准清单', link: '/ch06/appendix' },
  { text: '风险与未确认点', link: '/ch06/risks' },
  { text: '证据索引', link: '/ch06/evidence' }
]

const sidebar: Group[] = [
  {
    text: '开始',
    items: [
      { text: '这个站怎么读', link: '/guide/' },
      { text: '启动与运行全景', link: '/guide/lifecycle' },
      { text: '十条核心事实', link: '/guide/facts' },
      { text: '术语表', link: '/guide/glossary' },
      { text: '代码索引', link: '/guide/code-index' }
    ]
  },
  { text: '01 · 系统总览、仓库地图与构建', collapsed: true, items: ch01 },
  { text: '02 · 计算层：PyTorch 集成与 BagPipe', collapsed: true, items: ch02 },
  { text: '03 · 参数服务器层：抽象、协议与传输', collapsed: true, items: ch03 },
  { text: '04 · RDMA 传输深潜', collapsed: true, items: ch04 },
  { text: '05 · 存储与内存', collapsed: true, items: ch05 },
  { text: '06 · 模型接入、测试、基准与工具', collapsed: true, items: ch06 },
  {
    text: '质量档案',
    collapsed: true,
    items: [
      { text: '风险总表', link: '/quality/risks' },
      { text: '已修复记录', link: '/quality/fixes' },
      { text: '文档与代码不一致', link: '/quality/doc-gaps' },
      { text: '未确认清单', link: '/quality/unknowns' }
    ]
  },
  {
    text: '维护',
    items: [{ text: '生成方式与版本基线', link: '/meta' }]
  }
]

/** 中文检索：把 CJK 连续串切成二元组，非中文按词切。索引与查询用同一个分词器。 */
const tokenize = (text: string) => {
  const out: string[] = []
  for (const chunk of text.toLowerCase().split(/[^\p{L}\p{N}_]+/u)) {
    if (!chunk) continue
    if (/[\u3400-\u9fff\u3040-\u30ff]/.test(chunk)) {
      if (chunk.length === 1) out.push(chunk)
      for (let i = 0; i < chunk.length - 1; i++) out.push(chunk.slice(i, i + 2))
    } else {
      out.push(chunk)
    }
  }
  return out
}

export default defineConfig({
  lang: 'zh-CN',
  title: 'RecStore 架构',
  description:
    'RecStore 的架构与设计讲解：稀疏 embedding 表为什么放在训练进程之外，读写如何跨进程落到参数服务器与存储引擎。',
  base,
  cleanUrls: true,
  lastUpdated: true,
  head: [
    ['link', { rel: 'icon', type: 'image/svg+xml', href: `${base}logo.svg` }],
    ['meta', { name: 'theme-color', content: '#0f6f63' }]
  ],

  markdown: {
    lineNumbers: false,
    theme: { light: 'github-light', dark: 'github-dark' },
    image: { lazyLoading: true },
    config: mermaidToSvg
  },

  themeConfig: {
    logo: '/logo.svg',
    siteTitle: 'RecStore 架构',

    nav: [
      { text: '总览', link: '/guide/', activeMatch: '^/guide/' },
      {
        text: '六章',
        items: [
          { text: '01 · 系统总览与构建', link: '/ch01/' },
          { text: '02 · 计算层', link: '/ch02/' },
          { text: '03 · 参数服务器与传输', link: '/ch03/' },
          { text: '04 · RDMA 深潜', link: '/ch04/' },
          { text: '05 · 存储与内存', link: '/ch05/' },
          { text: '06 · 测试与工具', link: '/ch06/' }
        ]
      },
      { text: '质量档案', link: '/quality/risks', activeMatch: '^/quality/' },
      { text: '维护', link: '/meta', activeMatch: '^/meta' }
    ],

    sidebar,

    outline: { level: [2, 3], label: '本页' },

    search: {
      provider: 'local',
      options: {
        translations: {
          button: { buttonText: '搜索文档', buttonAriaLabel: '搜索文档' },
          modal: {
            displayDetails: '显示详情',
            resetButtonTitle: '清空',
            backButtonTitle: '返回',
            noResultsText: '没有找到结果',
            footer: {
              selectText: '选择',
              navigateText: '切换',
              closeText: '关闭'
            }
          }
        },
        miniSearch: {
          options: {
            tokenize,
            searchOptions: { fuzzy: 0.15, prefix: true, boost: { title: 4, text: 2, titles: 3 } }
          }
        }
      }
    },

    docFooter: { prev: '上一块', next: '下一块' },
    darkModeSwitchLabel: '主题',
    sidebarMenuLabel: '目录',
    returnToTopLabel: '回到顶部',
    lastUpdated: {
      text: '最后更新',
      formatOptions: { dateStyle: 'medium', timeStyle: 'short' }
    },

    editLink: {
      pattern: `${REPO}/edit/main/docs/:path`,
      text: '在 GitHub 上改这一页'
    },

    socialLinks: [{ icon: 'github', link: REPO }],

    footer: {
      message: '按 calm-explain 组织的架构讲解 · 事实基线 RecStore 1f340167d',
      copyright: '只读文档，与上游代码仓库解耦维护'
    }
  }
})
