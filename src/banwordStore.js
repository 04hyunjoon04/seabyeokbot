"use strict";

// 금칙어 목록을 data/banwords.json 에 저장/조회/수정하는 저장소.
// action: "blind"(메시지 블라인드) | "timeout"(임시 제한)
// * 영구 차단(벤)은 치지직 공식 Open API에 해당 엔드포인트가 없어 지원하지 않음.

const fs = require("fs");
const crypto = require("crypto");
const config = require("./config");

let words = []; // [{ id, word, action, enabled }]

function load() {
  try {
    const text = fs.readFileSync(config.banwordsFilePath, "utf8");
    words = JSON.parse(text);
  } catch (err) {
    words = [];
    if (err.code === "ENOENT") return; // 아직 파일이 없는 최초 실행 — 정상 상황

    // 파일은 있는데 내용이 깨져서 못 읽는 경우(비정상 종료 등). 그냥 빈 목록으로 시작하면
    // 다음 저장 때 기존 금칙어 목록이 통째로 사라지니, 원본을 백업해두고 빈 값으로 시작함.
    console.error("[banwordStore] banwords.json 파싱 실패, 빈 목록으로 시작합니다:", err.message);
    try {
      fs.copyFileSync(config.banwordsFilePath, `${config.banwordsFilePath}.corrupted-${Date.now()}.bak`);
    } catch (backupErr) {
      console.error("[banwordStore] 손상된 파일 백업 실패:", backupErr.message);
    }
  }
}

function save() {
  fs.writeFileSync(config.banwordsFilePath, JSON.stringify(words, null, 2), "utf8");
}

function all() {
  return words;
}

function add(word, action = "blind") {
  const entry = {
    id: crypto.randomBytes(6).toString("hex"),
    word: String(word).trim(),
    action: action === "timeout" ? "timeout" : "blind",
    enabled: true,
  };
  words.push(entry);
  save();
  return entry;
}

function remove(id) {
  const before = words.length;
  words = words.filter((w) => w.id !== id);
  save();
  return words.length < before;
}

function setEnabled(id, enabled) {
  const entry = words.find((w) => w.id === id);
  if (!entry) return null;
  entry.enabled = enabled;
  save();
  return entry;
}

// 메시지 안에 활성화된 금칙어가 포함돼 있으면 그 항목을 반환 (부분 일치, 대소문자 무시)
function findMatch(content) {
  if (!content) return null;
  const lower = content.toLowerCase();
  return words.find((w) => w.enabled && w.word && lower.includes(w.word.toLowerCase())) || null;
}

load();

module.exports = { load, all, add, remove, setEnabled, findMatch };
