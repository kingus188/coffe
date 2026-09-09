# Agent Note: Coffe Fork 身份与上游署名

Status: implemented

[English](2026-09-09-coffe-upstream-attribution.md) | 中文

## 问题

Fork 的首页、支持链接和安装命令若只标识上游项目，会把用户引导到错误的维护者和安装包。另一方面，重命名所有继承的技术标识只会增加上游合并成本，不会增加运行能力。

## 决策

Coffe 在中英文 README 首屏及仓库元数据中明确标识为 DeepSeek Harness 的独立 Fork。[UPSTREAM.md](../../../../UPSTREAM.zh.md) 说明原作者、继承的实现、本地扩展和同步策略，完整保留 MIT 版权声明及上游历史。

公开仓库为 `kingus188/coffe`，`main` 是公开基线，`dev` 是集成开发分支。支持入口和文档源码链接指向 Coffe，历史引用和第三方来源保持原地址。安装通过源码仓库完成，内部包名和 `dsh` 命令保留为继承接口，明确区分上游 npm/桌面渠道与 Coffe 发行。

[Coffe CI](../../../../.github/workflows/coffe-ci.yml) 在 main/dev 推送和 Pull Request 时使用 GitHub 托管 Linux 运行器执行，无需模型凭据。它检查类型、文档和 PostgreSQL 测试，数据库测试要求 Docker 可用，不能通过跳过契约套件获得成功。既有上游发布机制不作为 Coffe 的发布渠道。

## 考虑过的替代方案

**替换所有 DeepSeek 名称和 URL。** 不采用，因为版权、历史来源、模型提供者地址及保留的包身份有不同的所有者和含义。

**保留原 README 的安装命令。** 不采用，因为它安装的是上游 npm 包，无法交付 Coffe 改动。

## 影响

读者能够识别项目来源和负责该 Fork 的维护者，保留源码兼容性有助于同步上游。独立 npm 包、桌面品牌、分发签名和正式文档托管需要各自完成发行工作，仓库改名不代表这些能力已经交付。
