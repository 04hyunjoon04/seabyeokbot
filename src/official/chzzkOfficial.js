"use strict";

// 치지직 "공식" Open API만 사용하는 채팅 클라이언트.
// index.js/commands 쪽 코드가 start/stop/on/sendChat/... 인터페이스로 이 모듈을 그대로 씀.
//
// 동작 방식 (공식 문서 기준):
//  1. OAuth로 accessToken 발급 (oauthClient.js) — 인가한 계정(방송인 또는 매니저 계정) 권한으로 동작
//  2. GET /open/v1/sessions/auth (Bearer) 로 세션 서버 URL을 받음
//  3. 그 URL로 Socket.IO(v1~2.0.3 호환) 연결 → "SYSTEM" 이벤트로 sessionKey를 받음
//  4. sessionKey로 채팅/후원 이벤트 구독 요청 (REST)
//  5. 이후 소켓으로 들어오는 CHAT/DONATION 이벤트를 그대로 emitter에 전달
//
// 참고 문서:
//  https://chzzk.gitbook.io/chzzk/chzzk-api/session
//  https://chzzk.gitbook.io/chzzk/chzzk-api/chat
//  https://chzzk.gitbook.io/chzzk/llms-full.txt (임시제한 등)

const { EventEmitter } = require("events");
const io = require("socket.io-client");
const config = require("../config");
const oauthClient = require("./oauthClient");
const { botLog } = require("../utils");

const emitter = new EventEmitter();

let socket = null;
let stopped = true;
let connected = false;
let starting = false; // start()가 이미 진행 중이면 또 다른 start()가 겹쳐서 소켓이 두 개 생기는 걸 막음
let reconnectTimer = null; // 예약된 재연결 타이머 — stop()에서 취소할 수 있도록 핸들을 들고 있음
let reconnectAttempt = 0;
let botNickname = null;
let botChannelId = null; // 봇 자신의 채널 ID (참고용 — 더 이상 이걸로 통째로 거르지 않음, 아래 설명 참고)
let recentSentMessages = []; // 봇이 sendChat()으로 방금 직접 보낸 메시지만 기록 (내용+시각)
const SELF_ECHO_WINDOW_MS = 8000; // 이 시간 안에 되돌아온 "내가 보낸 것과 똑같은 내용"만 자기 메시지로 간주

// 세션 소켓으로 들어오는 이벤트 데이터는 객체가 아니라 JSON 문자열로 오는 걸로 확인됐어요
// (예: SYSTEM 이벤트가 '{"type":"connected","data":{...}}' 형태의 문자열). 이미 객체로
// 온 경우도 안전하게 처리할 수 있도록 문자열일 때만 파싱해요.
function parsePayload(raw) {
  if (typeof raw === "string") {
    try {
      return JSON.parse(raw);
    } catch (err) {
      botLog.error(`[official] 이벤트 데이터 파싱 실패: ${err.message}`);
      return null;
    }
  }
  return raw;
}

function mapEvent(data) {
  // 문서상으로는 userRoleCode가 이벤트 최상위 필드로 나온다고 되어있지만, 실제 응답은
  // profile.userRoleCode 안에 들어있는 걸로 확인됐어요(둘 다 대비해서 최상위도 폴백으로 봄).
  const userRoleCode = (data.profile && data.profile.userRoleCode) || data.userRoleCode;
  return {
    content: data.content || data.message,
    profile: { nickname: (data.profile && data.profile.nickname) || data.donatorNickname || "익명" },
    senderChannelId: data.senderChannelId || data.donatorChannelId,
    userRoleCode,
    chatChannelId: data.chatChannelId,
    messageTime: data.messageTime || Date.now(),
  };
}

async function authedFetch(pathname, { method = "GET", body } = {}) {
  const accessToken = await oauthClient.ensureValidToken();
  const res = await fetch(new URL(pathname, config.apiBaseUrl), {
    method,
    headers: {
      Authorization: oauthClient.getAuthHeader(accessToken),
      "Content-Type": "application/json",
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.code !== 200) {
    const message = (json && json.message) || `HTTP ${res.status}`;
    throw new Error(`[공식 API] ${method} ${pathname} 실패: ${message}`);
  }
  return json.content;
}

function scheduleReconnect() {
  if (stopped) return;
  if (reconnectTimer) return; // 이미 재연결이 예약돼있으면 중복으로 또 예약하지 않음
  reconnectAttempt += 1;
  const delay = Math.min(30000, 2000 * reconnectAttempt);
  botLog.log(`[official] ${Math.round(delay / 1000)}초 후 재연결을 시도합니다.`);
  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    if (stopped) return;
    start().catch((err) => {
      botLog.error(`[official] 재연결 실패: ${err.message}`);
      scheduleReconnect();
    });
  }, delay);
}

async function subscribeEvents(sessionKey) {
  await authedFetch(`/open/v1/sessions/events/subscribe/chat?sessionKey=${encodeURIComponent(sessionKey)}`, {
    method: "POST",
  });
  await authedFetch(`/open/v1/sessions/events/subscribe/donation?sessionKey=${encodeURIComponent(sessionKey)}`, {
    method: "POST",
  });
}

// start()는 소켓만 열어놓고 바로 끝나는 게 아니라, 실제로 "SYSTEM(connected)" 이벤트를
// 받고 구독까지 성공해야 resolve돼요. (예전엔 io.connect() 호출만 하고 바로 resolve해버려서,
// 실제로는 연결/구독이 실패했는데도 관리 페이지엔 "연결 완료"로 나오는 문제가 있었어요.)
function start() {
  return new Promise((resolve, reject) => {
    if (!oauthClient.isAuthorized()) {
      reject(new Error("치지직 인가가 필요해요. 계정 연동 탭에서 인가를 진행해주세요."));
      return;
    }
    // 이전 start()가 아직 연결/구독 진행 중인데 또 start()가 불리면(예: 재연결 타이머랑
    // 수동 "다시 연결"이 겹칠 때) 소켓이 두 개 생겨서 채팅 이벤트/명령어 응답이 중복돼요.
    // 그래서 진행 중일 땐 새 시도를 거절하고, 먼저 시작된 시도가 끝난 뒤 다시 시도하게 함.
    if (starting) {
      reject(new Error("이미 연결을 시도하는 중이에요."));
      return;
    }
    starting = true;
    stopped = false;

    let settled = false;
    const settleResolve = () => {
      if (settled) return;
      settled = true;
      starting = false;
      clearTimeout(connectTimeout);
      resolve();
    };
    const settleReject = (err) => {
      if (settled) return;
      settled = true;
      starting = false;
      clearTimeout(connectTimeout);
      reject(err);
    };

    const connectTimeout = setTimeout(() => {
      settleReject(new Error("세션 연결이 15초 안에 끝나지 않았어요(시간 초과)."));
    }, 15000);

    authedFetch("/open/v1/sessions/auth")
      .then((sessionInfo) => {
        const sessionUrl = sessionInfo && sessionInfo.url;
        if (!sessionUrl) {
          settleReject(new Error("세션 서버 주소를 받지 못했어요."));
          return;
        }

        // URL 자체엔 인가 토큰이 쿼리로 이미 포함되어 있어서 로그에 그대로 남기면 위험해요 —
        // 호스트 부분만 남기고 잘라서 로그에 남김
        try {
          const u = new URL(sessionUrl);
          botLog.log(`[official] 세션 서버(${u.host})에 연결을 시도합니다.`);
        } catch (err) {
          botLog.log("[official] 세션 서버에 연결을 시도합니다.");
        }

        socket = io.connect(sessionUrl, {
          reconnection: false,
          "force new connection": true,
          "connect timeout": 10000,
          transports: ["websocket"],
        });

        // 소켓 자체는 연결됐는데 그 다음 SYSTEM(connected) 메시지를 못 받는 경우와,
        // 소켓 연결 자체가 안 되는 경우를 구분하기 위한 로그
        socket.on("connect", () => {
          botLog.log("[official] 세션 소켓이 연결됐어요. 서버의 SYSTEM 메시지를 기다립니다.");
        });

        socket.on("connect_error", (err) => {
          botLog.error(`[official] 세션 연결 실패: ${err.message}`);
          settleReject(new Error(`세션 연결 실패: ${err.message}`));
        });

        socket.on("error", (err) => {
          botLog.error(`[official] 세션 소켓 오류: ${err && err.message ? err.message : err}`);
          settleReject(new Error(`세션 소켓 오류: ${err && err.message ? err.message : err}`));
        });

        socket.on("disconnect", (reason) => {
          connected = false;
          botLog.warn(`[official] 채팅 세션 연결이 끊겼어요. (원인: ${reason || "알 수 없음"})`);
          emitter.emit("statusChange", { connected: false });
          settleReject(new Error(`세션이 끊겼어요. (원인: ${reason || "알 수 없음"})`));
          if (!stopped) scheduleReconnect();
        });

        socket.on("SYSTEM", async (raw) => {
          try {
            const data = parsePayload(raw);
            if (!data) return;
            if (data.type === "connected") {
              const sessionKey = data.data && data.data.sessionKey;
              botLog.log("[official] 세션에 연결됐어요. 채팅/후원 이벤트를 구독합니다.");
              await subscribeEvents(sessionKey);
              connected = true;
              reconnectAttempt = 0;
              botLog.log("[official] 채팅에 연결됐어요.");
              emitter.emit("statusChange", { connected: true });
              settleResolve();
            } else if (data.type === "revoked") {
              botLog.error("[official] 인가가 취소/만료됐어요. 계정 연동 탭에서 다시 인가해주세요.");
              connected = false;
              emitter.emit("statusChange", { connected: false });
              settleReject(new Error("인가가 취소/만료됐어요."));
            }
          } catch (err) {
            botLog.error(`[official] 이벤트 구독 실패: ${err.message}`);
            settleReject(err);
          }
        });

        socket.on("CHAT", (raw) => {
          const data = parsePayload(raw);
          if (!data) return;
          const nickname = (data.profile && data.profile.nickname) || "익명";
          const content = String(data.content || data.message || "");
          const preview = content.slice(0, 80);
          // 봇이 보낸 메시지도 다른 시청자 채팅과 똑같이 이 CHAT 이벤트로 되돌아와요.
          // 그대로 두면 커스텀 명령어 응답이 우연히 "!"로 시작할 경우 봇이 자기 메시지를
          // 다시 명령어로 인식해서 스스로에게 응답하는 루프가 생길 수 있어요.
          //
          // 예전에는 senderChannelId가 봇 계정과 같으면 무조건 걸렀는데, 그러면 방송인이
          // 새벽봇을 "본인 계정"으로 인가해둔 경우 본인이 채팅창에 직접 친 명령어까지
          // 전부 무시돼버리는 문제가 있었어요(방송인 계정 = 봇 계정인 게 보통이니까요).
          // 그래서 지금은 "봇이 sendChat()으로 방금 실제로 보낸 것과 내용이 똑같은 메시지"만
          // 자기 메시지로 보고 거르고, 그 외에는(같은 계정이 직접 친 명령어 포함) 정상 처리해요.
          const echoIdx = recentSentMessages.findIndex((m) => m.content === content);
          if (echoIdx !== -1) {
            recentSentMessages.splice(echoIdx, 1);
            botLog.log(`[chat] (봇 자신 응답 - 무시) ${nickname}: ${preview}`);
            return;
          }
          botLog.log(`[chat] ${nickname}: ${preview}`);
          emitter.emit("chat", mapEvent(data));
        });

        socket.on("DONATION", (raw) => {
          const data = parsePayload(raw);
          if (!data) return;
          const nickname = data.donatorNickname || "익명";
          botLog.log(`[donation] ${nickname} 님이 후원했어요.`);
          emitter.emit("donation", mapEvent(data));
        });
      })
      .catch((err) => {
        botLog.error(`[official] 세션 주소 조회 실패: ${err.message}`);
        settleReject(err);
      });
  });
}

function stop() {
  stopped = true;
  connected = false;
  // 예약된 재연결이 남아있으면 취소 — 안 그러면 나중에 수동으로 다시 연결한 뒤에
  // 이 예약이 뒤늦게 발동해서 소켓이 하나 더 생기는 경우가 생겨요.
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

function isConnected() {
  return connected;
}

function getBotNickname() {
  return botNickname;
}

async function refreshBotNickname() {
  try {
    const me = await authedFetch("/open/v1/users/me");
    botNickname = (me && (me.channelName || me.nickname)) || botNickname;
    botChannelId = (me && me.channelId) || botChannelId;
  } catch (err) {
    // 실패해도 치명적이지 않음 — 사이드바 표시용일 뿐. 다만 botChannelId를 못 받아오면
    // 아래 "자기 메시지 거르기"가 이번 연결 동안은 동작하지 않을 수 있음.
  }
  return botNickname;
}

function getBotChannelId() {
  return botChannelId;
}

function on(event, handler) {
  emitter.on(event, handler);
}

function rememberSentMessage(content) {
  const now = Date.now();
  // 오래된 기록은 정리 (창 시간이 지났으면 더 이상 대조할 필요 없음)
  recentSentMessages = recentSentMessages.filter((m) => now - m.ts < SELF_ECHO_WINDOW_MS);
  recentSentMessages.push({ content, ts: now });
}

async function sendChat(message) {
  const content = String(message).slice(0, 100);
  rememberSentMessage(content);
  await authedFetch("/open/v1/chats/send", { method: "POST", body: { message: content } });
}

async function blindMessage({ chatChannelId, messageTime, senderChannelId }) {
  return authedFetch("/open/v1/chats/blind-message", {
    method: "POST",
    body: { chatChannelId, messageTime, senderChannelId },
  });
}

async function addTemporaryRestrict({ targetChannelId, chatChannelId }) {
  return authedFetch("/open/v1/temporary-restrict-channels", {
    method: "POST",
    body: { targetChannelId, chatChannelId },
  });
}

async function removeTemporaryRestrict({ targetChannelId, chatChannelId }) {
  return authedFetch("/open/v1/temporary-restrict-channels", {
    method: "DELETE",
    body: { targetChannelId, chatChannelId },
  });
}

// 참고: 공식 API에는 "특정 채널의 방송 상세 정보"를 자유 조회하는 엔드포인트가 명확히 문서화되어
// 있지 않아요(/open/v1/lives 는 인가한 계정 자신의 라이브 목록 조회용). 그래서 !업타임 등에서
// 쓰던 것과 완전히 동일한 정보는 아직 100% 보장하지 못해요 — 실제 응답을 보고 다듬어야 해요.
async function getLiveDetail() {
  try {
    const result = await authedFetch("/open/v1/lives?size=1");
    const item = result && Array.isArray(result.data) && result.data[0];
    return item || null;
  } catch (err) {
    botLog.warn(`[official] 방송 정보 조회 실패: ${err.message}`);
    return null;
  }
}

module.exports = {
  start,
  stop,
  isConnected,
  getBotNickname,
  getBotChannelId,
  refreshBotNickname,
  on,
  sendChat,
  blindMessage,
  addTemporaryRestrict,
  removeTemporaryRestrict,
  getLiveDetail,
};
