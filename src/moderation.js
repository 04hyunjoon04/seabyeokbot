"use strict";

// 금칙어 감지 + 제재 처리. 지원 제재: 메시지 블라인드, 임시 제한(영구 차단 미지원). 봇 계정에 "채팅 운영자" 이상 권한 필요.

const official = require("./official/chzzkOfficial");
const banwordStore = require("./banwordStore");
const { hasPermission } = require("./utils").permissions;

async function checkAndModerate(evt) {
  const { userRoleCode, content, chatChannelId, senderChannelId, messageTime } = evt;

  // 매니저 이상은 검사 대상에서 제외
  if (hasPermission(userRoleCode, "manager")) return false;

  const matched = banwordStore.findMatch(content);
  if (!matched) return false;

  console.log(`[moderation] 금칙어 '${matched.word}' 감지 (action=${matched.action}) - ${content}`);

  try {
    if (matched.action === "timeout") {
      await official.addTemporaryRestrict({ targetChannelId: senderChannelId, chatChannelId });
    } else {
      await official.blindMessage({ chatChannelId, messageTime, senderChannelId, message: content });
    }
  } catch (err) {
    console.warn(
      "[moderation] 제재 처리 실패했어요. 봇 계정에 '채팅 운영자' 이상 권한이 있는지 확인해주세요:",
      err.message
    );
  }

  return true;
}

module.exports = { checkAndModerate };
