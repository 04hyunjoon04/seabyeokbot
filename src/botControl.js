"use strict";

// index.js와 src/web/server.js 간 순환 참조를 피하기 위한 중개자. index.js가 구현을 등록하면 server.js는 이 모듈로 호출.

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
