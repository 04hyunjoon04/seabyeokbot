"use strict";

const config = require("../config");
const overrides = require("../systemCommandStore");

// 봇에 내장된(코드로 고정된) 명령어 목록. 응답 로직 자체는 코드에 고정돼 있지만,
// "필요 권한"만은 대시보드에서 바꿀 수 있음 (systemCommandStore 오버라이드로 저장).
const DEFINITIONS = [
  {
    key: "핑",
    label: (p) => `${p}핑`,
    description: "봇이 살아있는지 확인",
    defaultPermission: "everyone",
    defaultCooldownSec: 0,
  },
  {
    key: "업타임",
    label: (p) => `${p}업타임`,
    description: "방송 시작 후 경과 시간 표시",
    defaultPermission: "everyone",
    defaultCooldownSec: 10,
  },
  {
    key: "명령어",
    label: (p) => `${p}명령어`,
    description: "사용 가능한 명령어 목록 표시",
    defaultPermission: "everyone",
    defaultCooldownSec: 0,
  },
  {
    key: "추가",
    label: (p) => `${p}추가 (또는 ${p}등록)`,
    description: "새 커스텀 명령어 추가",
    defaultPermission: "manager",
    defaultCooldownSec: 0,
  },
  {
    key: "수정",
    label: (p) => `${p}수정 (또는 ${p}편집, ${p}변경)`,
    description: "커스텀 명령어 응답 수정",
    defaultPermission: "manager",
    defaultCooldownSec: 0,
  },
  {
    key: "제거",
    label: (p) => `${p}제거 (또는 ${p}삭제)`,
    description: "커스텀 명령어 삭제",
    defaultPermission: "manager",
    defaultCooldownSec: 0,
  },
];

function getSystemCommands() {
  const p = config.commandPrefix;
  return DEFINITIONS.map((d) => ({
    key: d.key,
    name: d.label(p),
    description: d.description,
    permission: overrides.getPermission(d.key, d.defaultPermission),
    cooldownSec: overrides.getCooldownSec(d.key, d.defaultCooldownSec),
    enabled: overrides.getEnabled(d.key, true),
  }));
}

function getEffectiveEnabled(key) {
  return overrides.getEnabled(key, true);
}

// 명령어 처리 로직(src/commands/index.js)에서 실제 권한/쿨타임 판정에 쓰는 헬퍼.
// 오버라이드가 없으면 코드에 정의된 기본값을 그대로 씀.
function getEffectivePermission(key) {
  const def = DEFINITIONS.find((d) => d.key === key);
  const defaultPermission = def ? def.defaultPermission : "everyone";
  return overrides.getPermission(key, defaultPermission);
}

function getEffectiveCooldownSec(key) {
  const def = DEFINITIONS.find((d) => d.key === key);
  const defaultCooldownSec = def ? def.defaultCooldownSec : 0;
  return overrides.getCooldownSec(key, defaultCooldownSec);
}

module.exports = {
  getSystemCommands,
  getEffectivePermission,
  getEffectiveCooldownSec,
  getEffectiveEnabled,
};
