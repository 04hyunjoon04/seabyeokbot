"use strict";

// 이 챗봇을 Windows 서비스로 등록합니다. 등록하면 컴퓨터를 켤 때마다 로그인 없이도
// 백그라운드에서 자동으로 봇이 실행돼요 (방송 켤 때마다 봇 켜는 걸 잊어버릴 걱정이 없어짐).
//
// 반드시 "관리자 권한으로 실행"한 터미널(또는 install-service.bat)에서 실행해야 해요.
// (Windows 서비스 등록은 관리자 권한이 필요합니다)
//
// 주의: 서비스는 화면 없는 백그라운드 프로세스라서 Electron 창을 띄울 수 없어요.
// 그래서 저장된 네이버 로그인 쿠키가 만료되면 서비스가 스스로 다시 로그인하지 못해요
// (자동/수동 로그인 창 모두 Electron 데스크톱 앱(npm start)에서만 동작함).
// 로그인이 오래 유지되도록, 가끔은 데스크톱 앱을 켜서 로그인 상태를 확인해주세요.

const path = require("path");

let Service;
try {
  Service = require("node-windows").Service;
} catch (err) {
  console.error(
    "node-windows 모듈을 찾을 수 없어요. 먼저 `npm install node-windows`를 실행해주세요."
  );
  process.exit(1);
}

// 서비스 등록 이름은 Windows 버전/로캘에 따라 한글 처리 방식이 다를 수 있어서
// 영문 ID를 그대로 씀 (사용자에게 보이는 안내 문구는 "새벽봇"으로 표시).
const svc = new Service({
  name: "SaebyeokBot",
  description: "새벽봇 - 치지직(CHZZK) 채팅 챗봇 (채팅 명령어 응답 + 로컬 관리 웹페이지)",
  script: path.join(__dirname, "..", "index.js"),
});

svc.on("invalidinstallation", () => {
  console.error("서비스 설치에 실패했어요 (invalidinstallation). 관리자 권한으로 다시 시도해주세요.");
});

svc.on("alreadyinstalled", () => {
  console.log("이미 '새벽봇' 서비스가 설치되어 있어요.");
  console.log("다시 설치하려면 먼저 uninstall-service.bat 으로 제거한 뒤 진행해주세요.");
});

svc.on("install", () => {
  console.log("서비스 설치 완료! 시작합니다...");
  svc.start();
});

svc.on("start", () => {
  console.log("");
  console.log("======================================================");
  console.log(" 새벽봇 서비스가 시작됐어요.");
  console.log(" 이제부터는 컴퓨터를 켤 때마다 자동으로 봇이 실행돼요.");
  console.log(" 관리 페이지: http://localhost:5173  (.env의 WEB_PORT를 바꿨다면 그 포트)");
  console.log(" 서비스 상태는 Windows '서비스' 앱(services.msc)에서 'SaebyeokBot'으로 확인할 수 있어요.");
  console.log(" (로그인 쿠키가 만료되면 서비스 혼자 재로그인을 못 해요 — 데스크톱 앱으로 가끔 확인해주세요.)");
  console.log("======================================================");
});

svc.on("error", (err) => {
  console.error("서비스 설치/시작 중 오류가 발생했어요:", err);
});

console.log("'새벽봇' 서비스를 설치합니다...");
svc.install();
