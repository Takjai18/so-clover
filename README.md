# 🍀 四葉草神聯想 (So Clover!)

跨團契破冰桌遊《So Clover!》嘅 Mode C 網頁版。手機掃 QR Code 入房秘密寫提示，主持大螢幕旋轉字卡同計分。未連上房間時可以單機出題。

## 檔案

- `public/index.html` — 主持大螢幕、手機出題、音效、題庫編輯器
- `worker.js` — 每個房間一個 SQLite Durable Object，WebSocket 路徑係 `/ws`
- `wrangler.jsonc` — Cloudflare Workers 設定

## 本地

```bash
CI=1 npx --yes wrangler@4 dev
```

## 部署

```bash
CI=1 npx --yes wrangler@4 deploy
```

線上網址：https://so-clover.ymtwill.workers.dev/

開波之後撳「我係主持」或者「我係團友」。右上角 QR Code 會帶 `?room=`，手機入到同一個房號。
