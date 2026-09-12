"use strict";

// index.js와 src/web/server.js가 서로를 require하는 순환 참조를 피하기 위한 아주 작은 중개자.
// index.js가 실제 구현(getStatus/restartSession)을 여기 등록해두면,
// server.js는 이 모듈만 통해서 봇 상태 조회/재연결을 할 수 있음.

let impl = {
  getStatus: () => ({ authReady: false, sessionConnected: false, lastError: null }),
  restartSession: async () => ({ ok: false, error: "봇이 아직 준비되지 않았어요." }),
};

function register(newImpl) {
  impl = { ...impl, ...newImpl };
}

function getStatus() {
  return impl.getStatus();
}

function restartSession() {
  return impl.restartSession();
}

module.exports = { register, getStatus, restartSession };
