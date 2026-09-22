# 开发与发布

## 当前发布目标

- 扩展 ID：`CosmosMount.cortex-kit`
- 扩展版本：`1.2.2`
- 平台：`win32-x64`；包含 Windows x64 Rust 后端，不作为跨平台包发布。
- 产物：仓库根目录 `cortex-kit-win32-x64.vsix`
- 许可证：根目录 `LICENSE`，扩展 manifest 与 Rust crates 均声明 MIT；`THIRD_PARTY_LICENSES.md` 和 `vendor/probe-rs/LICENSE-MIT` 记录受控 probe-rs fork 的上游版本与许可证。

旧的本地兼容包使用过 `cortex-kit.cortex-kit` ID。它与正式 ID 是不同扩展，发布时只能使用正式 ID；迁移测试时先禁用旧扩展，避免重复注册调试类型。`.tmp/` 中的兼容 VSIX 不用于发布。

## 开发与检查

需要 Windows x64、VS Code 1.96+、Node.js / npm、支持项目依赖的 Rust 工具链。仓库 Cargo manifest 声明 Rust 1.85+；锁定依赖若要求更高版本，以实际构建要求为准。`scripts/cargo.ps1` 支持本地 `.tooling` 工具链。

在仓库根目录执行，各步骤成功后再继续：

```powershell
.\scripts\cargo.ps1 test --workspace --locked
.\scripts\cargo.ps1 build --workspace --locked
cd extension
npm ci
npm test
npm run test:dap
npm run package
```

`npm run package` 会编译 TypeScript、构建 release 后端、复制 Webview、README、CHANGELOG 和 LICENSE，再生成 VSIX。扩展没有 npm 运行时依赖，打包使用 `--no-dependencies`；新增运行时依赖时须相应修改打包策略。

开发时打开仓库按 F5 启动 Extension Development Host，使用 **Cortex Kit: Mock Debug** 验证无硬件路径。瞬态硬件测试脚本、日志和压力测试证据统一保存在被 Git 忽略的 `.agents/docs/`，不得加入公开发布包。

## 发布包检查

```powershell
# 在 extension 目录
npx vsce ls --no-dependencies --tree
code --install-extension ..\cortex-kit-win32-x64.vsix --force
Get-FileHash ..\cortex-kit-win32-x64.vsix -Algorithm SHA256
```

核对包内 `extension/package.json` 的版本、publisher 和 MIT 声明，确认 README、CHANGELOG、LICENSE、图标、Webview 和后端齐全；不应包含测试、源码映射、固件、设备日志、凭据或 `.tmp` 内容。重新加载 VS Code 后检查设置作用域、Mock 会话、探针选择、录制和导出。

## 正式上传

准备工作不自动上传 Marketplace、不推送 Git、不创建发布标签。正式发布前确认 `CosmosMount` 是可管理的 Marketplace publisher，且目标版本尚未发布；如版本已占用，先同步修改 `extension/package.json`、`extension/package-lock.json` 和 CHANGELOG，再重新构建验证。

推荐在 [Marketplace 管理页面](https://marketplace.visualstudio.com/manage)上传已检查的 VSIX，保证上传的就是验证过的文件。也可在配置好发布身份后，从 extension 目录运行 `npm run publish:marketplace`，该命令会重新构建并上传。身份配置方式见 [VS Code 官方发布文档](https://code.visualstudio.com/api/working-with-extensions/publishing-extension)。不要将发布凭据写入仓库或日志。

发布完成后为对应提交创建版本标签，并在 GitHub Release 中附上 Windows x64 VSIX、SHA-256 和 CHANGELOG 中的版本说明。其他操作系统需要分别编译和验证原生后端，再制作相应 target 的 VSIX。
