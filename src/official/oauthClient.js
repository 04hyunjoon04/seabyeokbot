"use strict";

// 치지직 공식 Open API의 OAuth 인가(authorization code) 흐름을 처리하는 모듈.
// 방송인(또는 봇 계정)이 "치지직 인가 페이지"에서 한 번 로그인/허용을 해주면,
// 그 결과로 받은 accessToken/refreshToken을 파일에 저장해두고 계속 재사용해요.
//
// 참고 문서: https://chzzk.gitbook.io/chzzk/chzzk-api/authorization

const fs = require("fs");
const crypto = require("crypto");
const config = require("../config");

let cachedTokens = null; // { accessToken, refreshToken, tokenType, scope, obtainedAt, expiresIn }
let pendingState = null; // 인가 요청 시 발급한 state (CSRF 방지용, 콜백에서 검증)

function load() {
  try {
    const text = fs.readFileSync(config.officialAuthFilePath, "utf8");
    cachedTokens = JSON.parse(text);
  } catch (err) {
    cachedTokens = null;
  }
  return cachedTokens;
}

function save(tokens) {
  cachedTokens = tokens;
  fs.mkdirSync(require("path").dirname(config.officialAuthFilePath), { recursive: true });
  fs.writeFileSync(config.officialAuthFilePath, JSON.stringify(tokens, null, 2), "utf8");
}

function clear() {
  cachedTokens = null;
  try {
    fs.unlinkSync(config.officialAuthFilePath);
  } catch (err) {
    // 이미 없으면 무시
  }
}

function getTokens() {
  if (cachedTokens === null) load();
  return cachedTokens;
}

// 저장된 토큰이 "지금 설정된" Client ID로 발급받은 게 맞는지 확인해요. .env의
// CLIENT_ID/CLIENT_SECRET을 바꾸거나(예: 배포용으로 초기화) 다른 애플리케이션으로
// 바꿨는데도, 예전에 다른 Client ID로 인가받아 저장해둔 토큰이 남아있으면 "인가됨"으로
// 잘못 표시되던 문제가 있었어요 — accessToken 존재 여부만 보고 판단했었거든요.
function isForCurrentClient(t) {
  return !!(t && t.clientId === config.clientId);
}

function isAuthorized() {
  const t = getTokens();
  if (!t || !t.accessToken) return false;
  if (!isForCurrentClient(t)) {
    // 지금 Client ID로 발급된 게 아니면 더 이상 쓸 수 없는 토큰이니 아예 지워서,
    // "인가됨"으로 잘못 보이거나 다른 앱 설정으로 잘못 요청되는 일이 없게 함.
    clear();
    return false;
  }
  return true;
}

// 방송인이 열어야 하는 인가(로그인 동의) 페이지 URL을 만들어요.
function buildAuthorizeUrl() {
  pendingState = crypto.randomBytes(16).toString("hex");
  const url = new URL(config.authorizeBaseUrl);
  url.searchParams.set("clientId", config.clientId);
  url.searchParams.set("redirectUri", config.redirectUri);
  url.searchParams.set("state", pendingState);
  return url.toString();
}

async function request(body) {
  const res = await fetch(new URL("/auth/v1/token", config.apiBaseUrl), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || !json.content) {
    const message = (json && (json.message || JSON.stringify(json))) || `HTTP ${res.status}`;
    throw new Error(`[oauth] 토큰 발급 실패: ${message}`);
  }
  return json.content;
}

// OAuth 콜백(redirectUri)으로 돌아온 code/state를 받아서 실제 토큰으로 교환해요.
async function exchangeCode(code, state) {
  if (pendingState && state && pendingState !== state) {
    throw new Error("인가 요청 정보가 일치하지 않아요(state 불일치). 인가를 처음부터 다시 시도해주세요.");
  }
  const content = await request({
    grantType: "authorization_code",
    clientId: config.clientId,
    clientSecret: config.clientSecret,
    code,
    state: state || pendingState || "",
  });
  save({
    accessToken: content.accessToken,
    refreshToken: content.refreshToken,
    tokenType: content.tokenType || "Bearer",
    scope: content.scope || "",
    obtainedAt: Date.now(),
    expiresIn: content.expiresIn || 0,
    clientId: config.clientId,
  });
  pendingState = null;
  return cachedTokens;
}

// refreshToken은 1회용이라(쓰면 새 걸로 교체됨), 갱신 요청이 동시에 두 번 나가면 하나는
// 이미 무효화된 refreshToken으로 요청하게 돼서 인증이 아예 깨질 수 있어요(둘 중 늦게 끝난
// 응답이 먼저 끝난 응답의 새 토큰을 덮어쓸 수도 있음). 그래서 이미 갱신이 진행 중이면 새
// 요청을 또 보내지 않고, 진행 중인 그 갱신의 결과를 같이 기다리게 함.
let refreshInFlight = null;

async function refresh() {
  if (refreshInFlight) return refreshInFlight;

  refreshInFlight = (async () => {
    const t = getTokens();
    if (!t || !t.refreshToken || !isForCurrentClient(t)) {
      clear();
      throw new Error("갱신할 로그인 정보가 없어요. 인가를 다시 진행해주세요.");
    }
    const content = await request({
      grantType: "refresh_token",
      clientId: config.clientId,
      clientSecret: config.clientSecret,
      refreshToken: t.refreshToken,
    });
    save({
      accessToken: content.accessToken,
      refreshToken: content.refreshToken,
      tokenType: content.tokenType || "Bearer",
      scope: content.scope || t.scope || "",
      obtainedAt: Date.now(),
      expiresIn: content.expiresIn || 0,
      clientId: config.clientId,
    });
    return cachedTokens;
  })();

  try {
    return await refreshInFlight;
  } finally {
    refreshInFlight = null;
  }
}

// 만료가 임박했으면 미리 갱신해서, 항상 바로 쓸 수 있는 accessToken을 돌려줘요.
async function ensureValidToken() {
  const t = getTokens();
  if (!t || !t.accessToken || !isForCurrentClient(t)) {
    if (t) clear(); // 지금 Client ID로 발급된 게 아니면 더 이상 못 쓰는 값이니 정리
    throw new Error("치지직 인가가 필요해요. 계정 연동 탭에서 인가를 진행해주세요.");
  }
  const expiresAt = t.obtainedAt + (t.expiresIn || 0) * 1000;
  const marginMs = 5 * 60 * 1000; // 5분 여유를 두고 미리 갱신
  if (t.expiresIn && Date.now() > expiresAt - marginMs) {
    try {
      await refresh();
    } catch (err) {
      console.error("[oauth] 토큰 자동 갱신 실패:", err.message);
    }
  }
  return getTokens().accessToken;
}

function getAuthHeader(accessToken) {
  return `Bearer ${accessToken}`;
}

// --- 주기적 자동 갱신 ---
// accessToken은 24시간, refreshToken은 30일이 지나면 만료돼요(공식 문서 기준). refresh 요청을
// 한 번 할 때마다 refreshToken도 새로 발급되면서 30일짜리 유효기간이 다시 리셋되니까, 앱을
// 완전히 꺼두지만 않으면(= 30일 안에 한 번이라도 실행되면) 이론상 인가를 다시 할 필요가
// 없어요. 다만 채팅을 실시간으로 받기만 할 때는(REST 요청이 뜸해서) 저절로 갱신될 기회가
// 없을 수 있어서, 이 타이머로 몇 시간마다 한 번씩 강제로 확인/갱신해줘요.
let autoRefreshTimer = null;

function startAutoRefresh(intervalMs = 6 * 60 * 60 * 1000) {
  if (autoRefreshTimer) return;
  autoRefreshTimer = setInterval(() => {
    if (!isAuthorized()) return;
    ensureValidToken().catch((err) => {
      console.error("[oauth] 주기적 토큰 갱신 확인 실패:", err.message);
    });
  }, intervalMs);
  if (autoRefreshTimer.unref) autoRefreshTimer.unref(); // 이 타이머 때문에 프로세스 종료가 막히지 않도록
}

function stopAutoRefresh() {
  if (autoRefreshTimer) {
    clearInterval(autoRefreshTimer);
    autoRefreshTimer = null;
  }
}

module.exports = {
  buildAuthorizeUrl,
  exchangeCode,
  refresh,
  ensureValidToken,
  isAuthorized,
  getTokens,
  clear,
  getAuthHeader,
  startAutoRefresh,
  stopAutoRefresh,
};
