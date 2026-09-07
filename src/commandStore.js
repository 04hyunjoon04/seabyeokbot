"use strict";

// 커스텀 명령어를 data/commands.json 에 저장/조회/수정하는 아주 단순한 파일 기반 저장소.
// (나중에 시청자 수가 많아지면 SQLite 등으로 교체 가능하도록 함수 인터페이스만 분리해둠)

const fs = require("fs");
const config = require("./config");

let commands = {};

function load() {
  try {
    const text = fs.readFileSync(config.commandsFilePath, "utf8");
    commands = JSON.parse(text);
  } catch (err) {
    if (err.code === "ENOENT") {
      commands = {};
    } else {
      // 파일은 있는데 내용이 깨져서 못 읽는 경우. 빈 목록으로 시작하면 다음 저장 때
      // 기존 커스텀 명령어가 통째로 사라지니, 원본을 백업해두고 빈 값으로 시작함.
      console.error("[commandStore] commands.json 파싱 실패, 빈 목록으로 시작합니다:", err.message);
      try {
        fs.copyFileSync(config.commandsFilePath, `${config.commandsFilePath}.corrupted-${Date.now()}.bak`);
      } catch (backupErr) {
        console.error("[commandStore] 손상된 파일 백업 실패:", backupErr.message);
      }
      commands = {};
    }
  }
}

function save() {
  fs.writeFileSync(config.commandsFilePath, JSON.stringify(commands, null, 2), "utf8");
}

function normalizeName(name) {
  return String(name || "").trim();
}

function get(name) {
  return commands[normalizeName(name)];
}

function has(name) {
  return Object.prototype.hasOwnProperty.call(commands, normalizeName(name));
}

function all() {
  return commands;
}

function add(name, responseText, opts = {}) {
  const key = normalizeName(name);
  commands[key] = {
    responses: responseText.split("||").map((s) => s.trim()),
    permission: opts.permission || "everyone", // 기본값은 누구나 사용 가능(명령어를 새로 만드는 것 자체는 매니저 이상만 가능)
    cooldownSec: opts.cooldownSec ?? 3,
    userCooldownSec: opts.userCooldownSec ?? 3,
    enabled: true,
    listed: opts.listed ?? true,
    description: opts.description || "",
    uses: 0,
  };
  save();
  return commands[key];
}

function update(name, responseText) {
  const key = normalizeName(name);
  if (!has(key)) return null;
  commands[key].responses = responseText.split("||").map((s) => s.trim());
  save();
  return commands[key];
}

function remove(name) {
  const key = normalizeName(name);
  if (!has(key)) return false;
  delete commands[key];
  save();
  return true;
}

function setEnabled(name, enabled) {
  const key = normalizeName(name);
  if (!has(key)) return null;
  commands[key].enabled = enabled;
  save();
  return commands[key];
}

const META_FIELDS = ["permission", "cooldownSec", "userCooldownSec", "listed", "description"];

// 웹 대시보드에서 응답 문구 외의 설정(권한/쿨타임/목록 노출 여부 등)만 바꿀 때 사용
function setMeta(name, patch = {}) {
  const key = normalizeName(name);
  if (!has(key)) return null;
  for (const field of META_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      commands[key][field] = patch[field];
    }
  }
  save();
  return commands[key];
}

function incrementUses(name) {
  const key = normalizeName(name);
  if (!has(key)) return;
  commands[key].uses = (commands[key].uses || 0) + 1;
  save();
}

load();

module.exports = {
  load,
  get,
  has,
  all,
  add,
  update,
  remove,
  setEnabled,
  setMeta,
  incrementUses,
};
