# Baton 的 Magpie Agent 接入

在 Magpie 的“插件 → 添加插件”中填入此目录的绝对路径，或运行：

```sh
magpie plugin add /absolute/path/to/baton/integrations/magpie
```

先启动一次 Baton，使其数据目录存在。随后 Magpie 的 Agent 列表会显示 Baton，可打开接入并选择新对话的默认模型。请求使用 Magpie 分配给 Baton 的独立 key，用量归到 Baton；不读取或复制供应商登录。

插件仅管理 `~/.baton/v2/magpie.json`。Baton 每秒检查这个独立文件；连接有变化时同步模型并自动检测，已有任务结束前延迟应用变化。默认模型只有被勾选且检测可用，才成为新对话的默认选择；它不会自动加入聊天框列表。已有对话不被外部默认模型覆盖。

关闭接入后，Magpie 恢复自己管理的键，Baton 回到原先手动保存的网关连接。Baton 不写这个文件，也不修改 Magpie 的供应商配置。插件默认对应普通桌面的数据目录。若使用自定义 `BATON_HOME`，先复制此插件，再将 `baton.agent.js` 的 `directory` 改为该数据根目录下 `v2` 的绝对路径，然后加载这份副本。插件运行环境没有 Node 的 `process` 等全局对象。

检测结果与聊天框勾选保存在 Baton 自己的配置里。新模型不会因检测通过而自动被勾选；全不选不会出现提醒。普通聊天、项目对话与归档历史不会被此插件搬迁。
