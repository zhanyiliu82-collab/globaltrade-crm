# GlobalTrade CRM

通用外贸智能管理平台 —— 一个轻量级、自托管的外贸 CRM 系统。

面向中小外贸团队的客户管理、跟进记录、产品主数据与出口单证管理。单文件数据库存储，零外部依赖，可在 2 GB 内存的入门级云服务器上稳定运行。

---

## 功能特性

### 客户与跟进

- 客户档案管理（企业名称、国家、联系人、邮箱、电话、主营品类）
- 五阶段销售漏斗：潜在潜客 → 初步接洽 → 样品验证 → 商机报价 → 赢单成交
- 私海 / 公海双池模式，支持客户流转与认领
- 多轮跟进记录与完整时间线
- **防撞单查重**：录入时自动校验企业全称与邮箱重复，拦截同一客户被重复跟进

### 外贸业务特性

- **43 国时区映射**：根据客户所在国家自动换算当地时间，标注工作 / 休息 / 深夜状态，并提供国旗标识
- **全球节日日历**：内置主要出口市场的法定节假日，自动计算倒计时与临近提醒
- **世界时钟墙**：19 个全球贸易枢纽实时走时（秒级更新）
- **产品主数据库**：SKU、中英文品名、海关 HS 编码、出口退税率、包装箱规
- **自动箱规测算**：输入外箱长宽高自动折算 CBM、单箱毛净重，估算 20GP / 40HQ 装柜量
- **PI 形式发票**：多商品行、多币种、国际贸易条款，自动累加金额与包装数据
- **装箱单（Packing List）**：一键从 PI 生成国际标准装箱单，含箱号区间、净重、毛重、体积汇总
- **PI 与装箱单均支持浏览器打印 / 另存为 PDF**

### AI 开发信引擎

内置 4 种开发信策略模板，根据客户国家、产品与业务场景生成英文 Cold Email：

- 卓越品质与国际认证
- 工厂直营与低 MOQ 试样
- 快速定制打样与交期保证
- 海外节日温情问候

> 说明：这是基于模板规则的本地生成，不调用外部大模型 API。

### 账号与安全

三种登录方式：

1. **账号密码登录** —— SHA-256 哈希校验
2. **手机验证码登录** —— 首次使用自动建档
3. **自主注册** —— 强制绑定手机短信验证码

安全机制：

- 全局 API 强制鉴权，未登录一律 401
- 基于 Token 的内存会话管理
- 业务员数据隔离：普通业务员只能看到自己名下客户与公海池，管理员可看全盘
- 登录页不透露任何默认账号信息

### 工程可靠性

- **全局防崩溃守卫**：捕获 `uncaughtException` 与 `unhandledRejection`，单点异常不会导致进程退出
- **原子文件写入**：先写临时文件再 `rename` 替换，多人并发写入不会损坏数据
- **PM2 进程守护**：崩溃自动重启，支持开机自启
- **HTTPS 支持**：可同时监听 HTTP 与 HTTPS，证书存在即启用，可热加载
- **健康检查接口**：`GET /healthz` 返回服务状态与运行时长

---

## 技术栈

| 层次 | 选型 |
| :--- | :--- |
| 运行时 | Node.js 18+ |
| 后端框架 | Express 5 |
| 数据存储 | JSON 单文件（原子写入） |
| 前端 | 原生 HTML + CSS + JavaScript（无构建步骤） |
| 进程管理 | PM2（生产环境） |

**没有前端构建流程，没有外部数据库，没有第三方 UI 框架依赖。** 克隆下来装两个 npm 包就能跑。

---

## 快速开始

### 环境要求

- Node.js 18 或更高版本
- npm

### 本地运行

```bash
git clone <your-repo-url>
cd trade-crm
npm install
npm start
```

打开浏览器访问 `http://localhost:3000`。

首次启动时系统会自动创建 `data.json`，但**不会创建任何账号**——请点击登录页的「✨ 创建新账号」注册第一个账号，或直接调用注册接口。

### 注册第一个账号

访问首页后点击「创建新账号」，填写：

- 登录账号、真实姓名、登录密码
- 手机号码 + 短信验证码（本地环境验证码会直接显示在页面上）

注册成功后自动登录，该账号角色为「业务员」。如果需要一个**管理员**账号，可在注册后手动修改 `data.json`：

```json
"role": "管理员"
```

---

## 环境变量

| 变量 | 默认值 | 说明 |
| :--- | :--- | :--- |
| `PORT` | `3000` | HTTP 监听端口 |
| `HTTPS_PORT` | `443` | HTTPS 监听端口 |
| `DATA_FILE` | `./data.json` | 数据文件路径 |
| `CERT_DIR` | `./certs` | 证书目录 |

### 启用 HTTPS

把证书放进 `CERT_DIR` 目录：

```
certs/
├── privkey.pem     # 私钥
└── fullchain.pem   # 证书链（服务器证书 + 中间证书 + 根证书）
```

重启服务即可启用 HTTPS。若目录不存在或文件缺失，系统只跑 HTTP，不会报错崩溃。

---

## API 概览

所有业务接口都需要携带 Token：

```
Authorization: Bearer <token>
```

### 认证

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| POST | `/api/auth/register` | 注册（需手机验证码） |
| POST | `/api/auth/login` | 账号密码登录 |
| POST | `/api/auth/login-sms` | 手机验证码登录 |
| POST | `/api/auth/send-sms` | 发送验证码 |
| GET | `/api/auth/me` | 校验 Token 并获取当前用户 |
| POST | `/api/auth/logout` | 退出登录 |
| POST | `/api/auth/change-password` | 修改密码 |

### 业务

| 方法 | 路径 | 说明 |
| :--- | :--- | :--- |
| GET | `/api/dashboard/stats` | 看板统计（按用户权限过滤） |
| GET / POST | `/api/customers` | 客户列表 / 新建客户 |
| POST | `/api/customers/:id/transfer` | 移入公海 / 捞回私海 |
| DELETE | `/api/customers/:id` | 删除客户 |
| GET / POST | `/api/followups` | 跟进记录 |
| GET / POST | `/api/products` | 产品库 |
| DELETE | `/api/products/:id` | 删除产品 |
| GET / POST | `/api/quotations` | PI 与装箱单 |
| DELETE | `/api/quotations/:id` | 删除单证 |
| GET | `/healthz` | 健康检查（无需认证） |

---

## 关于短信验证码

**当前版本的短信验证码是模拟的。**

调用 `/api/auth/send-sms` 时，验证码会：

1. 直接返回给前端并显示在页面上
2. 打印在服务端控制台

这方便本地开发和演示，但**不具备任何真实验证能力**——任何知道手机号的人都能拿到验证码。

**生产环境请接入真实短信服务。** 修改 `server.js` 中 `/api/auth/send-sms` 路由，把生成验证码后的 `console.log` 替换为调用云短信 SDK（阿里云短信、腾讯云短信等）即可。

---

## 部署

### 方式一：PM2（推荐）

```bash
npm install -g pm2
cd trade-crm
npm install --omit=dev
pm2 start server.js --name trade-crm
pm2 save
pm2 startup
```

### 方式二：前台运行

```bash
npm start
```

### 反向代理

如需用 Nginx 反代并绑定域名：

```nginx
server {
    listen 80;
    server_name crm.example.com;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_http_version 1.1;
        proxy_set_header Host $host;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header X-Forwarded-Proto $scheme;
    }
}
```

---

## 数据备份

所有数据存放在单个 `data.json` 文件中。备份只需复制该文件：

```bash
cp data.json backups/data-$(date +%Y%m%d).json
```

建议加一条定时任务，每天自动备份并保留 30 天：

```cron
0 3 * * * cd /path/to/trade-crm && cp data.json backups/data-$(date +\%Y\%m\%d).json && find backups -mtime +30 -delete
```

---

## 已知限制

| 限制 | 说明 |
| :--- | :--- |
| 并发规模 | 单文件 JSON 存储，适合 1-20 人团队。更大规模建议迁移 SQLite 或 MySQL |
| 短信验证 | 当前为模拟实现，生产环境需接入真实短信服务 |
| 会话持久化 | Token 存在内存中，服务重启后所有用户需重新登录（这是有意的安全设计） |
| 开发信生成 | 基于模板规则，非真实大模型调用 |

---

## 项目结构

```
trade-crm/
├── server.js              # 后端主程序（Express + 全部业务逻辑）
├── package.json
├── data.example.json      # 数据文件模板（实际 data.json 不入库）
├── public/
│   └── index.html         # 前端单页应用（HTML + CSS + JS 内联）
└── .gitignore
```

---

## 许可

MIT License，详见 [LICENSE](LICENSE)。

---

## 说明

本项目为独立自研实现。业务功能设计参考了市面常见外贸 ERP 的通用流程，但代码、界面与数据结构均为原创，未使用任何第三方产品的前端资源或接口。
