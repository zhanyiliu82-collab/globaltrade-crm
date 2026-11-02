#!/bin/bash
# deploy.sh — 服务器一键部署脚本
# 用法：bash /opt/trade-crm/deploy.sh
#
# 安全设计：
#   1. 拉取前检查本地是否有未提交改动，有则中止（防止覆盖服务器上的手工修改）
#   2. 拉取前自动备份代码与数据
#   3. 拉取失败自动回滚到上一个提交
#   4. 只有代码确有变化才重启服务，避免无谓中断
#   5. 重启后做健康检查，失败自动回滚

set -e

APP_DIR="/opt/trade-crm"
BRANCH="main"
HEALTH_URL="http://127.0.0.1:3000/healthz"
STAMP=$(date +%Y%m%d-%H%M%S)

RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m'

log()  { echo -e "${GREEN}[部署]${NC} $1"; }
warn() { echo -e "${YELLOW}[注意]${NC} $1"; }
fail() { echo -e "${RED}[中止]${NC} $1"; exit 1; }

cd "$APP_DIR" || fail "目录不存在：$APP_DIR"

# ── 1. 检查未提交改动 ──
DIRTY=$(git status --porcelain --untracked-files=no)
if [ -n "$DIRTY" ]; then
  echo ""
  warn "检测到服务器上存在未提交的代码改动："
  echo ""
  echo "$DIRTY" | sed 's/^/    /'
  echo ""
  echo "  这些改动不是来自 Git 仓库，直接部署会被覆盖丢失。"
  echo ""
  echo "  请选择处理方式："
  echo "    A. 保留改动，先提交：git add -A && git commit -m \"说明\" && git push"
  echo "    B. 放弃改动，恢复仓库版本：git checkout -- ."
  echo "    C. 查看具体差异：git diff"
  echo ""
  fail "已中止部署，未做任何改动。"
fi

# ── 2. 记录当前版本 ──
PREV_COMMIT=$(git rev-parse HEAD)
log "当前版本：${PREV_COMMIT:0:7}"

# ── 3. 备份代码与数据 ──
mkdir -p /opt/deploy-backups
tar czf "/opt/deploy-backups/code-${STAMP}.tar.gz" \
  --exclude=node_modules --exclude=backups --exclude=certs --exclude=data.json \
  . 2>/dev/null || true
if [ -f data.json ]; then
  cp data.json "/opt/deploy-backups/data-${STAMP}.json"
fi
log "已备份代码与数据到 /opt/deploy-backups/"
# 只保留最近 20 份
ls -1t /opt/deploy-backups/code-*.tar.gz 2>/dev/null | tail -n +21 | xargs -r rm -f
ls -1t /opt/deploy-backups/data-*.json 2>/dev/null | tail -n +21 | xargs -r rm -f

# ── 4. 拉取最新代码 ──
log "正在从 GitHub 拉取 ${BRANCH} 分支…"
if ! git fetch origin "$BRANCH" 2>&1 | sed 's/^/    /'; then
  fail "拉取失败，网络或权限问题。未做任何改动。"
fi

git reset --hard "origin/${BRANCH}" >/dev/null 2>&1 || fail "重置到远程分支失败"
NEW_COMMIT=$(git rev-parse HEAD)
log "最新版本：${NEW_COMMIT:0:7}"

# ── 5. 判断是否需要重启 ──
if [ "$PREV_COMMIT" = "$NEW_COMMIT" ]; then
  log "代码已是最新，无需重启服务。"
  exit 0
fi

CHANGED=$(git diff --name-only "$PREV_COMMIT" "$NEW_COMMIT")
log "本次变更文件："
echo "$CHANGED" | sed 's/^/    /'

# ── 6. 依赖是否变化 ──
if echo "$CHANGED" | grep -qE '^package(-lock)?\.json$'; then
  log "检测到依赖变更，正在安装…"
  npm install --omit=dev --no-audit --no-fund 2>&1 | tail -n 3 | sed 's/^/    /'
fi

# ── 7. 重启服务 ──
log "正在重启服务…"
pm2 restart trade-crm >/dev/null 2>&1
sleep 4

# ── 8. 健康检查 ──
HEALTH=$(curl -s -m 10 "$HEALTH_URL" || echo "")
if echo "$HEALTH" | grep -q '"status":"ok"'; then
  log "健康检查通过：$HEALTH"
  log "部署完成，版本 ${NEW_COMMIT:0:7}"
else
  warn "健康检查未通过，正在回滚…"
  git reset --hard "$PREV_COMMIT" >/dev/null 2>&1
  pm2 restart trade-crm >/dev/null 2>&1
  sleep 3
  fail "已回滚到 ${PREV_COMMIT:0:7}。请检查 pm2 logs trade-crm"
fi
