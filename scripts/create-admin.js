require("../db");
const readline = require("node:readline");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { db, hashPassword } = require("../db");

function ask(question) {
  const terminal = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => terminal.question(question, (answer) => { terminal.close(); resolve(answer.trim()); }));
}

function askHidden(question) {
  if (!process.stdin.isTTY || !process.stdin.setRawMode) return ask(question);
  return new Promise((resolve) => {
    let value = "";
    process.stdout.write(question);
    process.stdin.setRawMode(true);
    process.stdin.resume();
    const onData = (data) => {
      const character = data.toString("utf8");
      if (character === "\u0003") {
        process.stdin.setRawMode(false);
        process.exit(1);
      }
      if (character === "\r" || character === "\n") {
        process.stdin.setRawMode(false);
        process.stdin.pause();
        process.stdin.removeListener("data", onData);
        process.stdout.write("\n");
        resolve(value);
      } else if (character === "\u007f" || character === "\b") {
        value = value.slice(0, -1);
      } else if (character >= " ") value += character;
    };
    process.stdin.on("data", onData);
  });
}

function clearBootstrapCredentials() {
  const envPath = path.join(process.cwd(), ".env");
  if (fs.existsSync(envPath)) {
    const original = fs.readFileSync(envPath, "utf8");
    const cleaned = original.split(/\r?\n/).filter((line) => !/^\s*ONGYEOL_ADMIN_(EMAIL|PASSWORD)\s*=/.test(line)).join("\n");
    fs.writeFileSync(envPath, cleaned, { mode: 0o600 });
  }
  delete process.env.ONGYEOL_ADMIN_EMAIL;
  delete process.env.ONGYEOL_ADMIN_PASSWORD;
}

async function main() {
  const bootstrapMode = Boolean(process.env.ONGYEOL_ADMIN_EMAIL && process.env.ONGYEOL_ADMIN_PASSWORD);
  const email = (process.argv[2] || process.env.ONGYEOL_ADMIN_EMAIL || await ask("관리자 이메일: ")).trim().toLowerCase();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error("이메일 주소를 확인해 주세요.");
  const fullName = bootstrapMode ? "관리자" : (await ask("관리자 이름: ")) || "관리자";
  const configRow = db.prepare("SELECT departments_json FROM school_config WHERE id = 1").get();
  const departments = JSON.parse(configRow.departments_json);
  const defaultDepartment = departments[0] || "관리자";
  const department = bootstrapMode ? defaultDepartment : (await ask(`부서 (${defaultDepartment}): `)) || defaultDepartment;
  if (!departments.includes(department)) throw new Error("부서 목록에 있는 부서를 입력해 주세요.");
  if (!fullName || fullName.length > 80) throw new Error("관리자 이름을 확인해 주세요.");
  const password = process.env.ONGYEOL_ADMIN_PASSWORD || await askHidden("관리자 비밀번호 (12자 이상): ");
  if (password.length < 12) throw new Error("비밀번호는 12자 이상이어야 합니다.");
  const existing = db.prepare("SELECT id FROM profiles WHERE email = ? COLLATE NOCASE").get(email);
  if (bootstrapMode && !existing) throw new Error("등록된 관리자 계정과 이메일이 일치하지 않습니다. 사용하던 관리자 이메일로 다시 시도해 주세요.");
  const id = existing?.id || crypto.randomUUID();
  const passwordHash = await hashPassword(password);
  if (existing) {
    if (bootstrapMode) db.prepare("UPDATE profiles SET role = 'admin', status = 'active', password_hash = ? WHERE id = ?").run(passwordHash, id);
    else db.prepare("UPDATE profiles SET full_name = ?, department = ?, role = 'admin', status = 'active', password_hash = ? WHERE id = ?").run(fullName, department, passwordHash, id);
  } else {
    db.prepare(`INSERT INTO profiles (id, email, full_name, department, password_hash, role, status)
      VALUES (?, ?, ?, ?, ?, 'admin', 'active')`).run(id, email, fullName, department, passwordHash);
  }
  if (bootstrapMode) clearBootstrapCredentials();
  console.log("관리자 계정을 등록했습니다. 이 이메일과 비밀번호로 웹 앱에 로그인하세요.");
  db.close();
}

main().catch((error) => {
  if (process.env.ONGYEOL_ADMIN_EMAIL || process.env.ONGYEOL_ADMIN_PASSWORD) clearBootstrapCredentials();
  console.error(error.message);
  db.close();
  process.exitCode = 1;
});
