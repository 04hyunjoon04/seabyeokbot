"use strict";

// 치지직 공식 Open API의 OAuth 인가(authorization code) 흐름 처리. 발급된 토큰은 파일에 저장해 재사용.
// 참고 문서: https://chzzk.gitbook.io/chzzk/chzzk-api/authorization

const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
const config = require("../config");
const { atomicWriteJson } = require("../utils");
const eventBus = require("../eventBus");

let cachedTokens = null; // { accessToken, refreshToken, tokenType, scope, obtainedAt, expiresIn }
let pendingState = null; // 인가 요청 시 발급한 state (CSRF 방지, 콜백에서 검증)

function load() {
  try {
    const text = fs.readFileSync(config.officialAuthFilePath, "utf8");
    cachedTokens = JSON.parse(text);
  } catch (err) {
    cachedTokens = null;
    if (err.code === "ENOENT") return cachedTokens; // 파일 없음 (최초 실행)

    // 파일 손상 시 백업 후 로그인 정보 없음으로 시작
    console.error("[oauth] 저장된 로그인 정보 파싱 실패, 다시 인가가 필요합니다:", err.message);
    try {
      fs.copyFileSync(config.officialAuthFilePath, `${config.officialAuthFilePath}.corrupted-${Date.now()}.bak`);
    } catch (backupErr) {
      console.error("[oauth] 손상된 파일 백업 실패:", backupErr.message);
    }
  }
  return cachedTokens;
}

function save(tokens) {
  cachedTokens = tokens;
  fs.mkdirSync(path.dirname(config.officialAuthFilePath), { recursive: true });
  atomicWriteJson(config.officialAuthFilePath, tokens);
  eventBus.emit("oauth");
}

function clear() {
  cachedTokens = null;
  try {
    fs.unlinkSync(config.officialAuthFilePath);
  } catch (err) {
    // 이미 없으면 무시
  }
  eventBus.emit("oauth");
}

function getTokens() {
  if (cachedTokens === null) load();
  return cachedTokens;
}

// 저장된 토큰이 현재 설정된 Client ID로 발급된 것인지 확인.
function isForCurrentClient(t) {
  return !!(t && t.clientId === config.clientId);
}

function isAuthorized() {
  const t = getTokens();
  if (!t || !t.accessToken) return false;
  if (!isForCurrentClient(t)) {
    clear();
    return false;
  }
  return true;
}

// 인가(로그인 동의) 페이지 URL 생성.
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

// OAuth 콜백으로 돌아온 code/state를 실제 토큰으로 교환.
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

// refreshToken은 1회용이라 동시 요청이 겹치면 인증이 깨질 수 있어, 진행 중인 갱신을 공유.
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

// 만료 임박 시 미리 갱신해 항상 유효한 accessToken을 반환.
async function ensureValidToken() {
  const t = getTokens();
  if (!t || !t.accessToken || !isForCurrentClient(t)) {
    if (t) clear();
    throw new Error("치지직 인가가 필요해요. 계정 연동 탭에서 인가를 진행해주세요.");
  }
  const expiresAt = t.obtainedAt + (t.expiresIn || 0) * 1000;
  const marginMs = 5 * 60 * 1000;
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

// accessToken은 24시간, refreshToken은 30일 만료. 주기적으로 확인/갱신해 인가 유효기간을 유지.
let autoRefreshTimer = null;

function startAutoRefresh(intervalMs = 6 * 60 * 60 * 1000) {
  if (autoRefreshTimer) return;
  autoRefreshTimer = setInterval(() => {
    if (!isAuthorized()) return;
    ensureValidToken().catch((err) => {
      console.error("[oauth] 주기적 토큰 갱신 확인 실패:", err.message);
    });
  }, intervalMs);
  if (autoRefreshTimer.unref) autoRefreshTimer.unref();
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
