"use strict";

// .env 파일 안의 특정 KEY=VALUE 줄만 골라서 다시 써주는 아주 단순한 유틸.
// dotenv는 읽기 전용이라, 토큰이 갱신될 때마다 여기서 직접 파일을 고쳐씁니다.

const fs = require("fs");

function updateEnvFile(filePath, updates) {
  let content = "";
  try {
    content = fs.readFileSync(filePath, "utf8");
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }

  const lines = content.length ? content.split(/\r?\n/) : [];
  const seen = new Set();

  const newLines = lines.map((line) => {
    const match = line.match(/^([A-Z0-9_]+)=/);
    if (!match) return line;
    const key = match[1];
    if (Object.prototype.hasOwnProperty.call(updates, key)) {
      seen.add(key);
      return `${key}=${updates[key]}`;
    }
    return line;
  });

  for (const [key, value] of Object.entries(updates)) {
    if (!seen.has(key)) {
      newLines.push(`${key}=${value}`);
    }
  }

  fs.writeFileSync(filePath, newLines.join("\n").replace(/\n+$/, "\n"), "utf8");
}

module.exports = { updateEnvFile };
