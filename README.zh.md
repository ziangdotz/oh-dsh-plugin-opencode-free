# dsh-plugin-opencode-free

为 DSH 提供 OpenCode Free 模型接入的插件。我们在本项目中设计并实现了模型路由、流式响应适配、模型管理界面、服务生命周期管理和资源控制。

[English](README.md) · [文档索引](docs/README.md)

## 功能

- **流式对话**：将本地服务的文本增量接入 DSH 对话。
- **模型管理**：自动发现、缓存和筛选免费模型，也支持固定模型清单及多路由配置。
- **设置界面**：提供模型设置卡片与独立设置页。
- **按需启动**：首次模型发现或对话时启动服务，避免在插件挂载时启动进程。
- **随插件驻留**：服务启动后空闲时保持运行，插件卸载或 DSH 退出时自动关闭；手动启动的服务由用户管理。
- **资源控制**：限制并发、排队与数据大小，每轮使用临时会话并在结束后尝试删除。

插件依赖 DSH 提供运行环境，依赖本机 OpenCode Server 提供模型服务；这些外部组件需要另行安装。模型是否可用及免费额度由服务端决定。

## 安装与启用

运行环境：Node.js 22 及以上，DSH 版本范围 `>=0.2.1-rc.3 <0.3.0`。具体 peer 依赖以 [package.json](package.json) 为准，已验证的组合见[验证记录](docs/VERIFICATION.md)。不同 OpenCode 版本的协议兼容性也以验证记录为准。

1. 在本机安装 OpenCode，确认终端可以执行 `opencode`。
2. 在 DSH profile 中安装并登记本插件 bundle。支持 GitHub 来源安装的环境可使用：

   ```sh
   dsh plugin add github:ziangdotz/oh-dsh-plugin-opencode-free
   ```

3. 重启 DSH，在「设置 → 模型」打开 OpenCode Free 卡片并刷新模型，再回到对话选择模型。

默认路由为 `opencode-free`，服务地址为 `http://127.0.0.1:4399`。模型选择器本身不会启动服务；首次使用时先进入模型设置刷新清单。

源码开发安装可将本目录链接到 profile 的 `node_modules/dsh-plugin-opencode-free`，在 profile 的 `package.json` 中登记依赖，并加入 `dsh.profile.bundles`。更新源码后执行 `npm run build` 并重启 DSH。

## 配置

插件 bundle 已包含默认配置。自定义时，在 profile 的 `cordis.patch.yml` 中按 `OpenCodeFree` 的 id 覆盖，不要重复插入同 id 的条目。`config` 整体替换，请完整填写需要的配置。

```yaml
- id: OpenCodeFree
  name: dsh-plugin-opencode-free
  config:
    routes:
      opencode-free:
        displayName: OpenCode Free
        local:
          serverURL: http://127.0.0.1:4399
          providerID: opencode
          autoStart: true
          serverCommand: opencode
    catalog:
      autoDiscover: true
      maxAgeMs: 3600000
      timeoutMs: 5000
      includeNonFree: false
```

密码可通过启动 DSH 的环境变量 `OPENCODE_SERVER_PASSWORD` 提供，也可设置 `local.password`；`local.passwordEnv` 支持自定义变量名。请勿将真实密码提交到仓库。

| 配置项 | 默认值 | 用途 |
| --- | --- | --- |
| `local.serverURL` | `http://127.0.0.1:4399` | 服务地址 |
| `local.serverCommand` | `opencode` | 启动命令，可填写可执行文件绝对路径 |
| `local.providerID` | `opencode` | 服务端 provider 标识 |
| `local.autoStart` | `true` | 服务未运行时自动启动 |
| `local.startTimeoutMs` | `20000` | 启动等待时间（毫秒） |
| `local.promptTimeoutMs` | `10000` | 请求受理超时（毫秒） |
| `local.terminalTimeoutMs` | `120000` | 单轮执行超时（毫秒） |
| `routes.<id>.models` | 空 | 固定模型清单，优先于自动发现 |
| `routes.<id>.defaultContextWindow` | `200000` | 模型未声明时使用的上下文容量 |
| `routes.<id>.defaultMaxTokens` | `32000` | 模型未声明时使用的输出容量 |
| `catalog.autoDiscover` | `true` | 自动发现；关闭后仅使用固定模型清单 |
| `catalog.maxAgeMs` | `3600000` | 模型清单缓存时间（毫秒） |
| `catalog.timeoutMs` | `5000` | 清单请求超时（毫秒） |
| `catalog.exclude` | `["test"]` | 排除的模型 id |
| `catalog.includeNonFree` | `false` | 是否保留不带 `-free` 后缀的模型 |

固定模型使用 `models: [{ id: <模型ID>, name: <显示名> }]`，可附加 `contextWindow` 与 `maxTokens`。多路由在 `routes` 下配置不同 id。完整示例见 [examples/profile.patch.example.yml](examples/profile.patch.example.yml)。

## 服务生命周期与内存

插件只在目标端口无监听时尝试启动服务，已有服务不会重复启动。由插件启动的进程跟随插件驻留；Windows 通过 Job Object 管理进程树，在 DSH 异常退出时也能回收。服务意外停止后，下次刷新或对话可重新启动。

同一服务地址最多同时执行 1 轮，最多排队 8 轮；排队支持取消。UTF-8 数据上限为：prompt 1 MiB、累计输出 2 MiB、单条 SSE 1 MiB、单次工具结果及每轮累计工具元数据各 256 KiB。超限明确报错。会话删除最多尝试 3 次，每次超时 1 秒，最终失败记录日志。

这些措施控制插件的数据积累与并发压力，不是 OpenCode Server 的内存硬上限。当前本机实验中，直接启动原生可执行文件、加载模型清单后，整棵进程树空闲工作集约 247–250 MiB；该值不是生成期间峰值或跨机器保证。测量条件和优化空间见[内存分析](docs/MEMORY-ANALYSIS.md)。

## 常见问题

- **找不到命令**：确认 DSH 进程能访问 PATH，或为 `local.serverCommand` 配置绝对路径。
- **模型选择器没有分组**：先到「设置 → 模型」刷新；同时检查模型过滤条件和服务日志。
- **连接或认证失败**：检查地址、端口和密码；已有端口监听时插件不会另起进程。
- **需要手动管理服务**：设置 `local.autoStart: false`，自行运行下面的命令，并保持服务运行。

```powershell
$env:OPENCODE_SERVER_PASSWORD = '<自行设置的密码>'
opencode serve --hostname 127.0.0.1 --port 4399
```

当前适配输出为文本，不提供 DSH 工具调用，也不透传 DSH 的沙箱、审批与工作目录。服务自身的权限与工具由其配置决定。

## 开发

```sh
npm install
npm run build
npm run check
npm test
node --check client.js
npm run local-smoke:self
npm run pack:check
```

DSH peer 依赖由宿主环境提供；单独开发时需准备匹配的依赖，桌面环境可使用 `npm run compat:desktop` 做兼容性验证。仓库保留 `lib/` 构建产物，提交源码更改前请重新构建。

- [架构设计](docs/ARCHITECTURE.md)
- [界面说明](docs/UI.md)
- [验证记录](docs/VERIFICATION.md)
- [版本变更](CHANGELOG.md)

## 许可

[MIT](LICENSE)。许可及来源声明保留在 LICENSE 中。
