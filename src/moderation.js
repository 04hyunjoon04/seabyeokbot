"use strict";

// 금칙어 감지 + 제재 처리.
// 지원하는 제재: 메시지 블라인드, 임시 제한(타임아웃).
// 영구 차단(벤)은 지원하지 않음.
//
// 임시 제한/블라인드는 봇 전용 계정이 해당 채널에서 "채팅 운영자" 이상 권한을
// 갖고 있어야 동작함 (치지직 스튜디오 > 권한 관리에서 스트리머가 직접 부여해야 함).

const official = require("./official/chzzkOfficial");
const banwordStore = require("./banwordStore");
const { hasPermission } = require("./utils").permissions;

async function checkAndModerate(evt) {
  const { userRoleCode, content, chatChannelId, senderChannelId, messageTime } = evt;

  // 매니저 이상은 금칙어 검사 대상에서 제외 (뚜봇의 광고 필터와 동일한 방침)
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
