"use strict";

// 커스텀 명령어를 data/commands.json에 저장/조회/수정하는 파일 기반 저장소.

const fs = require("fs");
const config = require("./config");
const { atomicWriteJson } = require("./utils");
const eventBus = require("./eventBus");

let commands = {};

function load() {
  try {
    const text = fs.readFileSync(config.commandsFilePath, "utf8");
    commands = JSON.parse(text);

    let migrated = false;
    for (const key of Object.keys(commands)) {
      if (Object.prototype.hasOwnProperty.call(commands[key], "uses")) {
        delete commands[key].uses;
        migrated = true;
      }
    }
    if (migrated) save();
  } catch (err) {
    if (err.code === "ENOENT") {
      commands = {};
    } else {
      // 파일 손상 시 백업 후 빈 목록으로 시작
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
  atomicWriteJson(config.commandsFilePath, commands);
  eventBus.emit("commands");
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
    permission: opts.permission || "everyone",
    cooldownSec: opts.cooldownSec ?? 3,
    userCooldownSec: opts.userCooldownSec ?? 3,
    enabled: true,
    listed: opts.listed ?? true,
    description: opts.description || "",
    noPrefix: !!opts.noPrefix,
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

const META_FIELDS = ["permission", "cooldownSec", "userCooldownSec", "listed", "description", "noPrefix"];

// 응답 문구 외 설정(권한/쿨타임/목록 노출 등)만 변경
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
};
