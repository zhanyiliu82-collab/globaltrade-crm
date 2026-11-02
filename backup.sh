#!/bin/bash
cd /opt/trade-crm || exit 1
STAMP=$(date +%Y%m%d-%H%M%S)
cp data.json "backups/data-${STAMP}.json"
# 只保留最近 30 份
ls -1t backups/data-*.json 2>/dev/null | tail -n +31 | xargs -r rm -f
echo "[$(date "+%Y-%m-%d %H:%M:%S")] 备份完成: data-${STAMP}.json" >> backups/backup.log
