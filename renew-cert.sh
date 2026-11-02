#!/bin/bash
# 自签证书自动续期（每 25 天执行一次）
cd /opt/trade-crm/certs || exit 1
openssl req -x509 -newkey rsa:2048 -nodes -sha256 -days 365   -keyout privkey.pem -out fullchain.pem   -subj '/CN=103.236.98.58'   -addext 'subjectAltName=IP:103.236.98.58,DNS:localhost' 2>/dev/null
pm2 restart trade-crm >/dev/null 2>&1
echo "[$(date '+%Y-%m-%d %H:%M')] 证书已续期" >> /opt/trade-crm/certs/renew.log
