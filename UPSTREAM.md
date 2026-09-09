# Upstream Attribution

English | [中文](UPSTREAM.zh.md)

**Coffe originates from [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness), developed by DeepSeek AI and its contributors.** This repository retains the upstream Git history and GitHub fork relationship. Coffe is independently maintained by [kingus188](https://github.com/kingus188); it does not represent an official DeepSeek release or endorsement.

## What is inherited

DeepSeek Harness provides the plugin architecture, Agent loop, session model, Web UI, tool integrations, and SDK foundations. [Cordis](https://github.com/cordiverse/cordis) provides the underlying plugin framework. The original authors retain credit for those contributions.

## What Coffe maintains

Coffe maintains the PostgreSQL persistence extension, `coffe_` runtime tables and their migrations, and this fork's repository and contribution workflow. [README.md](README.md) describes available additions; unimplemented product ideas are not release capabilities.

Internal `@deepseek-ai/*` names and the `dsh` command are retained for source compatibility and upstream maintenance. They do not imply that Coffe publishes packages under DeepSeek's namespace. Upstream installation commands, release endpoints, and desktop identities elsewhere in inherited documentation are not Coffe distribution channels. Use the source installation documented in this repository.

## Synchronization

`origin` points to `kingus188/coffe`; `upstream` points to `deepseek-ai/deepseek-harness`. Import reviewed upstream changes into `dev`, run the checks for the combined changes, then promote to `main`. Preserve original commits and keep Coffe additions in focused commits so provenance and future merges remain inspectable. Upstream branches and tags are read-only inputs to this workflow.

## License

The original [MIT license](LICENSE), including `Copyright (c) 2026 DeepSeek`, remains intact. Preserve it in copies and distributions, together with the applicable [third-party notices](THIRD_PARTY_NOTICES.md). Upstream references, historical issue links, and third-party origins remain attributed to their owners.
