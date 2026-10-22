# Paper Lens

Paper Lens 是一个 Obsidian 插件，目前处于初始化阶段，具体功能待定义。

## 开发

使用当前受支持的 Node.js LTS 版本和 npm。

```sh
npm ci
npm run dev
```

`npm run dev` 监听源码变更并生成根目录下的 `main.js`。修改源码后，需要在 Obsidian 中重新加载插件；构建监听本身不会自动重载插件。

```sh
npm run typecheck
npm run build
```

`npm run build` 先检查 TypeScript 类型，再生成生产构建。

## 在 Obsidian 中加载

1. 在测试 Vault 中创建 `.obsidian/plugins/paper-lens/` 目录。
2. 执行 `npm run build`，将 `main.js`、`manifest.json` 和 `styles.css` 复制到该目录。
3. 在 Obsidian 的设置 → 第三方插件中关闭受限模式，启用 **Paper Lens**；如未显示，重启 Obsidian。

插件目前只有空入口，启用后不会添加命令或界面。

## 文件结构

```text
src/main.ts          插件入口
manifest.json        Obsidian 插件元信息
styles.css           插件样式
versions.json        插件版本与最低 Obsidian 版本的对应关系
esbuild.config.mjs   开发监听与生产构建配置
tsconfig.json        TypeScript 配置
```

构建产物和插件本地数据不纳入 Git。发布新版本时，同步更新 `package.json`、`manifest.json` 和 `versions.json`。
