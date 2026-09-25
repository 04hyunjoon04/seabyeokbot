"use strict";

const config = require("../config");
const overrides = require("../systemCommandStore");

// 봇에 내장된 명령어 목록. 판정 로직은 고정, "필요 권한"/"쿨타임"/"활성화"는 대시보드에서 조정 가능.
// 핑/업타임/명령어는 응답 문구도 대시보드 편집 버튼으로 수정 가능(editable: true).
const DEFINITIONS = [
  {
    key: "핑",
    label: (p) => `${p}핑`,
    description: "봇이 살아있는지 확인",
    defaultPermission: "everyone",
    defaultCooldownSec: 0,
    editable: true,
    defaultResponse: "퐁! 봇이 정상적으로 동작하고 있어요 :>",
  },
  {
    key: "업타임",
    label: (p) => `${p}업타임`,
    description: "방송 시작 후 경과 시간 표시",
    defaultPermission: "everyone",
    defaultCooldownSec: 10,
    editable: true,
    defaultResponse: "업타임: {업타임}",
  },
  {
    key: "명령어",
    label: (p) => `${p}명령어`,
    description: "사용 가능한 명령어 목록 표시",
    defaultPermission: "everyone",
    defaultCooldownSec: 0,
    editable: true,
    defaultResponse: "명령어: {목록}",
  },
  {
    key: "출첵",
    label: (p) => `${p}출첵`,
    description: "출석체크, 연속/총 출석 기록",
    defaultPermission: "everyone",
    defaultCooldownSec: 3,
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
  {
    key: "목록추가",
    label: (p) => `${p}목록추가`,
    description: "룰렛 결과 항목 추가 (룰렛별 허용 설정 필요)",
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
    editable: !!d.editable,
    response: d.editable ? overrides.getResponse(d.key, d.defaultResponse) : null,
  }));
}

function isEditable(key) {
  const def = DEFINITIONS.find((d) => d.key === key);
  return !!(def && def.editable);
}

// src/commands/index.js가 핑/업타임/명령어 응답 문구 렌더링에 사용하는 헬퍼. 오버라이드가 없으면 기본 문구 사용.
function getEffectiveResponse(key) {
  const def = DEFINITIONS.find((d) => d.key === key);
  if (!def) return "";
  if (!def.editable) return def.defaultResponse || "";
  return overrides.getResponse(key, def.defaultResponse);
}

function getEffectiveEnabled(key) {
  return overrides.getEnabled(key, true);
}

// src/commands/index.js가 권한/쿨타임 판정에 사용하는 헬퍼. 오버라이드가 없으면 기본값 사용.
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
  getEffectiveResponse,
  isEditable,
};
