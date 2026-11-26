# Cairn

[English](README.md) · [简体中文](README.zh-CN.md)

Cairn 是面向编码 Agent 的本地任务交接工具。它把已确认的项目决策、已废止的规则及原因、任务自身的历史分开保存。会话恢复时，操作者可以核对上一次失败的测试、哪些规则仍有效，以及哪些工具动作还需要验证。

## 安装与验证

**不要运行 `npm install cairn`、`npm install cairn@0.1.0` 或 `npx cairn`。** 公共 npm 上的同名包属于另一个项目。使用本仓库或 [GitHub Releases](https://github.com/Violet-2ai077/cairn/releases)。

需要 Git 和 Node.js 22 或更高版本。源码无需安装依赖、无需构建：

```sh
git clone https://github.com/Violet-2ai077/cairn.git
cd cairn
git remote get-url origin
node ./bin/cairn.mjs status --json
npm test
```

首次运行看到 `initialized: false` 是正常的；查询状态不会初始化仓库。下面的命令都从刚克隆的 Cairn 目录执行。

要固定版本，可在克隆后运行 `git switch --detach v0.4.3`，或从
[v0.4.3 发布页](https://github.com/Violet-2ai077/cairn/releases/tag/v0.4.3)
下载 `cairn-0.4.3.tgz` 并与同页的 SHA-256 校验和核对。然后用
`npm install --offline ./cairn-0.4.3.tgz` 安装这个**本地文件**，无需从公共 npm 查找同名包。

## 接入 dsh

已验证的组合是 dsh `0.2.2-rc.5` 与 Node.js `24.16`。复制[宿主配置示例](docs/cairn.patch.example.yml)，将示例中插件地址替换为本机 Cairn 插件的绝对文件 URL。例如 Windows 使用 `file:///E:/codex-prj/cairn/src/hosts/dsh/index.mjs`。运行：

```sh
dsh --profile web --patch <你的配置文件路径>
```

在 dsh 中执行 `/cairn status` 验证插件已加载。仅运行源码 CLI 不会启用插件。不设置 `workspaceRoot` 时使用集中 Hub；示例配置开启 Autopilot，而裸配置不默认开启。请先用独立的 `storeRoot` 或测试项目体验。

## 语言

英文环境使用英文契约与交互提示；中文环境使用中文。启动时依次参考 `LC_ALL`、`LC_MESSAGES`、`LANG` 和系统语言，其他语言回退到英文。可在启动 **dsh 之前**显式覆盖：

```powershell
$env:CAIRN_LOCALE = 'zh'  # 或 en；auto 恢复自动选择
```

切换语言后重启 dsh，不需要迁移 Hub。任务编号、操作符、JSON 字段、错误码和命令名保持稳定。用户的原始指示、历史记录及工具证据不会被翻译。更改界面语言不等于批准长期偏好。

## 三个常用操作

| 目的 | 命令或做法 |
| --- | --- |
| 查看历史但不改变当前绑定 | `node ./bin/cairn.mjs checkout 1 --store <Hub路径> --preview --json` |
| 核对中断前一次受支持的原生整文件写入 | 从预览的 `work_state.file_writes` 复制 ID，再执行 `node ./bin/cairn.mjs verify-write 1 <write-id> --store <Hub路径> --json` |
| 检查 Hub 健康状况 | `node ./bin/cairn.mjs doctor --store <Hub路径> --json`。备份、恢复应使用停止写入的 Hub 和新的目的目录。 |

工具调用并不等于工具成功，工具回执也不等于外部效果已验证。Cairn 恢复归档不会替你重做写文件或部署。默认同窗口切任务仍保留 dsh 原生历史，不是权限或保密边界。

## 验证与许可

- [宿主能力和恢复流程](docs/dsh-host-interface.md) · [归档与中断证据](docs/turn-recovery.md) · [备份与恢复](docs/hub-recovery.md)
- [英文项目说明与实验证据](README.md#research-lineage) · [版本变更](CHANGELOG.md)
- 采用 [MIT 许可证](LICENSE)。宿主离线测试验证真实 dsh 进程和插件，不代表线上模型的语义准确率。
