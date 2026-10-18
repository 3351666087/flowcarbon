<p align="center">
  <img src="docs/media/flowcarbon-zh.svg" alt="FlowCarbon：一栋模拟写字楼被逐层感知，规则识别浪费，AI 解释原因，按合同能源管理算账，并出具范围二报告" width="100%">
</p>

<p align="center">
  <a href="README.md">English</a> · <b>简体中文</b>
</p>

<p align="center">
  <a href="https://github.com/3351666087/flowcarbon/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/3351666087/flowcarbon/actions/workflows/ci.yml/badge.svg"></a>
  <a href="https://github.com/3351666087/flowcarbon/releases"><img alt="Release" src="https://img.shields.io/github/v/release/3351666087/flowcarbon?color=0d7068&label=release"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-Apache--2.0-0d7068"></a>
  <a href="docs/deployment.md"><img alt="Docker images" src="https://img.shields.io/badge/ghcr.io-server%20%7C%20web-0d7068?logo=docker&logoColor=white"></a>
  <img alt="Node 22" src="https://img.shields.io/badge/node-22-0d7068?logo=node.js&logoColor=white">
  <img alt="TypeScript" src="https://img.shields.io/badge/TypeScript-strict-0d7068?logo=typescript&logoColor=white">
</p>

# FlowCarbon

**按楼层人数管理写字楼下班后的能耗与碳排。**

写字楼按固定排程整层供冷、亮灯。到了晚上和周末，楼里没人的楼层照样在花钱；少数加班的人反而常常没有空调。
FlowCarbon 数清每一层有多少人，找出楼层在没人时仍在供冷或亮灯的时段，预测下班后的人数，让租户只为自己的楼层申请加时供冷，
并按合同能源管理把节省算清楚。每个数字都能追溯到背后的规则和数据。

> **当前状态：0.1。** 计算引擎、数据平台、API、后台任务和网页端都已实现并完成端到端测试。
> 仓库自带的数据全部是**模拟数据**，不对应任何真实楼宇。

## 能做什么

<table>
  <tr>
    <td width="33%" valign="top"><b>感知</b><br>门禁计数得出每层人数，楼宇自控状态和分项电表说明什么在运行、花了多少钱。每一度电都标明是<i>实测</i>还是<i>估算</i>。</td>
    <td width="33%" valign="top"><b>识别</b><br>四条有物理含义的规则，每个阈值都写明依据；每个时段的能耗最多只算进一条规则，合计不会重复。</td>
    <td width="33%" valign="top"><b>解释</b><br>Claude 解释机会点，只从策略库里推荐一个动作，只引用固定清单里的依据。规则判断，AI 解释，人来决定。</td>
  </tr>
  <tr>
    <td valign="top"><b>预测与模拟</b><br>未来 7 天每层下班后的人数预测；按日类型把节能量外推到全年；合同能源管理分成、回本期和净现值。</td>
    <td valign="top"><b>报告</b><br>用电量和范围二排放（基于位置、基于市场两种方法），注明排放因子来源，支持 CSV 导出和冻结快照。</td>
    <td valign="top"><b>运营</b><br>多租户，PostgreSQL 行级安全隔离数据；角色权限和租户范围限制；给楼宇网关用的 API Key；审计日志与监控指标。</td>
  </tr>
</table>

<p align="center">
  <img src="docs/images/floors.jpg" alt="楼层总览：每层实时状态与近 28 天数据" width="49%">
  <img src="docs/images/opportunity.jpg" alt="机会点详情：证据、当天楼层曲线与 AI 解释" width="49%">
</p>
<p align="center"><sub>截图来自自带的模拟楼宇 “Tower A”，不涉及任何真实楼宇或个人。网页端支持中英文切换。</sub></p>

## 系统结构

```mermaid
flowchart LR
  subgraph building["楼宇（模拟）"]
    door[门禁计数]
    bms[楼宇自控 / 空调状态]
    meter[分项电表]
  end
  door & bms & meter -->|API Key · 幂等批次| api
  web["网页端 · Next.js<br/>中文 / English"] -->|会话 Cookie| api
  api["API · Fastify<br/>权限 · 审计 · OpenAPI"] --> db[("PostgreSQL 17 + TimescaleDB<br/>行级安全")]
  api -->|任务| queue[["pg-boss"]]
  queue --> worker["后台任务<br/>时段计算 · 规则 · 预测"]
  worker --> db
  worker -->|结构化输出| claude["Claude<br/>只解释，不做决定"]
```

## 设计原则

1. **规则判断，AI 解释。** 浪费由有物理含义的规则识别，每个阈值都有书面依据。AI 只解释并从固定策略库里推荐一个动作，
   不做决定，也不改任何楼宇设置。
2. **估算不冒充实测。** 每个能耗数字都标明数据档位：`measured`（来自分项电表）或 `estimated`（额定功率 × 运行时长）。
3. **先算钱，再算碳。** 业主按电费做决定。范围二同时按基于位置和基于市场两种方法报告，并注明因子来源。
   这是能源与碳报告，为 ESG 报告的环境部分提供数据，本身不是 ESG 报告。
4. **从第一天起就是多租户。** 每个组织的数据由数据库本身隔离，应用运行时使用的账号无法绕过。

## 一条命令跑起来

```bash
docker compose -f infra/docker-compose.yml --profile app up -d --build
DEMO_PASSWORD='自己设一个密码' docker compose -f infra/docker-compose.yml --profile demo run --rm seed
open http://localhost:3000        # 用 manager@flowcarbon-demo.example 登录
```

预构建镜像：`ghcr.io/3351666087/flowcarbon-server` 和 `ghcr.io/3351666087/flowcarbon-web`（支持 linux/amd64 与 linux/arm64）。
API 文档在 `http://localhost:4000/api/v1/docs`。生产部署见[部署文档](docs/deployment.md)（英文）。

## 四条规则

| 规则 | 类型 | 检查什么 |
|---|---|---|
| `hvac_unrequested_non_working` | 浪费 | 周末或节假日，某层在本层申请之外仍在供冷且无人，同时有其他楼层申请了加时。 |
| `hvac_empty_floor` | 浪费 | 楼层无人超过宽限期（默认 30 分钟）后仍在供冷。 |
| `lights_on_empty_night` | 浪费 | 夜间楼层无人，照明仍高于安防照度。 |
| `full_floor_few_people` | 优化空间 | 人数低于阈值却开了全层供冷，区域节能档即可满足。 |

上班前的预冷和到岗时段不计入。阈值及依据见 [`packages/core/src/rules.ts`](packages/core/src/rules.ts)。

## 技术栈

| 层 | 选型 |
|---|---|
| 语言 | TypeScript（严格模式）、Node.js 22、npm workspaces |
| 数据 | PostgreSQL 17、TimescaleDB 2.30（超表、压缩）、Drizzle ORM、行级安全 |
| API | Fastify 5、zod、OpenAPI 3.1、argon2id、Prometheus 指标 |
| 任务队列 | pg-boss 12 |
| AI | 通过 Anthropic SDK 调用 Claude（结构化输出、拒答时服务端回退） |
| 网页 | Next.js 16、React 19、Tailwind CSS 4、TanStack Query、Recharts |
| 交付 | Docker 镜像、Docker Compose、GitHub Actions 持续集成与发布 |

## 目录结构

| 路径 | 内容 |
|---|---|
| `packages/core` | 纯计算引擎：日历、门禁人数、15 分钟楼层时段、规则、预测、策略与合同能源管理测算、加时申请、电价、范围二、报告。不做任何 I/O。 |
| `packages/sim` | 可复现的 12 层写字楼模拟器，用于开发、测试和演示。 |
| `packages/db` | 数据库结构与迁移：超表、行级安全、运行时账号授权、共享排放因子库。 |
| `packages/pipeline` | 基于数据库的数据处理：接入、时段重算、日汇总、识别、预测、报告和策略。 |
| `packages/security` | argon2id 密码哈希、令牌、API Key。 |
| `packages/jobs` | 任务队列定义、只由数据库所有者执行的安装、运行时客户端。 |
| `packages/demo` | 通过真实接入流程生成演示组织。 |
| `apps/api` | HTTP API。 |
| `apps/worker` | 后台任务与 AI 解释。 |
| `apps/web` | 网页端。 |
| `docs/` | [架构](docs/architecture.md)、[部署](docs/deployment.md)、[架构决策记录](docs/adr/)（英文）。 |

## 本地开发

需要 Node.js 22 和 Docker。所有配置都是环境变量，见 [`.env.example`](.env.example)。

```bash
npm install
npm run db:up                    # 在 localhost:5432 启动 PostgreSQL 17 + TimescaleDB
export DATABASE_URL=postgres://flowcarbon:flowcarbon-dev@localhost:5432/flowcarbon
npm run db:migrate               # 迁移、共享参考数据、任务队列
DEMO_PASSWORD='自己设一个密码' npm run seed -- --reset   # 生成模拟的 Tower A，近 28 天
DATABASE_URL=postgres://flowcarbon_app:flowcarbon-app-dev@localhost:5432/flowcarbon npm run dev:api
DATABASE_URL=postgres://flowcarbon_app:flowcarbon-app-dev@localhost:5432/flowcarbon npm run dev:worker   # ANTHROPIC_API_KEY 可选
npm run dev -w @flowcarbon/web   # http://localhost:3000
npm test                         # 设置 TEST_DATABASE_URL 后会包含数据库和 API 测试
npm run lint
```

`TEST_DATABASE_URL` 需指向数据库服务的所有者账号，例如 `postgres://flowcarbon:flowcarbon-dev@localhost:5432/postgres`。
每次测试都会新建并删除自己的数据库，并以无特权的应用账号运行，行级安全是真实测试过的。

`npm run snapshot -- --out snapshot.json` 会为 README 用的时间窗口建一个临时数据库，跑完整条流水线，导出一个自包含的
JSON 文件（楼层、每日汇总、带证据的机会点、预测、策略与合同能源管理、两种口径的范围二报告、排放因子、设备）。设置了
`ANTHROPIC_API_KEY` 时，还会为每条规则里电量最大的机会点生成中英文 AI 解释。静态原型和评审用它，不必跑整套服务。

README 顶部的动画由 `node scripts/hero/build-hero.mjs` 生成（文案在 `scripts/hero/strings.mjs`），仓库的社交分享封面由 `node scripts/hero/build-poster.mjs` 生成。

## 参与贡献与安全

见 [CONTRIBUTING.md](CONTRIBUTING.md) 和 [SECURITY.md](SECURITY.md)（英文）。版本变更见 [CHANGELOG.md](CHANGELOG.md)。

## 许可证

Apache License 2.0，见 [LICENSE](LICENSE)。
