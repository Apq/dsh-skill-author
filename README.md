# dsh-skill-author

DeepSeek Harness 插件：给会话注册模型可调用的 `skill_manage` 工具，让 agent 把跑通的可复用流程保存为 Harness 技能（SKILL.md），或替换、删除已有技能。

A DeepSeek Harness plugin that registers the model-facing `skill_manage` tool, so the agent can save reusable procedures as Harness skills (SKILL.md), or replace / delete existing ones.

## 它做什么 / What it does

- `create`：在所选作用域下新建一个技能（已存在则失败）
- `patch`：整体替换某技能的 SKILL.md 正文（不存在则失败；描述可省略，沿用旧值）
- `delete`：删除技能，归档到技能根旁边的 `.deleted-skills/<name>-<timestamp>`

作用域：

- `user` — `$DSH_HOME/skills`（默认 `~/.dsh/skills`），本机所有工作区可用
- `project` — 会话工作区的 git 根下 `.dsh/skills`，仅该仓库可用

工具自己写 YAML frontmatter（name / description / metadata），正文只传 Markdown；技能上限 100 000 字符。文件系统技能提供方监视这些目录，新会话即见新技能。

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
pnpm pack   # 产出 dsh-skill-author-1.0.0.tgz
```

## License

MIT
