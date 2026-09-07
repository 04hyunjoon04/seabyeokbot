"use strict";

// Electron 데스크톱 앱 / CLI 양쪽에서 재사용하는 봇 진입점.
// 이 버전은 치지직 "공식" Open API(OAuth 인가 + 세션 구독)만 사용합니다.
// (봇 전용 네이버 계정 로그인 자동화 없이, 방송인/매니저 계정이 앱에 권한을 한 번 허용하는 방식)

const config = require("./src/config");
const official = require("./src/official/chzzkOfficial");
const oauthClient = require("./src/official/oauthClient");
const { handleChatMessage } = require("./src/commands");
const { startWebServer } = require("./src/web/server");
const botControl = require("./src/botControl");
const { botLog } = require("./src/utils");

let started = false;
let webServerInstance = null;
let sessionStarting = false;
let handlersRegistered = false;

// 봇 세션(인가/채팅 연결) 상태. 관리 페이지의 "계정 연동" 탭에서 이 값을 보여줌.
const botStatus = {
  authReady: false, // 치지직 인가(OAuth)가 완료돼서 연결을 시도할 수 있는 상태인지
  sessionConnected: false, // 지금 채팅 세션에 연결되어있는지
  lastError: null,
};

function getBotStatus() {
  return { ...botStatus };
}

// chat/donation 이벤트 핸들러는 프로세스 생애주기 동안 딱 한 번만 등록합니다.
// (재연결마다 등록하면 이벤트가 중복으로 처리됨)
function registerHandlersOnce() {
  if (handlersRegistered) return;
  handlersRegistered = true;

  official.on("chat", (evt) => {
    handleChatMessage(evt).catch((err) => {
      console.error("[commands] 처리 중 오류:", err);
    });
  });

  official.on("donation", (evt) => {
    // TODO: 후원 감지 후 알림 / 룰렛 트리거 등은 여기서 이어서 구현
  });

  official.on("statusChange", ({ connected }) => {
    botStatus.sessionConnected = !!connected;
  });
}

// 치지직 인가 + 채팅 세션 연결을 (다시) 시작합니다. 최초 실행 때도, "계정 연동" 탭에서
// 사용자가 인가를 새로 마친 뒤 다시 연결할 때도 이 함수를 재사용합니다.
async function startOrRestartSession() {
  if (sessionStarting) return { ok: false, error: "이미 연결을 시도하는 중이에요." };
  sessionStarting = true;

  try {
    official.stop();
    registerHandlersOnce();

    if (!oauthClient.isAuthorized()) {
      botStatus.authReady = false;
      botStatus.sessionConnected = false;
      botStatus.lastError = "치지직 인가가 필요해요. 계정 연동 탭에서 인가를 진행해주세요.";
      botLog.warn(`[bot] ${botStatus.lastError}`);
      return { ok: false, error: botStatus.lastError, needsManualLogin: true };
    }

    botStatus.authReady = true;
    botStatus.lastError = null;

    await official.start();
    await official.refreshBotNickname();
    botStatus.sessionConnected = true;
    botLog.log(`[bot] 채팅 연결 완료 (계정: ${official.getBotNickname() || "알 수 없음"})`);
    return { ok: true };
  } catch (err) {
    botStatus.sessionConnected = false;
    botStatus.lastError = err.message;
    botLog.warn(`[bot] 인가/세션 시작 실패: ${err.message}`);
    return { ok: false, error: err.message };
  } finally {
    sessionStarting = false;
  }
}

// 봇을 시작합니다. CLI(node index.js)에서도, Electron 앱(electron-main.js)에서도
// 똑같이 이 함수를 불러 씁니다. 두 번 이상 불려도 안전하도록 가드를 둠.
//
// 관리 페이지(웹 대시보드)는 인가가 아직 안 되어있어도 항상 먼저 뜨도록 만들었어요 —
// "계정 연동" 탭에서 치지직 인가를 진행할 수 있어야 하니까요.
async function startBot() {
  if (started) return { webServer: webServerInstance };
  started = true;

  console.log("새벽봇을 시작합니다...");

  botControl.register({ getStatus: getBotStatus, restartSession: startOrRestartSession });
  webServerInstance = startWebServer();

  // accessToken(24시간)/refreshToken(30일) 만료 전에 자동으로 갱신 — 앱을 30일 안에
  // 한 번씩만 켜두면 다시 인가할 필요 없이 계속 이어서 쓸 수 있어요.
  oauthClient.startAutoRefresh();

  // 세션 연결은 실패하면 최대 15초까지 걸릴 수 있어서(세션 연결 확인 + 구독까지 실제로
  // 기다림), 여기서 기다렸다가 창을 띄우면 인가가 안 됐거나 연결이 안 될 때 앱 자체가
  // 켜지는 데 오래 걸리는 것처럼 느껴져요. 그래서 창은 바로 뜨게 두고, 연결은 백그라운드에서
  // 진행한 뒤 결과만 로그/상태로 반영해요(관리 페이지가 몇 초마다 상태를 다시 불러오니
  // 연결되면 자동으로 초록불이 켜져요).
  startOrRestartSession()
    .then((result) => {
      if (!result.ok) {
        console.warn(
          "[bot] 아직 치지직 인가가 안 되어있거나 채팅 연결에 실패했어요. 관리 페이지의 '계정 연동' 탭에서 확인해주세요."
        );
      }
    })
    .catch((err) => {
      console.error("[bot] 세션 시작 중 예상치 못한 오류:", err);
    });

  return { webServer: webServerInstance };
}

function stopBot() {
  official.stop();
  oauthClient.stopAutoRefresh();
  if (webServerInstance) webServerInstance.close();
}

module.exports = { startBot, stopBot, startOrRestartSession, getBotStatus, config };

// 터미널에서 직접 `node index.js` 로 실행했을 때만 자동으로 시작 (Electron에서 require할 땐 안 켜짐)
if (require.main === module) {
  startBot().catch((err) => {
    console.error("치명적 오류로 종료합니다:", err);
    process.exit(1);
  });

  process.on("SIGINT", () => {
    console.log("\n종료합니다...");
    stopBot();
    process.exit(0);
  });
}
