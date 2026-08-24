#!/bin/bash
cd "/Users/katadatomoaki/Desktop/peops office/請求書管理アプリ"

if ! lsof -i :8090 -sTCP:LISTEN -t >/dev/null 2>&1; then
  echo "請求書・納品書管理アプリを起動しています..."
  nohup node server.js > /tmp/peops-invoice-app.log 2>&1 &
  disown
  sleep 1
else
  echo "すでに起動しています。"
fi

open "http://localhost:8090"
echo "ブラウザが開きました。このウィンドウは閉じて大丈夫です。"
sleep 3
