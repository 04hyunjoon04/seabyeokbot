"use strict";

// Electron 데스크톱 앱 진입점. 관리 페이지 창을 띄우고 봇 로직은 index.js의 startBot()을 재사용.

const fs = require("fs");
const os = require("os");
const path = require("path");
const { app, BrowserWindow, Menu, dialog, shell, Tray } = require("electron");

// 윈도우 11(빌드 22000 이상) 여부 확인. os.release()는 10/11 모두 "10.0.빌드번호" 형식이라 빌드 번호로만 구분 가능.
function isWindows11() {
  if (process.platform !== "win32") return false;
  const build = Number(os.release().split(".")[2]);
  return Number.isFinite(build) && build >= 22000;
}

// %APPDATA%\새벽봇(구 이름) 데이터가 있고 %APPDATA%\saebyeokbot(현재 이름)이 없으면 최초 실행 시 한 번만 복사.
function migrateOldKoreanUserDataIfNeeded() {
  try {
    const appDataRoot = app.getPath("appData");
    const oldUserDataPath = path.join(appDataRoot, "새벽봇");
    const newUserDataPath = path.join(appDataRoot, "saebyeokbot");
    if (!fs.existsSync(newUserDataPath) && fs.existsSync(oldUserDataPath)) {
      fs.cpSync(oldUserDataPath, newUserDataPath, { recursive: true });
      console.log(`[electron-main] 예전 데이터 폴더(${oldUserDataPath})를 새 위치로 옮겼어요.`);
    }
  } catch (err) {
    console.error("[electron-main] 예전 데이터 폴더 이전 실패(데이터는 예전 위치에 그대로 남아있어요):", err.message);
  }
}

migrateOldKoreanUserDataIfNeeded();
app.setName("saebyeokbot");

// 작업표시줄/알림 센터에서 이 앱을 하나의 프로그램으로 인식시키는 ID.
app.setAppUserModelId("com.saebyeokbot.official");

const { startBot, stopBot, config } = require("./index.js");
const { atomicWriteJson } = require("./src/utils");

let mainWindow = null;
let tray = null;
let isQuitting = false;

// 창 닫기 확인창의 "다음부터 기억하기" 선택을 저장하는 파일. data 폴더에 저장되어 업데이트 후에도 유지됨.
const windowPrefsFilePath = path.join(config.dataDir, "windowPrefs.json");

function loadWindowPrefs() {
  try {
    const raw = fs.readFileSync(windowPrefsFilePath, "utf8");
    return JSON.parse(raw) || {};
  } catch (err) {
    return {};
  }
}

function saveWindowPrefs(prefs) {
  try {
    fs.mkdirSync(path.dirname(windowPrefsFilePath), { recursive: true });
    atomicWriteJson(windowPrefsFilePath, prefs);
  } catch (err) {
    console.error("[electron-main] 창 닫기 설정 저장 실패:", err.message);
  }
}

function createTray() {
  const iconPath = path.join(__dirname, "assets", "tray-icon.png");
  tray = new Tray(iconPath);
  tray.setToolTip("새벽봇");

  const menu = Menu.buildFromTemplate([
    {
      label: "창 열기",
      click: () => {
        if (mainWindow) {
          mainWindow.show();
          mainWindow.restore();
          mainWindow.focus();
        }
      },
    },
    { type: "separator" },
    {
      label: "완전히 종료",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);
  tray.setContextMenu(menu);

  tray.on("click", () => {
    if (!mainWindow) return;
    mainWindow.show();
    mainWindow.restore();
    mainWindow.focus();
  });
}

function createWindow(webServer) {
  const url = `http://localhost:${config.webPort}`;

  // 윈도우 11에서는 Mica 반투명 배경 적용. 윈도우 10에서는 옵션 자체를 넣지 않음.
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 720,
    minHeight: 480,
    title: "새벽봇",
    ...(isWindows11() ? { backgroundMaterial: "mica" } : {}),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  Menu.setApplicationMenu(null);

  // 대시보드에서 여는 외부 링크는 앱 창이 아니라 시스템 브라우저로 오픈.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  function loadDashboard() {
    if (!mainWindow) return;
    mainWindow.loadURL(url).catch(() => {
      setTimeout(loadDashboard, 500); // 웹서버가 아직 뜨는 중이면 재시도
    });
  }

  if (webServer && !webServer.listening) {
    webServer.once("listening", loadDashboard);
    webServer.once("error", loadDashboard);
  } else {
    loadDashboard();
  }

  // X 버튼을 눌러도 즉시 종료하지 않고 완전 종료/백그라운드 실행을 매번 확인. 백그라운드 실행 시 창은 최소화될 뿐 봇은 계속 동작.
  mainWindow.on("close", (event) => {
    if (isQuitting) return;

    event.preventDefault();

    const prefs = loadWindowPrefs();
    if (prefs.closeAction === "minimize") {
      mainWindow.minimize();
      return;
    }
    if (prefs.closeAction === "quit") {
      isQuitting = true;
      app.quit();
      return;
    }

    dialog
      .showMessageBox(mainWindow, {
        type: "question",
        buttons: ["백그라운드에서 계속 실행", "완전히 종료", "취소"],
        defaultId: 0,
        cancelId: 2,
        noLink: true,
        title: "새벽봇 닫기",
        message: "창을 닫으시겠어요?",
        detail:
          "백그라운드에서 계속 실행하면 방송 채팅 봇은 계속 동작하고, 작업표시줄이나 트레이 아이콘에서 다시 열 수 있어요.",
        checkboxLabel: "다음부터 이 설정 기억하기",
        checkboxChecked: false,
      })
      .then(({ response, checkboxChecked }) => {
        if (!mainWindow) return;

        if (response === 0) {
          mainWindow.minimize();
          if (checkboxChecked) saveWindowPrefs({ closeAction: "minimize" });
        } else if (response === 1) {
          if (checkboxChecked) saveWindowPrefs({ closeAction: "quit" });
          isQuitting = true;
          app.quit();
        }
        // 취소는 저장하지 않음
      });
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

async function main() {
  let webServer = null;
  try {
    const result = await startBot();
    webServer = result.webServer;
  } catch (err) {
    console.error("봇 시작 실패:", err);
    dialog.showErrorBox("새벽봇 시작 실패", `봇을 시작하는 중 오류가 발생했어요.\n\n${err.message}`);
  }
  createTray();
  createWindow(webServer);
}

app.whenReady().then(main);

// 완전 종료를 선택했을 때만 여기까지 도달. 백그라운드 실행 시엔 창이 최소화될 뿐 닫히지 않음.
app.on("window-all-closed", () => {
  stopBot();
  app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  stopBot();
});
