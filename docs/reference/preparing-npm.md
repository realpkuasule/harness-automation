# 准备 npm 账号与发布

## 1. 注册 npm 账号

1. 打开 https://www.npmjs.com/signup
2. 选择用户名（例如 `realpkuasule`）
3. 验证邮箱

## 2. 检查包名是否可用

`package.json` 中的包名是 `harness-automation`。

在 https://www.npmjs.com/search?q=harness-automation 搜索确认是否已被占用。如果被占用，需要在 `package.json` 中改名：

```json
{
  "name": "@realpkuasule/harness-automation"
}
```

同时更新：
- `mcp-server/package.json` — `name` 字段和 `repository.url` 中的引用
- `skill/install.sh` — 任何 npm install 引用

## 3. 创建 npm Access Token

npm 已于 **2025 年 12 月 9 日** 移除 Classic Token，现在有两种方式可用于 CI/CD 发布：

### 方式 A：Granular Access Token（推荐）

1. 登录 https://www.npmjs.com → 点击头像 → **Access Tokens**
2. 点击 **Generate New Token** → 选择 **Granular Access Token**
3. 填写：

   | 字段 | 值 |
   |------|-----|
   | **Token name** | `harness-automation-ci` |
   | **Packages and scopes** | 选择 **Read and write**（只有 `No access` 无法发布） |
   | **Bypass 2FA for automation** | **勾选**（否则 CI 中每次发布需要人工输入一次性验证码） |
   | **Expiration** | 选 **90 days**（当前最长可选值） |

4. 点击 **Generate Token**，复制 token——它以 `npm_` 开头

> ⚠️ Granular Access Token 最长有效期 90 天，到期后需要重新生成并更新 GitHub Secret。

### 方式 B：Automation Token（更简单，专为 CI/CD 设计）

如果页面提供 **Automation** 类型的选项，直接选它生成即可——它会自动获得发布权限并绕过 2FA，不需要手动配置权限范围。

## 4. 将 NPM_TOKEN 添加到 GitHub Secrets

1. 进入 GitHub 仓库: `https://github.com/realpkuasule/harness-automation/settings/secrets/actions`
2. 点击 **New repository secret**
3. **Name**: `NPM_TOKEN`
4. **Secret**: 粘贴第 3 步复制的 npm token
5. 点击 **Add secret**

## 5. 确认 GitHub Actions 已正确引用

工作流文件 `.github/workflows/publish.yml` 已经写好了读取逻辑：

```yaml
- name: Publish
  run: npm publish
  env:
    NODE_AUTH_TOKEN: ${{ secrets.NPM_TOKEN }}
```

不需要修改——secret 引用已就位。

## 6. 测试 dry-run 发布

在真正发布之前，确认包不会包含多余文件：

```bash
cd mcp-server
npm pack --dry-run
```

应该只看到 `dist/` 目录下的文件——没有 `*.test.*`，没有 `src/`，没有 `node_modules/`，没有 source map。

## 7. 发布

```bash
# 提交未完成的工作
git add -A
git commit -m "chore: 准备 v1.0.6 发布"

# 打 tag 并推送
git tag v1.0.6
git push origin v1.0.6

# 查看工作流执行情况
open https://github.com/realpkuasule/harness-automation/actions
```

## 8. 验证已发布的包

```bash
npm view @realpkuasule/harness-automation
# 或尝试在其他目录安装：
mkdir /tmp/test-install && cd /tmp/test-install
npm init -y
npm install @realpkuasule/harness-automation
```

## 常见问题

| 问题 | 可能原因 | 解决方法 |
|------|---------|---------|
| `npm publish` 报 403 | 包名已被占用 | 改用 scoped name `@realpkuasule/harness-automation` |
| `npm publish` 报 401 | 没有 token 或 token 无效 | 重新生成 token，更新 GitHub secret |
| 工作流未触发 | tag 未推送成功 | 运行 `git push origin v1.0.6` |
| 包包含测试文件 | `.npmignore` 或 `files` 配置不对 | 运行 `npm pack --dry-run` 检查，调整配置 |
| npm publish 成功但安装失败 | 缺少 `prepublishOnly` 或 build 步骤 | 确认 `package.json` 中有 `"prepublishOnly": "npm run build"` |
| Token 90 天过期后发布失败 | Granular Access Token 到期 | 重新生成 token，更新 GitHub Secret |
