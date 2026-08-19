# OMP Studio Desktop App Plan

> Status: historical bootstrap plan. The Electron shell described here is now
> implemented in `packages/studio-desktop/`. The active product and delivery
> roadmap is [Studio Workbench Plan](./studio-workbench-plan.md).

## Mục tiêu
Biến OMP Studio từ web app (Bun server + React client) thành desktop app sử dụng Electron, tương tự như Hermes Studio.

## Kiến trúc hiện tại
```
OMP Studio (Web)
├── packages/studio/src/server.ts     → Bun server (REST + WebSocket)
├── packages/studio/src/client/       → React client
├── packages/studio/src/core/         → SQLite, workspace, lease
└── Command: omp studio               → Start server & open browser
```

## Kiến trúc Desktop mục tiêu
```
OMP Studio Desktop
├── packages/studio-desktop/
│   ├── src/main/
│   │   ├── index.ts                 → Electron main process
│   │   ├── studio-server.ts         → Embed Bun server
│   │   ├── window-manager.ts        → BrowserWindow management
│   │   ├── tray.ts                  → System tray
│   │   └── paths.ts                 → Desktop paths
│   ├── src/preload/
│   │   └── index.ts                 → IPC bridge
│   ├── build/                       → Icons, assets
│   ├── electron-builder.yml         → Build config
│   └── package.json
└── Command: omp-studio.exe          → Native desktop app
```

## Các bước thực hiện

### Phase 1: Setup Electron Infrastructure
- [ ] Tạo package `packages/studio-desktop`
- [ ] Cài đặt Electron + Electron Builder dependencies
- [ ] Tạo main process entry point
- [ ] Tạo preload script cho IPC security
- [ ] Cấu hình electron-builder.yml

### Phase 2: Embed Studio Server
- [ ] Refactor `packages/studio/src/server.ts` thành module có thể embed
- [ ] Main process khởi động Bun server internally
- [ ] Quản lý lifecycle: start server → wait ready → open window
- [ ] Handle server port conflicts
- [ ] Graceful shutdown khi quit app

### Phase 3: Window Management
- [ ] Tạo main window với BrowserWindow
- [ ] Load client từ embedded server (http://127.0.0.1:<port>)
- [ ] Window state persistence (size, position)
- [ ] Minimize to tray
- [ ] Tray menu (Show, Hide, Quit)
- [ ] Custom title bar (optional)

### Phase 4: Security & IPC
- [ ] Implement preload script
- [ ] IPC channels cho:
  - File dialogs (workspace selection)
  - Notifications
  - System tray updates
  - Deep links
- [ ] Context isolation
- [ ] Content Security Policy

### Phase 5: Assets & Branding
- [ ] Tạo icons (icon.ico, icon.icns, icon.png)
- [ ] Tray icons (Windows, macOS)
- [ ] App metadata (name, description, copyright)
- [ ] Splash screen (optional)

### Phase 6: Build & Distribution
- [ ] Configure electron-builder targets:
  - Windows: NSIS installer (.exe)
  - macOS: DMG + ZIP (arm64, x64)
  - Linux: AppImage + DEB
- [ ] Code signing (optional)
- [ ] Auto-updater integration (optional)
- [ ] Build scripts:
  ```bash
  npm run build:desktop:win
  npm run build:desktop:mac
  npm run build:desktop:linux
  ```

### Phase 7: Runtime Dependencies
- [ ] Bundle Node.js (hoặc dùng Electron's built-in)
- [ ] SQLite binaries (better-sqlite3)
- [ ] Native modules (node-pty nếu cần terminal)
- [ ] Prune unnecessary files để giảm kích thước

## So sánh với Hermes Studio

| Feature | Hermes Studio | OMP Studio Desktop |
|---------|---------------|-------------------|
| Main framework | Electron | Electron |
| Backend | Koa server | Bun server (embedded) |
| Frontend | Vue 3 | React |
| Database | N/A | SQLite (đã có) |
| CLI integration | hermes-agent bundled | omp CLI reference |
| Tray support | ✓ | ✓ (planned) |
| Auto-updater | ✓ | Optional |
| Platform | Win/Mac/Linux | Win/Mac/Linux |

## Dependencies cần thêm

```json
{
  "devDependencies": {
    "electron": "^33.0.0",
    "electron-builder": "^26.0.0",
    "@types/node": "^22.0.0",
    "typescript": "^5.6.0"
  },
  "dependencies": {
    "electron-updater": "^6.0.0"
  }
}
```

## File structure mẫu

```
packages/studio-desktop/
├── build/
│   ├── icon.ico              # Windows
│   ├── icon.icns             # macOS
│   ├── icon.png              # Linux
│   ├── trayWindows.png
│   └── trayMac.png
├── src/
│   ├── main/
│   │   ├── index.ts          # Electron app entry
│   │   ├── studio-server.ts  # Start embedded Bun server
│   │   ├── window-manager.ts
│   │   ├── tray-manager.ts
│   │   └── paths.ts
│   └── preload/
│       └── index.ts
├── electron-builder.yml
├── package.json
└── tsconfig.json
```

## Electron Main Process Example

```typescript
// packages/studio-desktop/src/main/index.ts
import { app, BrowserWindow, Tray } from 'electron'
import { startStudioServer, stopStudioServer } from './studio-server'

let mainWindow: BrowserWindow | null = null
let serverUrl: string | null = null

app.whenReady().then(async () => {
  // Start embedded studio server
  serverUrl = await startStudioServer()
  
  // Create main window
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
    }
  })
  
  // Load from embedded server
  mainWindow.loadURL(serverUrl)
})

app.on('before-quit', async () => {
  await stopStudioServer()
})
```

## Build Commands

```bash
# Development
npm run desktop:dev

# Production builds
npm run build:desktop:win    # Windows .exe
npm run build:desktop:mac    # macOS .dmg
npm run build:desktop:linux  # Linux AppImage

# All platforms
npm run build:desktop
```

## Next Steps

1. Bạn có muốn tôi bắt đầu implement Phase 1 (Setup Electron Infrastructure) không?
2. Hoặc bạn muốn xem code example chi tiết hơn cho một phần cụ thể?
3. Có yêu cầu đặc biệt nào về UI/UX desktop không (custom title bar, frameless window, etc.)?
