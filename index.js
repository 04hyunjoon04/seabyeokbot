"use strict";

// Electron 앱과 CLI에서 공통으로 쓰는 봇 진입점. 치지직 공식 Open API(OAuth 인가 + 세션 구독)만 사용.

const config = require("./src/config");
const official = require("./src/official/chzzkOfficial");
const oauthClient = require("./src/official/oauthClient");
const { handleChatMessage } = require("./src/commands");
const { startWebServer } = require("./src/web/server");
const botControl = require("./src/botControl");
const commandStore = require("./src/commandStore");
const { botLog } = require("./src/utils");
const eventBus = require("./src/eventBus");

let started = false;
let webServerInstance = null;
let sessionStarting = false;
let handlersRegistered = false;

// 봇 세션 상태. 관리 페이지 "계정 연동" 탭에서 표시.
const botStatus = {
  authReady: false,
  sessionConnected: false,
  lastError: null,
};

function getBotStatus() {
  return { ...botStatus };
}

// chat/donation 핸들러는 프로세스 생애주기 동안 한 번만 등록.
function registerHandlersOnce() {
  if (handlersRegistered) return;
  handlersRegistered = true;

  official.on("chat", (evt) => {
    handleChatMessage(evt).catch((err) => {
      console.error("[commands] 처리 중 오류:", err);
    });
  });

  official.on("donation", (evt) => {
    // TODO: 후원 감지 후 알림 / 룰렛 트리거
  });

  official.on("statusChange", ({ connected }) => {
    botStatus.sessionConnected = !!connected;
    eventBus.emit("bot-status");
  });
}

// 인가 + 채팅 세션 연결을 (다시) 시작.
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
    eventBus.emit("bot-status");
  }
}

// 봇 시작. 두 번 이상 호출돼도 안전.
async function startBot() {
  if (started) return { webServer: webServerInstance };
  started = true;

  console.log("새벽봇을 시작합니다...");

  botControl.register({ getStatus: getBotStatus, restartSession: startOrRestartSession });
  webServerInstance = startWebServer();

  // accessToken/refreshToken 만료 전 자동 갱신
  oauthClient.startAutoRefresh();

  // 세션 연결은 최대 15초 걸릴 수 있어 창을 먼저 띄우고 백그라운드로 진행. 결과는 상태로 반영되어 관리 페이지에 표시됨.
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
  commandStore.flush(); // 디바운스된 사용 횟수 저장을 즉시 처리
  if (webServerInstance) webServerInstance.close();
}

module.exports = { startBot, stopBot, startOrRestartSession, getBotStatus, config };

// `node index.js`로 직접 실행했을 때만 자동 시작
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
