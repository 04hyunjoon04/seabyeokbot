"use strict";

// 치지직 공식 Open API 호출. 봇 채팅 연결 자체는 src/official/chzzkOfficial.js가 담당하고,
// 여기서는 채널 프로필(이름/이미지) 조회에만 씀 — Client ID/Secret 인증만 있으면
// 되고 봇 계정의 로그인 상태와는 무관함.

const config = require("./config");

async function request(pathname, { query } = {}) {
  const url = new URL(pathname, config.apiBaseUrl);
  if (query) {
    for (const [key, value] of Object.entries(query)) {
      if (value !== undefined && value !== null) url.searchParams.set(key, value);
    }
  }

  const res = await fetch(url, {
    method: "GET",
    headers: {
      "Content-Type": "application/json",
      "Client-Id": config.clientId,
      "Client-Secret": config.clientSecret,
    },
  });

  const text = await res.text();
  let json = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch (_err) {
    // 응답이 JSON이 아닌 경우 (드묾)
  }

  if (!res.ok || (json && typeof json.code === "number" && json.code !== 200)) {
    const msg = (json && json.message) || `HTTP ${res.status}`;
    const err = new Error(`[CHZZK API] GET ${pathname} 실패: ${msg}`);
    err.status = res.status;
    err.body = json;
    throw err;
  }

  return json ? json.content : null;
}

// 채널 정보 조회는 Bearer 토큰이 아니라 Client-Id/Client-Secret 인증을 씀 (공식 문서 기준, scope 불필요)
const getChannels = (channelIds) =>
  request("/open/v1/channels", { query: { channelIds: channelIds.join(",") } });

module.exports = { getChannels };
