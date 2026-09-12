"use strict";

// 설치했던 '새벽봇' Windows 서비스를 제거합니다. (관리자 권한 필요)

const path = require("path");

let Service;
try {
  Service = require("node-windows").Service;
} catch (err) {
  console.error(
    "node-windows 모듈을 찾을 수 없어요. (서비스를 설치한 적이 없다면 제거할 것도 없어요)"
  );
  process.exit(1);
}

const svc = new Service({
  name: "SaebyeokBot",
  script: path.join(__dirname, "..", "index.js"),
});

svc.on("uninstall", () => {
  console.log("'새벽봇' 서비스를 제거했어요. 이제 컴퓨터를 켜도 자동으로 실행되지 않아요.");
});

svc.on("error", (err) => {
  console.error("서비스 제거 중 오류가 발생했어요:", err);
});

console.log("'새벽봇' 서비스를 제거합니다...");
svc.uninstall();
