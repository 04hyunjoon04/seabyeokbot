"use strict";

// 채팅 전송 큐: 명령어가 한꺼번에 여러 개 트리거돼도 순차적으로, 너무 빠르지 않게 보냅니다.
// 실제 전송은 치지직 공식 Open API로 인가받은 계정 권한으로 official.sendChat()이 담당함.
const official = require("./official/chzzkOfficial");
const { botLog } = require("./utils");

const MIN_INTERVAL_MS = 700;

let queue = [];
let sending = false;

async function pump() {
  if (sending) return;
  sending = true;

  while (queue.length) {
    const { message, resolve, reject } = queue.shift();
    try {
      await official.sendChat(message);
      resolve();
    } catch (err) {
      botLog.error(`[chat] 메시지 전송 실패: ${err.message}`);
      reject(err);
    }
    await new Promise((r) => setTimeout(r, MIN_INTERVAL_MS));
  }

  sending = false;
}

function say(message) {
  if (!message) return Promise.resolve();
  // 치지직 채팅 메시지 길이 제한(대략 100자 내외)을 넘지 않도록 안전하게 자름
  const trimmed = String(message).slice(0, 100);
  return new Promise((resolve, reject) => {
    queue.push({ message: trimmed, resolve, reject });
    pump();
  });
}

module.exports = { say };
