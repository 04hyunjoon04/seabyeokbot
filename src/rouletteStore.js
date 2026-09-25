"use strict";

// 룰렛 항목을 data/roulette.json에 저장/조회/수정하는 저장소.
// 후원 문구 또는 일반 명령어 이름과 정확히 일치할 때만 반응하는 항목을 관리.

const fs = require("fs");
const crypto = require("crypto");
const config = require("./config");
const { atomicWriteJson } = require("./utils");
const eventBus = require("./eventBus");

let entries = []; // [{ id, name, mode, options, donationAmount, cooldownSec, userCooldownSec, allowChatAdd, spinStyle, enabled }]
// options: [{ text, probability, locked }] — probability는 0~100 사이 숫자(소수점 2자리), 당첨 확률(%)을 의미.
// locked가 true인 항목은 !목록추가로 새 항목이 들어와도 확률이 재분배되지 않고 그대로 고정됨
// spinStyle: "wheel" | "slot" — 오버레이에서 이 룰렛이 당첨될 때 재생할 애니메이션 스타일

const VALID_SPIN_STYLES = new Set(["wheel", "slot"]);

function normalizeSpinStyle(value) {
  return VALID_SPIN_STYLES.has(value) ? value : "wheel";
}

// 양수 비율 배열을 합이 정확히 total(기본 100.00)이 되는 퍼센트 배열로 변환.
// 최대 나머지(largest remainder) 방식으로 반올림 오차를 여러 항목에 고르게 나눠, 한 항목에만 몰리지 않도록 함
function distributePercentages(weights, total = 100) {
  const totalWeight = weights.reduce((sum, w) => sum + (w > 0 ? w : 1), 0);
  const totalCents = Math.round(total * 100);

  const exactCents = weights.map((w) => {
    const weight = w > 0 ? w : 1;
    return (weight / totalWeight) * totalCents;
  });
  const cents = exactCents.map((c) => Math.floor(c));
  const assignedCents = cents.reduce((sum, c) => sum + c, 0);
  const remainderCents = totalCents - assignedCents;

  const order = exactCents
    .map((c, i) => ({ i, frac: c - Math.floor(c) }))
    .sort((a, b) => b.frac - a.frac);
  for (let k = 0; k < remainderCents && k < order.length; k++) {
    cents[order[k].i] += 1;
  }

  return cents.map((c) => Math.max(0, Math.round(c) / 100));
}

// 결과 항목 목록을 { text, probability, locked } 형태로 정리. probability는 0~100, 소수점 2자리까지.
// 값이 없거나 잘못되면 0으로 처리. 빈 문구는 제거
function normalizeOptions(raw) {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((item) => {
      if (item && typeof item === "object") {
        const text = String(item.text ?? "").trim();
        const rawProbability = item.probability !== undefined ? item.probability : item.weight;
        let probability = Number(rawProbability);
        if (!Number.isFinite(probability) || probability < 0) probability = 0;
        probability = Math.min(100, Math.round(probability * 100) / 100);
        return { text, probability, locked: !!item.locked };
      }
      return { text: String(item ?? "").trim(), probability: 0, locked: false };
    })
    .filter((o) => o.text);
}

// 확률(probability) 비례 무작위 선택. 모든 항목의 확률 합이 0이면 동일 확률로 취급
function pickByProbability(options) {
  if (!options || !options.length) return null;
  const total = options.reduce((sum, o) => sum + (o.probability > 0 ? o.probability : 0), 0);
  if (total <= 0) {
    return options[Math.floor(Math.random() * options.length)].text;
  }
  let r = Math.random() * total;
  for (const o of options) {
    const p = o.probability > 0 ? o.probability : 0;
    if (r < p) return o.text;
    r -= p;
  }
  return options[options.length - 1].text;
}

function pickOption(entry) {
  return pickByProbability(entry && entry.options);
}

function load() {
  try {
    const text = fs.readFileSync(config.rouletteFilePath, "utf8");
    const parsed = JSON.parse(text);
    entries = Array.isArray(parsed) ? parsed : [];

    let migrated = false;
    entries.forEach((entry) => {
      const before = Array.isArray(entry.options) ? entry.options : [];
      const alreadyNewFormat = before.every((o) => o && typeof o === "object" && typeof o.probability === "number");
      if (!alreadyNewFormat) {
        migrated = true;
        const isWeightFormat = before.every((o) => o && typeof o === "object" && typeof o.weight === "number");
        if (isWeightFormat) {
          // 이전 가중치(weight) 데이터는 항목 간 비율을 그대로 유지해 확률(%)로 변환
          const weights = before.map((o) => (Number(o.weight) > 0 ? Number(o.weight) : 1));
          const pcts = distributePercentages(weights);
          entry.options = before
            .map((o, i) => ({ text: String(o.text ?? "").trim(), probability: pcts[i] }))
            .filter((o) => o.text);
        } else {
          // 그 밖의 예전 형식(문자열 배열 등)은 항목 수만큼 균등 분배
          const texts = before
            .map((o) => (o && typeof o === "object" ? String(o.text ?? "") : String(o ?? "")))
            .map((t) => t.trim())
            .filter(Boolean);
          const pcts = distributePercentages(texts.map(() => 1));
          entry.options = texts.map((t, i) => ({ text: t, probability: pcts[i] }));
        }
      }
      if (entry.allowChatAdd === undefined) {
        entry.allowChatAdd = false;
        migrated = true;
      }
      if (entry.spinStyle === undefined) {
        entry.spinStyle = "wheel";
        migrated = true;
      }
      if (Object.prototype.hasOwnProperty.call(entry, "uses")) {
        delete entry.uses;
        migrated = true;
      }
      (entry.options || []).forEach((o) => {
        if (o.locked === undefined) {
          o.locked = false;
          migrated = true;
        }
      });
    });
    if (migrated) save();
  } catch (err) {
    entries = [];
    if (err.code === "ENOENT") return; // 파일 없음 (최초 실행)

    // 파일 손상 시 백업 후 빈 목록으로 시작
    console.error("[rouletteStore] roulette.json 파싱 실패, 빈 목록으로 시작합니다:", err.message);
    try {
      fs.copyFileSync(config.rouletteFilePath, `${config.rouletteFilePath}.corrupted-${Date.now()}.bak`);
    } catch (backupErr) {
      console.error("[rouletteStore] 손상된 파일 백업 실패:", backupErr.message);
    }
  }
}

function save() {
  atomicWriteJson(config.rouletteFilePath, entries);
  eventBus.emit("roulette");
}

function all() {
  return entries.slice();
}

function get(id) {
  return entries.find((e) => e.id === id) || null;
}

// 같은 반응 방식(mode) 안에서 이름이 완전히 같을 때만 일치로 판단 (부분 일치 없음)
function findMatch(mode, name) {
  return entries.find((e) => e.enabled && e.mode === mode && e.name === name) || null;
}

// 반응 방식(mode)과 상관없이 이름으로만 검색. !목록추가 명령어에서 대상 룰렛을 찾을 때 사용
function findByName(name) {
  return entries.find((e) => e.name === name) || null;
}

// 같은 반응 방식 안에서 이름 중복 여부. excludeId를 주면 자기 자신은 제외하고 검사 (수정 시 사용)
function hasNameConflict(mode, name, excludeId) {
  return entries.some((e) => e.mode === mode && e.name === name && e.id !== excludeId);
}

// 일반 명령어 모드로 등록된 이름 목록. 커스텀 명령어와의 이름 충돌 검사에 사용
function chatModeNames() {
  return entries.filter((e) => e.mode === "chat").map((e) => e.name);
}

function add(name, mode, options, opts = {}) {
  const entry = {
    id: crypto.randomBytes(6).toString("hex"),
    name: String(name).trim(),
    mode: mode === "donation" ? "donation" : "chat",
    options: normalizeOptions(options),
    // 후원 문구 모드에서만 의미 있음. null이면 금액 상관없이 반응, 숫자면 그 금액과 정확히 일치해야 반응
    donationAmount: opts.donationAmount ?? null,
    cooldownSec: opts.cooldownSec ?? 3,
    userCooldownSec: opts.userCooldownSec ?? 0,
    // true면 채팅에서 !목록추가 명령어로 결과 항목을 추가할 수 있음
    allowChatAdd: !!opts.allowChatAdd,
    // 오버레이에서 이 룰렛이 당첨될 때 재생할 애니메이션 스타일
    spinStyle: normalizeSpinStyle(opts.spinStyle),
    enabled: true,
  };
  entries.push(entry);
  save();
  return entry;
}

function update(id, patch = {}) {
  const entry = get(id);
  if (!entry) return null;
  if (patch.name !== undefined) entry.name = String(patch.name).trim();
  if (patch.mode !== undefined) entry.mode = patch.mode === "donation" ? "donation" : "chat";
  if (patch.options !== undefined) {
    entry.options = normalizeOptions(patch.options);
  }
  if (patch.donationAmount !== undefined) entry.donationAmount = patch.donationAmount;
  if (patch.cooldownSec !== undefined) entry.cooldownSec = patch.cooldownSec;
  if (patch.userCooldownSec !== undefined) entry.userCooldownSec = patch.userCooldownSec;
  if (patch.allowChatAdd !== undefined) entry.allowChatAdd = !!patch.allowChatAdd;
  if (patch.spinStyle !== undefined) entry.spinStyle = normalizeSpinStyle(patch.spinStyle);
  save();
  return entry;
}

function remove(id) {
  const before = entries.length;
  entries = entries.filter((e) => e.id !== id);
  save();
  return entries.length < before;
}

function setEnabled(id, enabled) {
  const entry = get(id);
  if (!entry) return null;
  entry.enabled = enabled;
  save();
  return entry;
}

// 채팅 !목록추가 명령어로 결과 항목을 추가. 확률 고정(locked)이 아닌 항목 + 새 항목을 동일 확률로 재분배하고,
// 고정된 항목은 확률을 그대로 유지 (예: 4개 항목 25%씩 상태에서 추가하면 5개 항목 모두 20%로 재조정,
// 그중 하나가 고정돼 있으면 고정된 항목은 그대로 두고 나머지만 남은 비율을 나눠 가짐)
function addChatOption(id, text) {
  const entry = get(id);
  if (!entry) return null;
  const cleanText = String(text ?? "").trim();
  if (!cleanText) return null;

  const lockedTotal = Math.round(
    entry.options.filter((o) => o.locked).reduce((sum, o) => sum + o.probability, 0) * 100
  ) / 100;
  const remaining = Math.max(0, Math.round((100 - lockedTotal) * 100) / 100);

  const unlockedCount = entry.options.filter((o) => !o.locked).length + 1; // +1은 새로 추가되는 항목
  const pcts = distributePercentages(new Array(unlockedCount).fill(1), remaining);

  let cursor = 0;
  const updatedOptions = entry.options.map((o) => {
    if (o.locked) return o;
    const probability = pcts[cursor];
    cursor += 1;
    return { ...o, probability };
  });
  updatedOptions.push({ text: cleanText, probability: pcts[cursor], locked: false });

  entry.options = updatedOptions;
  save();
  return entry;
}

load();

module.exports = {
  load,
  all,
  get,
  findMatch,
  findByName,
  hasNameConflict,
  chatModeNames,
  add,
  update,
  remove,
  setEnabled,
  pickOption,
  addChatOption,
};
