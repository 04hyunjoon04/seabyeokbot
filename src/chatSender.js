"use strict";

// 채팅 전송 큐. 여러 명령어가 동시에 트리거돼도 순차적으로, 일정 간격으로 전송. 실제 전송은 official.sendChat()이 처리.
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
  // 치지직 채팅 메시지 길이 제한(약 100자)에 맞춰 자름
  const trimmed = String(message).slice(0, 100);
  return new Promise((resolve, reject) => {
    queue.push({ message: trimmed, resolve, reject });
    pump();
  });
}

module.exports = { say };
