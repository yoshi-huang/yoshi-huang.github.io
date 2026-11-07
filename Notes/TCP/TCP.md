# TCP Reno Lab

互動式 TCP Reno 教學模擬器，以繁體中文呈現封包傳輸時序、壅塞視窗變化與事件紀錄。

## 功能

- 逐事件播放或單步檢視 TCP Reno 傳輸過程
- 拖曳封包調整抵達時間，或切換封包與 ACK 遺失
- 檢視 Sender、Receiver 視窗狀態及 `cwnd`／`ssthresh` 歷史
- 調整初始 `ssthresh`、RTO 與模擬封包數
- 支援桌面與行動版版面

## 本機執行

這是無建置步驟、無外部套件依賴的靜態網站。可直接用瀏覽器開啟 `index.html`，或從專案根目錄啟動任何靜態 HTTP 伺服器。

## 部署到 GitHub Pages

1. 將此專案推送到 GitHub repository。
2. 在 repository 的 **Settings → Pages**，選擇 **Deploy from a branch**。
3. 選擇要發佈的分支及 `/(root)` 資料夾並儲存。

網站由根目錄的 `index.html` 提供，不需要安裝 Node.js、建置或設定環境變數。

## 專案結構

```text
.
├── assets/
│   ├── css/
│   │   └── style.css       # 頁面樣式與響應式版面
│   └── js/
│       ├── tcp-reno.js    # 事件驅動的 TCP Reno 模擬核心
│       ├── tcp-session.js # 使用者編輯狀態與模擬快照
│       ├── chart.js       # cwnd／ssthresh Canvas 圖表
│       └── ui.js          # DOM、時序圖與互動控制
├── docs/
│   └── web-interface-guidelines.md
└── index.html
```

腳本依賴順序由 `index.html` 明確列出：模擬核心、Session、圖表，最後是 UI。

## 維護

- 模擬規則集中在 `assets/js/tcp-reno.js`；畫面程式不自行計算 TCP 狀態。
- 使用者操作與不可變模擬快照由 `assets/js/tcp-session.js` 管理。
- UI 與樣式分開維護，並保持所有資源路徑為相對路徑，以支援 GitHub Pages 專案子路徑。

