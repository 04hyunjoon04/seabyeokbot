"use strict";

// Electron 데스크톱 앱의 진입점. 콘솔 창 없이 일반 프로그램처럼 창 하나가 뜨고,
// 그 안에서 지금까지 만든 관리 페이지(로컬 웹서버)를 그대로 보여줍니다.
// 봇 자체(로그인/채팅 연결/명령어 처리)는 기존 index.js의 startBot()을 그대로 재사용해요.
//
// 창을 X로 닫아도 봇은 계속 방송 채팅에 붙어있어야 하므로, X를 누르면 바로 종료하지
// 않고 "완전히 종료할지 / 백그라운드에서 계속 실행할지" 물어봅니다. 트레이(알림 영역)
// 아이콘으로도 언제든 창을 다시 열거나 완전히 종료할 수 있어요.

const fs = require("fs");
const path = require("path");
const { app, BrowserWindow, Menu, dialog, shell, Tray } = require("electron");

// index.js(→config.js)가 사용자 데이터 폴더 경로(app.getPath("userData"))를 계산하기 전에
// 앱 이름을 먼저 정해둬야, 데이터(+.env)가 그 이름의 폴더에 저장돼요.
//
// 예전에는 한글 이름("새벽봇")을 그대로 썼는데, 한글 경로는 일부 도구(백신, 특정
// 라이브러리 등)에서 문제를 일으킬 수 있어서 영문 이름("saebyeokbot")으로 바꿨어요.
// 화면에 보이는 이름(창 제목, 트레이 등)은 여전히 "새벽봇"이고, 내부 저장 폴더
// 이름만 영문으로 바뀌는 거예요.
//
// 다만 이렇게 이름만 덜컥 바꾸면, 예전 버전을 쓰던 사람은 데이터가 여전히
// %APPDATA%\새벽봇 에 있는데 새 버전은 %APPDATA%\saebyeokbot 을 보게 되어
// "데이터가 초기화된 것처럼" 보이는 문제가 생겨요. 그래서 새 폴더가 아직 없고
// 예전(한글 이름) 폴더가 있으면, 최초 실행 시 한 번만 그대로 복사해서 옮겨줘요.
function migrateOldKoreanUserDataIfNeeded() {
  try {
    const appDataRoot = app.getPath("appData"); // 예: C:\Users\XXX\AppData\Roaming (앱 이름과 무관)
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

const { startBot, stopBot, config } = require("./index.js");

let mainWindow = null;
let tray = null;
let isQuitting = false;

// "창 닫기" 물어보는 창에서 "다음부터 이 설정 기억하기"를 체크했을 때 그 선택을
// 저장해두는 파일. data 폴더(=%APPDATA%\saebyeokbot\data\)에 저장되니까 새 버전을
// 설치해도 그대로 유지돼요.
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
    fs.writeFileSync(windowPrefsFilePath, JSON.stringify(prefs, null, 2), "utf8");
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

  mainWindow = new BrowserWindow({
    width: 1100,
    height: 750,
    minWidth: 720,
    minHeight: 480,
    title: "새벽봇",
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  Menu.setApplicationMenu(null); // 파일/편집/보기 같은 기본 메뉴바 숨김 (깔끔하게)

  // 대시보드에서 여는 외부 링크(치지직 로그인/인가 페이지 등)는 앱 안이 아니라
  // 사용자의 실제 브라우저로 열어줌 (이미 로그인돼있을 수 있고, 보안상으로도 이게 맞음)
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: "deny" };
  });

  function loadDashboard() {
    if (!mainWindow) return;
    mainWindow.loadURL(url).catch(() => {
      setTimeout(loadDashboard, 500); // 웹서버가 아직 뜨는 중이면 잠시 후 재시도
    });
  }

  if (webServer && !webServer.listening) {
    webServer.once("listening", loadDashboard);
    webServer.once("error", loadDashboard);
  } else {
    loadDashboard();
  }

  // X 버튼을 눌러도 바로 종료하지 않고 매번 물어봄. "백그라운드 실행"을 고르면
  // 창을 완전히 숨기지 않고 최소화만 해서 작업표시줄 버튼은 그대로 남겨둠 —
  // 그래야 트레이를 몰라도 작업표시줄에서 바로 다시 열 수 있음. 봇 자체는
  // 창 상태와 무관하게 계속 돌아감(연결 유지).
  mainWindow.on("close", (event) => {
    if (isQuitting) return; // 트레이의 "완전히 종료" 등으로 진짜 종료하는 경우엔 그대로 닫힘

    event.preventDefault();

    // 예전에 "다음부터 이 설정 기억하기"를 체크해서 저장해둔 선택이 있으면
    // 다시 물어보지 않고 바로 그 선택대로 처리함.
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
        if (!mainWindow) return; // 다이얼로그가 떠있는 동안 창이 이미 없어졌으면 아무 것도 안 함

        if (response === 0) {
          mainWindow.minimize();
          if (checkboxChecked) saveWindowPrefs({ closeAction: "minimize" });
        } else if (response === 1) {
          if (checkboxChecked) saveWindowPrefs({ closeAction: "quit" });
          isQuitting = true;
          app.quit();
        }
        // response === 2 (취소): 체크박스를 체크했어도 저장하지 않음 — "취소"는 기억할
        // 선택이 아니니까요. 아무 것도 안 하고 창을 그대로 둠.
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

// 모든 창이 닫혀도(=완전 종료를 선택했을 때만 실제로 여기까지 옴) 앱을 종료함.
// 백그라운드 실행을 선택한 경우엔 창이 minimize될 뿐 닫히지 않으므로 여기 도달하지 않음.
app.on("window-all-closed", () => {
  stopBot();
  app.quit();
});

app.on("before-quit", () => {
  isQuitting = true;
  stopBot();
});
