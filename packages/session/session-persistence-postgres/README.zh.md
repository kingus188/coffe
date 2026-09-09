---
description: "面向部署人员与维护者的 PostgreSQL 会话持久化后端参考，用于选择、配置或排查集中存储且支持多实例的持久会话存储。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-persistence-postgres

[English](README.md) | 中文

## 概述

`dsh-session-persistence-postgres` 将每个会话的头部与事件日志存入两张 PostgreSQL 表，替代每个会话一个文件的方式。它提供与 JSONL 后端相同、基于句柄的 `SessionPersistence` API，因此 agent-loop 无需了解底层后端即可持久化和恢复会话。选择它的原因是：跨进程单写入者互斥依赖 Postgres 咨询锁，而非内核文件锁，因此共享数据库的多个应用实例可以安全地承载不同会话，或轮流拥有同一个会话，无需共享文件系统。单实例部署若希望每个会话在磁盘上对应一个文件，应选择 JSONL；需要集中查询会话且已有共享 Postgres 的部署可选择此后端。

它的支持范围小于 JSONL：不包含历史格式迁移，仅写入当前逻辑 `SessionEvent` 格式，详见[已知限制](#known-limitations-and-deferred-work)。

## 目录

- [使用此包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [模型体验](#model-experience)
- [已知限制与暂缓工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用此包

需要将会话存入共享 PostgreSQL 数据库时，挂载此后端来替代 `dsh-session-persistence-jsonl`。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-session'
- name: '@deepseek-ai/dsh-session-persistence-postgres'
  config:
    connectionString: postgres://user:password@host:5432/coffe
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `connectionString` | 必填 | 标准 `postgres://user:password@host:port/database` 连接字符串。没有默认值：数据库连接不像本地文件根目录，不存在适用于各种部署的后备值。 |
| `schema` | `'public'` | 存放后端三张表的 Postgres schema；不存在时创建。共享数据库的不同逻辑部署应使用不同值。 |
| `ssl` | `false` | 是否与服务端协商 TLS；多数托管 Postgres 服务要求启用。 |
| `poolSize` | 驱动默认值 | 连接池最大连接数。 |

### 共享 Agent 运行库

`coffe` 是整个 Agent 的运行数据库。库名由 `connectionString` 指定；部署时独立创建或重命名数据库，再同步所有客户端连接配置。本插件只拥有 `coffe_session`、`coffe_session_event`、`coffe_message` 及其索引和约束。其他插件可以在同一数据库和 schema 中拥有自己的表。表名统一使用 `coffe_` 前缀，再按所保存的数据命名。

首次使用时，初始化会将已有的 `dsh_session_header`、`dsh_session_event`、`dsh_session_message` 原地改为上述名称，并同步标准约束和索引名。操作保留表身份和数据，在跨后端实例串行执行的事务中完成。新旧表名同时存在时拒绝初始化；后续 DDL 失败会回滚此前全部重命名。升级前应停止运行旧插件的客户端，因为其 SQL 仍使用旧表名。这种物理改名不改变已保存的 Session 格式。

中间命名 `agent_session`、`agent_session_event`、`agent_message` 使用相同迁移。若同一目标同时存在多种旧表名，也会拒绝初始化，避免擅自选择某一套数据。

对于已经改名的表，初始化也会修正仍带旧前缀的约束名，包括 PostgreSQL 18 中具名的 `NOT NULL` 约束。

### 数据表

三张会话表共享配置的运行库 schema。`coffe_session` 保存每个会话的原始 JSON 字节头部、继承事件数、事件数和修订号。`coffe_session_event` 以 `(session_id, seq)` 为主键保存事件，通过 `ON DELETE CASCADE` 外键引用 `coffe_session`，并提供 `type`、`event_time` 以查询完整日志。`coffe_message` 是下文介绍的逐消息派生投影。这些表由本后端写入，所在 schema 也可包含其他运行时插件拥有的数据。

`header`/`event` 使用 `bytea`，而非 `jsonb`：Postgres 的 `jsonb` 输入解析器拒绝 NUL 字符和孤立 UTF-16 代理项，但 JS 字符串及真实模型回复可以包含这些内容，JSONL 也能完整保存。保存原始 UTF-8 字节可确保本后端不会施加比能力接口的 `materializeCreateHeader`/`materializeAppendBatch` 更严格的验证，代价见[已知限制](#known-limitations-and-deferred-work)。

<a id="coffe_message-a-queryable-per-message-table"></a>
### `coffe_message`：可查询的逐消息表

该表参考聊天产品的会话历史存储方式，例如 ChatGPT 网页导出：每个回合一行，包含稳定 id、角色和完整结构化内容，让运维人员无需先解码不透明日志即可分析。`insertMessages`（`src/index.ts`）为每个对话或工具调用事件写入一行，并与原始 `event` 字节处于同一事务，因此该表与来源具有相同的持久性和更新进度，无需独立协调。只有 `user/message`、`assistant/message`、`tool/call`、`tool/result` 四类事件生成消息行；回合或步骤边界、待办写入、请求头等其他事件属于结构性记录，完整日志仍由 `coffe_session_event` 保存。

| 列 | 含义 |
|---|---|
| `session_id`, `seq` | 主键；`seq` 将该行关联到 `coffe_session_event` 中的源事件。 |
| `message_id` | 事件携带的稳定 `Message.id`；`tool/call` 没有 `Message` 包装，因此为 `null`。 |
| `role` | `'user'`、`'assistant'`、`'tool_call'` 或 `'tool_result'`，用于分析，并非直接复制线协议的 `Message.role`。工具结果在线协议中为 `'user'`；单独的角色值使查询可以将其与真实用户消息区分。 |
| `content` | 结构化 `jsonb`：`user/message`、`assistant/message` 和 `tool/result` 保存内容块，`tool/call` 保存 `{name, arguments}`。键和值中的 NUL 与孤立 UTF-16 代理项转换为 U+FFFD；`coffe_session_event.event` 保留无损来源。 |
| `content_tsv` | 通过 `jsonb_to_tsvector` 为 `content` 的所有字符串叶节点生成 `tsvector`，并建立 GIN 索引，无需额外的扁平文本列即可执行全文 SQL 搜索。 |
| `create_time` | 从事件信封复制的 Unix 时间戳，单位毫秒。 |
| `model`, `provider` | 生成消息的模型与提供者；仅存在于 `assistant/message`。 |
| `tool_name`, `call_id` | 被调用工具的名称，存在于 `tool/call`；以及关联 `tool/call` 与 `tool/result` 的 id。 |
| `input_tokens`, `output_tokens`, `total_tokens`, `cache_read_tokens`, `cache_write_tokens`, `reasoning_tokens` | Token 计量数据；仅存在于带计量的 `assistant/message`。 |
| `replaces_start_seq`, `replaces_end_seq` | 当该行代表压缩替换消息时，记录其 `surfaceOp` 替换的 seq 范围。这是重建编辑或重新生成历史所需的沿袭信息，在用途上类似 ChatGPT 节点树的父链接。 |
| `source_event_seqs` | 事件引用的较早 seq；若存在则保存。 |

源事件没有相应事实时，每个可选列均为 `NULL`。查询示例：

```sql
-- Tool calls with their result text, joined by call id
SELECT c.session_id, c.tool_name, r.content AS result
FROM coffe_message c
JOIN coffe_message r ON r.session_id = c.session_id AND r.call_id = c.call_id AND r.role = 'tool_result'
WHERE c.role = 'tool_call';

-- Token spend per session
SELECT session_id, sum(output_tokens) FROM coffe_message GROUP BY session_id;

-- Full-text search over message content
SELECT session_id, seq, content FROM coffe_message
WHERE content_tsv @@ to_tsquery('simple', 'deploy');
```

派生文本列也采用相同的 Unicode 规范化，包括 `type`、消息 id、模型、提供者、工具名称和调用 id。有效代理对与中日韩文本保持不变。规范化可能合并原本不同的键或标识，因此需要精确身份或原始内容时，应通过 `(session_id, seq)` 定位并解码 `event`。

`content_tsv` 使用 Postgres 的 `simple` 文本搜索配置，按空白与标点分词，不做词干提取或字典匹配，因此不能有效切分中日韩文本。需要此能力的部署可自行安装支持中日韩的搜索扩展，例如 `zhparser`，或通过 `content ->> ...`/`pg_trgm` 对指定字段做子串搜索。较早版本后端创建的 schema 在实例下次启动时通过 `ensureSchema` 自动获得 `coffe_message` 和事件表的信封列；升级前写入的事件没有对应消息行，不提供重放既有 `coffe_session_event` 的回填过程。

### 持久性与崩溃语义

会话与 JSONL 一样按需落库：`create()` 立即返回已持有写入所有权的句柄，头部行在首次持久追加或显式 `flush()` 时写入数据库。每次持久写入，包括首次落库插入、事件插入及头部修订号更新，均处于同一个 Postgres 事务。写入中途崩溃只会留下完整的旧状态或新状态；Postgres 事务不会向读取者暴露部分提交，因此无需修复撕裂尾部。

大批量追加会拆分事件与消息 INSERT，使每条 SQL 的参数数不超过 PostgreSQL 的 65,535 上限。所有语句仍属于同一次追加事务；后续语句失败时，头部、事件、消息、事件计数和修订号一并回滚。

### 跨进程所有权

`open(id, 'write')` 先在本后端实例内声明所有权，再取得按会话 id 哈希定位、绑定当前连接的 Postgres 会话级咨询锁。来自同一进程或共享数据库的另一实例的并发写打开，均以 `SessionAlreadyOwnedError` 拒绝。锁由句柄生命周期内专用的池连接持有，在 `close()` 时释放。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节，点击展开</summary>

### 设计思路

本包的运行结构与 JSONL 对应：`PostgresSessionHandle` 在 `storage.ts` 中拥有逐句柄变更链及有界实时写入合批窗口，`PostgresBackendTracker` 管理进程内记账，包括每个 id 的单写入者、已打开句柄的关闭清理及待落库会话的可见性。`@deepseek-ai/dsh-session-persistence/tests` 中的共享契约套件 `runPersistenceContract`、`runLiveWritePathContract` 固定两个后端相同的可观察行为；不同之处仅在物理存储，即 `schema.ts` 和 `index.ts` 中的查询，以及 `lock.ts` 中的所有权机制。

### 关闭顺序

Cordis 通过 `Promise.all` 并发释放独立的顶层 effect，并不按注册顺序执行。如果连接池在所有已打开句柄完成排空前关闭，会丢失实时缓冲区内的会话尾部事件。因此，后端只注册一个关闭 effect，先等待 `tracker.closeOpenHandles()`，再调用 `pool.end()`。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：`SessionPersistence` 服务、`Config` 及所有 SQL 查询 |
| [`src/storage.ts`](src/storage.ts) | `PostgresSessionHandle` 的变更链与实时写入合批，以及 `PostgresBackendTracker` 的所有权记账与关闭处理 |
| [`src/schema.ts`](src/schema.ts) | 表名及幂等的 `CREATE TABLE IF NOT EXISTS`/`ADD COLUMN IF NOT EXISTS` DDL |
| [`src/lock.ts`](src/lock.ts) | 会话级咨询锁 |
| [`src/derived-message.ts`](src/derived-message.ts) | 将单个 `SessionEvent` 纯投影为 `insertMessages` 写入的 `coffe_message` 行 |
| — | 不发布运行时 invariant 配套入口：跨进程咨询锁所有权与持久写入事务由真实 Postgres 上的共享契约套件验证，不是包内两个独立观察值可能发生分歧的关系。 |

</details>

-----

<a id="model-experience"></a>
## 模型体验

### 恢复会话历史

#### 模型看到什么

与 JSONL 相同：本后端不贡献实时提示词或 schema。加载时将每行 `coffe_session_event.event` 解码为 `SessionEvent`，恢复已保存的对话历史；新的循环基于该历史组装当前请求信封。

#### Token 影响

不增加实时请求 Token；恢复后的 Agent 仍需承担保留历史及当前信封的 Token 成本。

#### KV 缓存影响

本后端不修改实时请求前缀；与 JSONL 相同，缓存复用只取决于重建的历史是否匹配。

## 已知限制与暂缓工作

<a id="known-limitations-and-deferred-work"></a>

以下限制说明何时此后端不适用或需要额外运维处理。它们是当前包的约束，不是任务清单。

- **没有历史格式迁移**：当前构建仅写入和读取当前 `SessionEvent` 格式。在本后端出现前或由其他主要格式版本创建的会话日志必须保留在原后端，不能迁入此处。从 JSONL 切换的部署在 Postgres 上创建新会话，已有 JSONL 历史保留原处。
- **没有会话行删除功能**：三张表的数据会持续积累，直至由外部删除；能力接口没有删除 API。
- **咨询锁互斥依赖稳定连接**：写句柄生命周期内，锁由专用池连接持有。如果网络分区导致连接失效而客户端未察觉，Postgres 可能释放锁，但进程仍认为持有它。`pool.on('error', ...)` 将已检测的连接失败报告为警告，不会重试或封禁句柄。
- **`readSlice`/`validateAndCountLog` 每次调用都重新查询**：没有 JSONL 那样的冷日志进程内缓存；会话落库后，每次读取都重新查询。对集中查询会话的目标用途可接受；若工作负载反复读取同一大型会话，需要重新评估。
- **每个逻辑部署一个 schema**：指向同一 schema 的所有后端实例均可见其中全部会话。多租户隔离，即每租户一个 schema 或数据库，由部署配置决定，本包不强制执行。
- **不支持任意服务端 JSON 查询**：`header`/`event` 仍为 `bytea`，完整会话内容没有 `->>`/`jsonb` 索引路径；只有 [`coffe_message`](#coffe_message-a-queryable-per-message-table) 的角色、结构化内容、工具身份、Token 用量、全文内容和压缩沿袭信息可直接查询。若需要访问该表未覆盖的字段，部署方应读取并解码 `event`，或使用 `session-query` 系列工具。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者工作上下文，点击展开</summary>

无。

</details>
