# dsh-plugins

DeepSeek Harness（DSH）自用插件合集。目前包含两个插件，均可通过 DSH 的 **插件 → 添加插件** 安装。

## 插件列表

### 1. 429 限流自动重试（`dsh-llm-429-retry`）

解决自建 / 第三方模型供应商触发 HTTP 429 限流时，本轮运行直接失败并提示「当前请求的额度已用尽」的问题。

- **背景**：DSH 在解析失败时，若 429 响应正文里带了「额度已用尽 / quota exceeded」等文案，会被误判成终态 `QUOTA`（不重试），于是本轮直接失败。而 429 本质是「稍后再试」的瞬时限流，应当等待后重试。
- **行为**：监听模型请求失败事件，对可证明是瞬时 429 的失败执行稳健的指数退避重试（默认最多 12 次，尊重供应商 `Retry-After` 头，可被中止信号打断），从而避免本轮运行失败。
- **范围**：默认对所有供应商生效；可通过 `config` 里的 `restrictProviders` + `providers` 限定。
- 真正的额度耗尽、鉴权失败、上下文超限等其他失败不受影响，仍走默认策略。

### 2. 截屏图片修复（`yach-paste-fix` / `@local/paste-image-compat`）

解决知音楼（Yach）等桌面客户端截屏粘贴时，因剪贴板图片被写成 TIFF / 未声明类型 / WebP，导致消息框提示「仅支持 PNG、JPG、WebP、GIF」或图片上传成普通文件、模型看不到图片的问题。

- **行为**：拦截这些粘贴，把 TIFF / WebP / 未声明类型的图片解码并重新编码为 PNG 后再重放粘贴，让上传、缩略图、提交都和普通 PNG 一致。
- 文本粘贴、PNG/JPEG/GIF 粘贴、拖拽、文件选择都走原逻辑，不受影响。
- 详细说明见 [`yach-paste-fix/README.md`](yach-paste-fix/README.md)。

## 安装

### 方式一：从 GitHub 地址安装（推荐，方便更新）

在 DSH 的 **插件 → 添加插件** 中，输入本仓库地址：

```
https://github.com/wuchengfeng/dsh-plugins
```

> 该地址指向整个仓库。若只想装某一个插件，DSH 也支持用子路径指向具体目录，例如：
> - 429 插件：`https://github.com/wuchengfeng/dsh-plugins` 下子路径 `dsh-llm-429-retry`
> - 截屏插件：子路径 `yach-paste-fix`
>
> 具体子路径写法以你使用的 DSH 版本「添加插件」界面为准；若界面只支持整仓库，安装后两个插件都会列出，按需启用即可。

### 方式二：下载仓库后本地安装

```bash
git clone https://github.com/wuchengfeng/dsh-plugins.git
```

然后在 DSH 的 **插件 → 添加插件** 中选择对应目录：

- 429 插件 → 选 `dsh-plugins/dsh-llm-429-retry`
- 截屏插件 → 选 `dsh-plugins/yach-paste-fix`

## 目录结构

```
dsh-plugins/
├── README.md
├── dsh-llm-429-retry/   # 429 限流自动重试插件
└── yach-paste-fix/      # 截屏图片修复插件
```

## 许可

自用项目，随仓库分发。若他人使用请自行评估，无任何担保。
