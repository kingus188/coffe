# Agent Note: PostgreSQL 会话持久化后端

Status: implemented

[English](2026-09-09-postgres-session-persistence-backend.md) | 中文

## 问题

唯一已发布的 `SessionPersistence` 后端 `dsh-session-persistence-jsonl` 在本地文件系统根目录下为每个会话保存一个文件。需要集中查询会话，或让多个应用实例共享持久存储而非各自拥有本地磁盘的部署，缺少可挂载的第一方后端。能力接口支持这种替换，见 `docs/architecture.md` 的能力接口设计，但尚无已发布后端在真实外部数据库上实现它。

## 决策

`dsh-session-persistence-postgres` 在可配置 schema 下，基于 PostgreSQL 的 `coffe_session`、`coffe_session_event` 和下文的派生表 `coffe_message`，实现相同的 `SessionPersistence`/`SessionHandle` 契约。挂载时可直接替代 JSONL 后端；agent-loop 及其他消费者仅依赖能力接口，因此不受影响。

部署数据库命名为 `coffe`，用于保存整个 Agent 的运行数据。会话后端只拥有三张 `coffe_` 表及其索引和约束，不拥有整个数据库或 schema。其他插件的数据可以共享该命名空间，无需扩大本插件的服务职责。数据库的创建和重命名属于部署操作，通过 `connectionString` 选择目标库。

初始化在一个事务中原地重命名旧的 `dsh_session_header`、`dsh_session_event`、`dsh_session_message` 表及标准约束和索引。事务级咨询锁让多个实例串行初始化。新旧表名冲突时明确报错，DDL 失败则回滚整次重命名。沿用相同 PostgreSQL 表身份可保留数据和外键依赖；创建空的新表会使已有会话无法访问，因此不采用此升级方式。重命名前必须停止旧客户端，已保存的 Session 格式不变。

相同迁移也接受中间命名 `agent_session`、`agent_session_event`、`agent_message`。每个目标最多只能存在一张来源表或目标表，避免静默选择或合并并存数据。`coffe_` 前缀标识共享运行库所属的应用，每张表保留其数据领域名称。

PostgreSQL 18 将具名的 `NOT NULL` 约束存储在 `pg_constraint` 中。初始化按每张表的旧前缀重命名其约束，包括这些名称；对于已经改名的表也会再次执行名称修正。若只重命名主键和外键，PostgreSQL 18 的元数据中仍会留下旧前缀。

有两点刻意不与 JSONL 保持一致：

- **跨进程所有权使用 Postgres 会话级咨询锁**：通过按会话 id 哈希定位的 `pg_try_advisory_lock` 实现，而非内核文件锁。它保证共享数据库的多个应用实例间，每个会话只有一个写入者，这是选择此后端的实际原因；本地文件锁无法提供这种保证。
- **没有历史格式迁移**：后端仅读写当前 `SessionEvent` 格式，不包含 JSONL 的 v0/v1/v2 目录、迁移准备或 Zstandard 解码机制。从 JSONL 迁出的部署在此处创建新会话，已有历史保留在原后端，两种后端之间没有会话日志迁移路径。

每次持久写入，包括首次落库插入、事件插入和头部修订号更新，均在同一个 Postgres 事务内完成，因此没有撕裂尾部修复路径：中途崩溃仅留下完整旧状态或新状态，不会向读取者暴露部分提交。表结构和每次写入一个事务替代了 JSONL 的大部分存储机制，包括字节级落库、基于 `link()` 的发布、租约文件和 Zstandard 分帧。

PostgreSQL Bind 协议每条语句最多允许 65,535 个参数。事件和消息 INSERT 按参数数拆分，每次追加仍仅使用一个事务并增加一次修订号。后续语句失败会回滚前面的全部语句，包括延迟创建的头部；逐批独立提交会违反追加的持久性保证。

其余运行结构与 JSONL 对应：`PostgresSessionHandle` 拥有相同的逐句柄变更链和有界实时合批窗口，`PostgresBackendTracker` 拥有与 JSONL 的 `JsonlSessionHandle`/`JsonlBackendTracker` 相同的进程内记账，包括每个 id 的单写入者、落库前待处理会话的可见性，以及已打开句柄的关闭清理。两个后端各自实现这些结构，不共享实现，符合 `dsh-session-persistence` README 的设计原则：每个提供者拥有完整存储运行时，实现机制不跨越包边界。

### 两个自有资源的关闭顺序

此后端比 JSONL 多拥有一个连接池资源。连接池必须在所有已打开句柄排空后才能关闭。Cordis 通过 `Promise.all` 并发释放 fiber 的独立顶层 effect，而非按注册顺序执行；将连接池关闭和句柄清理注册为两个 `ctx.effect` 会导致竞争，在快速根释放时，仍有实时事件缓冲的句柄可能尚未写入，连接池就已结束。共享 `runLiveWritePathContract` 的后端关闭排空测试捕获了此问题。实现使用单个 effect，先等待 `tracker.closeOpenHandles()` 再调用 `pool.end()`，由代码明确规定顺序。

### `header`/`event` 列使用 `bytea`，而非 `jsonb`

Postgres 的 `jsonb` 输入解析器拒绝 NUL 字符，错误为 `unsupported Unicode escape sequence`，详情为 `U+0000 cannot be converted to text.`；也拒绝孤立 UTF-16 代理项，错误为 `Unicode low surrogate must follow a high surrogate.`。一次真实端到端运行暴露了此问题：其他文件或工作区扫描代码的既有缺陷生成了包含 NUL 的 `scope` 字段，NUL 位于 `.` 与 `AGENTS.md` 之间。JSONL 可以保存该事件，但 `jsonb` 拒绝。能力接口的无损 JSON 数据不变量要求后端保存已经通过 `materializeCreateHeader`/`materializeAppendBatch` 验证的内容，不得额外收紧验证，因此两列均以 `Buffer` 保存 `JSON.stringify` 的原始 UTF-8 字节，读取时用 `JSON.parse` 解码。代价是无法对这些列执行服务端 `->>` 查询或建立 `jsonb` 索引，详见包 README 的已知限制。

### `coffe_message`：参考聊天产品存储的逐消息派生表，例如 ChatGPT

`bytea` 使 SQL 无法直接读取会话内容。运维人员选择此后端是为了集中查询，却仍需在应用中解码每行才能针对对话运行 `WHERE`、`GROUP BY` 或全文搜索。最初方案将 `role`、`tool_name`、`content_text` 等扁平标量列加入 `coffe_session_event`，随后改为专用 `coffe_message` 表：每个消息一行，保存稳定 id、角色和完整结构化内容，而非扁平摘要。这对应了参考真实聊天产品会话存储的需求。`content` 为可通过 `->>` 和 GIN 包含查询访问的 `jsonb`，同时显式记录从 `surfaceOp` 提取的压缩替换范围 `replaces_start_seq`/`replaces_end_seq`；扁平列不能自然表达这种编辑或重新生成沿袭信息。

`src/derived-message.ts` 的纯函数 `deriveMessageRow` 从事件信封和第一方载荷生成一行，包含 `message_id`、`role`、`content`、`model`/`provider`、`tool_name`/`call_id`、Token 用量、替换沿袭信息及 `source_event_seqs`。`insertMessages` 与对应的原始 `event` 字节在同一事务中写入，因此投影始终与来源具有相同的持久性和更新进度，无需像从外部观察持久化后端的 `dsh-session-query-sqlite` 那样另行协调。生成列 `content_tsv tsvector` 使用 `jsonb_to_tsvector` 并建立 GIN 索引，直接对 `content` 的每个字符串叶节点提供全文 SQL 搜索，无需另设扁平文本列。

只有 `user/message`、`assistant/message`、`tool/call`、`tool/result` 生成消息行；其他事件仍可通过完整日志的通用 `type`/`event_time` 列查询。分析角色将工具结果与线协议中的用户角色消息区分。派生 JSON 的键、字符串值和 SQL 文本列通过标准 `String.toWellFormed()` 及 NUL 替换，将 NUL 与孤立 UTF-16 代理项转换为 U+FFFD，有效 Unicode 代理对保持不变。规范化可能合并不同的键或标识，因此源事件通过 `(session_id, seq)` 定位，精确值以原始 `event` 字节为准。

内容提取在本包内实现，不导入 `@deepseek-ai/dsh-session-query` 的 `extractSessionEventText`。后者的入口为 `SessionQueryEngine` 服务类，仅访问一个纯函数也会将会话标题、待办和投影包带入模块图，不符合本后端保持依赖精简的设计。此外，此处需要真实内容块等结构化内容，而非 `extractSessionEventText` 生成的扁平搜索字符串。

`ensureSchema` 通过 `CREATE TABLE IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS` 创建 `coffe_message` 并添加 `coffe_session_event` 的信封列，既有部署的 schema 在实例下次启动时自动获得它们。升级前追加的事件没有对应消息行，不提供重放既有 `coffe_session_event` 的回填过程。

## 考虑过的替代方案

- **在 `dsh-session-persistence` 能力接口包中共享抽象句柄与 tracker，由两个后端继承。** 未采用：该包要求提供者仅共享契约和测试，不共享实现机制。文件字节操作与操作系统锁、SQL 事务与咨询锁的运行时差别较大，共享基类所需的例外入口可能抵消其简化价值。
- **与 JSONL 保持历史格式迁移一致。** 首轮实现未采用：JSONL 的迁移目录、worker 内解码验证及 Zstandard 分帧占实现的较大部分，仅用于读取旧版本日志。开始新会话的 Postgres 部署不需要这些；将已有 JSONL 历史迁入 Postgres 属于独立的显式导入功能，而非本后端自身的存储格式兼容要求。
- **共享进程内日志缓存，即 JSONL 的冷日志缓存。** 未采用：JSONL 用它分摊观察后恢复过程中的文件解码与解压成本。Postgres 读取已是直接查询，无需相同的文件解码步骤，缓存只节省少量延迟，却增加需要维护的状态。在实际工作负载证明反复读取大型会话成本显著之前暂缓，见包 README 的已知限制。
- **通过 `SELECT ... FOR UPDATE` 行锁而非咨询锁实现跨进程所有权。** 未采用：行锁受事务生命周期约束，需要在整个句柄生命周期内保持事务打开，阻碍 autovacuum 及其他事务，或者每条语句重新加锁，丢失语句间的连续互斥。专用连接上的会话级咨询锁独立于事务，在句柄存续期间持续持有，符合此用途。
- **对 `header`/`event` 使用 `jsonb`。** 尝试后撤回：严格的输入解析器拒绝 NUL 与孤立 UTF-16 代理项，JSONL 和能力接口均不禁止这些内容。真实会话运行遇到了此问题。以 `bytea` 保存 `JSON.stringify` 的 UTF-8 字节，牺牲服务端 JSON 查询能力，保持与能力接口一致的存储保证。
- **增加类似 `dsh-session-query-sqlite` 的 `dsh-session-query-postgres` 提供者，由外部观察派生索引。** 当前范围未采用：该设计通过外部观察者与持久化读取句柄协调，支持搜索尚未持久化的实时会话，涉及代际绑定游标和连接本地 TEMP 表覆盖。本后端已在约 200ms 的 `LIVE_WRITE_BATCH_MAX_DELAY_MS` 窗口内事务化存储事件，不需要该机制。将 `coffe_message` 与源事件放入同一事务更直接且不会落后于来源。只有需要针对 Postgres 提供完整 `dsh-session-query` API，例如带排序的跨会话搜索和游标，而非原生 SQL 时，独立查询服务提供者才适合。
- **为每个 `SessionEventMap` 成员增加专用结构化列，或在 `coffe_session_event` 保存每个载荷的 `jsonb` 副本以供 `->>` 查询。** 未采用：事件类型可通过声明合并扩展，专用列会遗漏新插件类型；JSON 副本则会让来源表重新遭遇选择 `bytea` 时要避免的 NUL 问题。四类对话和工具事件覆盖既有会话分析需求，其他结构性事件通过 `coffe_session_event` 的 `type`/`event_time` 查询。
- **沿用初始方案，在 `coffe_session_event` 添加扁平标量列，而非专用 `coffe_message`。** 已调整：标量 `content_text` 只能保存扁平摘要，无法保留真实内容块、工具调用参数或多模态引用，也缺少表达压缩替换沿袭信息的自然位置。专用表的 `jsonb` 内容及明确沿袭列可直接表达这些事实，避免原始事件表承载大量仅对少数类型有效的消息字段。

## 影响

收益是提供了在共享 Postgres 上安全运行多实例会话存储的第一方路径，并有两类验证：完整共享契约套件 `runPersistenceContract` 与 `runLiveWritePathContract` 共 31 个用例在 Testcontainers 真实 PostgreSQL 上运行；以及通过生产 DeepSeek API 兼容网关执行真实会话，持久化到真实外部 PostgreSQL，并逐字节读回核对。后者符合产品可见插件必须经过非单元真实组合验证的要求。`coffe_message` 使集中查询能够直接通过 SQL 实现角色、工具、Token 过滤、`jsonb` 包含查询、全文搜索和压缩沿袭分析。

代价是本后端不能读取不同 Harness 格式版本写入的会话；若部署要求升级后继续读取历史，JSONL 仍是提供该保证的选择。会话落库后每次 `read()` 都重新查询数据库，不使用进程内缓存，以多一次往返换取比 JSONL 缓存更少的状态。咨询锁依赖持锁连接在句柄生命周期内保持有效，这比内核文件锁的进程退出释放保证弱：网络分区若导致连接失效而双方未察觉，Postgres 可能释放锁但句柄仍认为持有它；`pool.on('error', ...)` 仅警告已检测的错误，不会封禁或重试。`bytea` 仍不支持对 `coffe_message` 未覆盖的内容执行任意服务端 JSON 查询。`content_tsv` 的 `simple` 配置不能有效切分中日韩文本，需要部署方自行安装扩展。为四类消息事件写入第二张派生表，使每批插入次数大致翻倍；本后端本就按批事务化写入，此成本可接受。

挂载此后端会将 `pg` 和本包加入 `dsh-base` 的依赖闭包；`apps/cli` 与 `packages/bundle/base` 均像声明 JSONL 一样声明它。原因是 `plugin-package-inventory-deepseek` 通过真实 `node_modules` 解析挂载插件的 manifest，而非 Loader 的 tsconfig 路径或源码启动解析。只在 Loader 中可解析、却没有应用 npm 依赖边的插件会触发 `cannot resolve active package`，使整个进程的 `dsh_plugin_packages` 请求扩展失败。无论是否挂载此后端，所有 `dsh-base` 消费者均携带 `pg`；若依赖体积比与 JSONL 声明方式的一致性更重要，应重新评估。

## 测试

容器套件默认使用 PostgreSQL 18；设置 `DSH_POSTGRES_TEST_IMAGE=postgres:16-alpine` 可在 PostgreSQL 16 上运行相同用例。两个版本均验证旧表升级，以及修正当前表上残留的旧约束名。

PostgreSQL 测试实例使用 `coffe` 数据库。独立的旧版 SQL 测试夹具验证重命名保留关系 OID、数据行、全文索引和外键，允许后续追加，并保留其他插件的表。冲突测试同时覆盖前置拒绝与部分 DDL 执行后的回滚。数据库锁屏障证明两个独立初始化操作确实重叠，再依次完成，之后重复初始化仍保持幂等。

针对性投影套件覆盖嵌套键、值及标识的 Unicode 规范化，并确认不修改源事件。真实 PostgreSQL 读回覆盖四类消息角色、原始 Unicode 保留、全文搜索、17,000 条事件与 3,700 条消息的追加，以及待落库和已落库会话在后续消息 SQL 失败时的完整回滚。共享实时写入故障用例在根释放前恢复模拟的 `close()`，确保定时器、咨询锁客户端和连接池在测试容器停止前结束。容器启动错误会导致测试失败；只有无法发现容器运行时时才跳过。

`packages/session/session-persistence-postgres/tests/contract.e2e.ts` 为文件启动一个 Testcontainers Postgres 容器，运行两套共享契约，每个用例使用独立 schema。专用用例追加结构性事件及每种对话或工具调用事件，通过直接 SQL 验证 `coffe_session_event` 的 `type`/`event_time` 覆盖全部日志，而 `coffe_message` 仅为四类事件生成行，核对 `role`、`content`、`model`、`tool_name`、`call_id`、Token 字段及 `content_tsv` 全文匹配。Docker 不可达时套件跳过，遵循仓库真实提供者凭据测试的同类策略。`tests/schema.spec.ts` 固定 DDL 标识引用的纯函数行为；`tests/derived-message.spec.ts` 对 `deriveMessageRow` 的角色、内容、工具、调用 id、Token、替换沿袭提取、嵌套 NUL 规范化及声明合并扩展的默认不生成行分支提供 100% 单元覆盖。仍缺少的是 Postgres 驱动相关文件 `index.ts`、`storage.ts`、`schema.ts`、`lock.ts` 在强制 `pnpm run test:coverage` 逐文件门禁中的覆盖，它们依赖 Docker e2e，而非始终运行的单元套件；纯逻辑 `derived-message.ts` 有单元覆盖。后续需决定将真实 Postgres 覆盖纳入门禁，还是接受仓库尚无先例的例外。

自动化套件之外，本后端曾在真实外部 PostgreSQL 和生产 DeepSeek API 兼容网关上验证：`dsh --profile headless` 挂载此后端替代 JSONL 执行真实会话，之后直接读取数据库，确认头部及每个事件，包括模型实际回复文本，均存在且字节一致。该运行暴露了上述 `jsonb`/`bytea` 与 `plugin-package-inventory-deepseek` 依赖闭包问题。契约和实时写入套件均未覆盖真实 LLM 适配器及请求扩展流水线，因此这一类集成问题未被自动化覆盖，类似后端若跳过人工完整运行仍可能再次遇到。
