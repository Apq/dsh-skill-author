# dsh-skill-author

DeepSeek Harness 插件：给会话注册模型可调用的 `skill_manage` 工具，让 agent 把跑通的可复用流程保存为 Harness 技能（SKILL.md），或替换、删除已有技能。

A DeepSeek Harness plugin that registers the model-facing `skill_manage` tool, so the agent can save reusable procedures as Harness skills (SKILL.md), or replace / delete existing ones.

## 它做什么 / What it does

- `create`：在所选作用域下新建一个技能（已存在则失败）
- `patch`：整体替换某技能的 SKILL.md 正文（不存在则失败；描述可省略，沿用旧值）
- `delete`：删除技能，归档到技能根旁边的 `.deleted-skills/<name>-<timestamp>-<random>`

作用域：

- `user` — `$DSH_HOME/skills`（默认 `~/.dsh/skills`），本机所有工作区可用
- `project` — 会话工作区的 git 根下 `.dsh/skills`，仅该仓库可用

frontmatter 由工具管理，但只拥有 `name` / `description` / `metadata` 三个键：patch 时其余键（如 `disable-model-invocation`、`user-invocable`、`whenToUse`）**逐字保留**，调用限制不会被一次 patch 悄悄放宽；省略 `description` 时沿用原有那一行，避免引号/转义漂移。正文只传 Markdown；技能上限 100 000 字符。

写入安全：同一技能的检查到发布按主机进程串行；临时文件随机命名并以独占方式创建；`create` 通过硬链接原子发布（并发 create 恰好一个成功）；技能目录经过 `realpath` 校验，符号链接无法把写入带出技能根。项目根识别按存在性检测 `.git`（目录或 worktree 文件均可，Linux 下 `readFile` 会对 `.git` 目录抛 `EISDIR`）。

## 环境要求 / Requirements

- DeepSeek Harness ≥ `0.1.7-rc.2` 且 < `0.3.0`（peer：`@deepseek-ai/dsh-tools`）
- 无其它依赖，无配置项

## 安装 / Install

在桌面应用的 **设置 → 插件 → 添加插件** 中任选一种：

1. **Git 仓库地址**：粘贴本仓库的 git URL（GitHub 或其它 git 服务均可）
2. **本地目录路径**：把本目录拷到对方机器，粘贴其绝对路径
3. **npm 包名**：若已发布到 npm / 私有源，填包名 `dsh-skill-author`

安装后新会话自动获得 `skill_manage` 工具，无需手工改 profile。

## 从源码开发 / Develop

```sh
git clone <this-repo>
# 本机试用（不走插件管理器）：在 profile 的 package.json 里
# dependencies 加 "dsh-skill-author": "file:<本目录绝对路径>"，
# dsh.profile.bundles 加 "dsh-skill-author"，然后 pnpm install 并重启应用
pnpm pack   # 产出 dsh-skill-author-<version>.tgz
```

## 快速上手 / Quick start

- **[使用说明.md](使用说明.md)**：安装 → 配置系统提示词 → 三步验证 → 常见问题，三步走完即可用。
- **[Agents.md](Agents.md)**：配套的常驻系统提示词，整文件内容追加到 `~/.dsh/AGENTS.md`（全局）或工作区 `AGENTS.md`，配好之后 agent 才会主动调用 `skill_manage` 沉淀技能。

## License

MIT
