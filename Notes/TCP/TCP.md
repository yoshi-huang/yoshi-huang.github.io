# TCP Reno Lab

互動式 TCP Reno 教學模擬器，以繁體中文呈現封包傳輸時序、壅塞視窗變化與事件紀錄。慢啟動採用 Appropriate Byte Counting（ABC，RFC 3465，`L = 2 MSS`）；公告接收視窗 `rwnd` 預設無上限，可在封包時序圖右上方即時調整。

## 功能

- 逐事件播放或單步檢視 TCP Reno 傳輸過程
- 拖曳封包調整抵達時間，或切換封包與 ACK 遺失
- 檢視 Sender、Receiver 視窗狀態及 `cwnd`／`ssthresh` 歷史
- 慢啟動使用 RFC 3465 ABC；每個 ACK 依新確認資料量增加 `cwnd`，一般 `L = 2 MSS`，RTO 後 `L = 1 MSS`
- 壅塞避免累積 `bytes_acked`，達到 `cwnd` 後增加 `1 MSS`
- Receiver 每個資料段都回 ACK；此模型不模擬 delayed ACK
- 在封包時序圖右上方即時調整 `rwnd`（最大有限值跟隨總封包數）；拉桿最右端為無上限，實際可傳送範圍只受 `cwnd` 限制
- 調整初始 `ssthresh`、RTO 與模擬封包數（最多 99 個）
- 支援桌面與行動版版面

## 模型範圍

此專案是 Reno 教學模擬器，不是完整 TCP 協定棧。封包以固定、完整的 1 MSS 段表示，因此 ABC 的 `bytes_acked` 以 MSS 等值單位運算；不模擬部分段／任意位元組 ACK，也不模擬 delayed ACK。路徑採固定傳播延遲，沒有頻寬、序列化時間、排隊或網路競爭。`rwnd` 在單次模擬中固定，滑桿調整會從頭重算；不模擬視窗更新、零視窗探測或視窗縮放。連線建立／關閉、Limited Transmit 與 SACK 也未建模；多個封包同一 flight 遺失時，基本 Reno 可能等 RTO 才恢復。

初始 `cwnd = 1 MSS` 與 `ssthresh = 8 MSS` 是為了教學呈現的起始設定；`ssthresh` 預設不是一般 TCP 建議的高初值。RTO 採 RFC 6298 的 1 秒初值與下限。RFC 3465 是 Experimental RFC；這裡採其 `L = 2 MSS` 建議值，RTO 後遵守 `L = 1 MSS`。若要只採標準軌規則，RFC 5681 的慢啟動增幅為 `min(N, SMSS)`，相當於 `L = 1 MSS`。

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

