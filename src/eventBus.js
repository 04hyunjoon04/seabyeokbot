"use strict";

// 데이터 변경을 관리 페이지(SSE)로 알리기 위한 전역 이벤트 버스.
// 각 저장소가 변경 시 이 버스로 이벤트를 쏘면, 관리 페이지 서버가 그대로 브라우저로 중계.

const { EventEmitter } = require("events");

const bus = new EventEmitter();
bus.setMaxListeners(50);

module.exports = bus;
