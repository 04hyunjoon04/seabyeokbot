"use strict";

// 치지직 공식 Open API 호출. 채널 프로필(이름/이미지) 조회 전용. 채팅 연결은 src/official/chzzkOfficial.js가 담당.

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
    // 응답이 JSON이 아닌 경우
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

// 채널 정보 조회는 Client-Id/Client-Secret 인증 사용 (Bearer 토큰 불필요)
const getChannels = (channelIds) =>
  request("/open/v1/channels", { query: { channelIds: channelIds.join(",") } });

module.exports = { getChannels };
