require("dotenv").config();
const express = require("express");
const multer = require("multer");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { promisify } = require("node:util");
const { db, uploadsDir, hashPassword, verifyPassword } = require("./db");
const matchTrainingLabels = require("./training-matcher");

const app = express();
const port = Number(process.env.PORT || 3000);
const sessionDuration = 7 * 24 * 60 * 60 * 1000;
const scrypt = promisify(crypto.scrypt);
const attempts = new Map();
app.set("trust proxy", 1);
app.disable("x-powered-by");

app.use((req, res, next) => {
  res.setHeader("X-Content-Type-Options", "nosniff");
  res.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  res.setHeader("X-Frame-Options", "DENY");
  res.setHeader("Permissions-Policy", "camera=(), microphone=(), geolocation=()");
  next();
});
app.use(express.json({ limit: "32kb" }));

const publicFiles = {
  "/": "index.html",
  "/index.html": "index.html",
  "/admin": "index.html",
  "/admin/": "index.html",
  "/styles.css": "styles.css",
  "/styles-settings.css": "styles-settings.css",
  "/styles-auth.css": "styles-auth.css",
  "/styles-runtime.css": "styles-runtime.css",
  "/app.js": "app.js",
  "/training-matcher.js": "training-matcher.js",
  "/certificate-parser.js": "certificate-parser.js"
};
for (const [route, filename] of Object.entries(publicFiles)) {
  app.get(route, (_req, res) => res.sendFile(path.join(__dirname, filename)));
}
app.get("/__preview-bridge.js", (_req, res) => {
  const bridge = path.join(__dirname, "__preview-bridge.js");
  if (fs.existsSync(bridge)) return res.sendFile(bridge);
  return res.status(404).end();
});

function rejectCrossSiteWrites(req, res, next) {
  if (!["POST", "PATCH", "PUT", "DELETE"].includes(req.method)) return next();
  const origin = req.get("origin");
  if (origin) {
    let originHost;
    try { originHost = new URL(origin).host; } catch { return res.status(403).json({ error: "요청을 확인할 수 없습니다." }); }
    const requestHost = (req.get("x-forwarded-host") || req.get("host")).split(",")[0].trim();
    if (originHost !== requestHost) return res.status(403).json({ error: "요청을 확인할 수 없습니다." });
  }
  next();
}
app.use("/api", rejectCrossSiteWrites);

function limitAuthAttempts(req, res, next) {
  const now = Date.now();
  const key = req.ip;
  const current = attempts.get(key);
  if (!current || now - current.startedAt > 15 * 60 * 1000) attempts.set(key, { startedAt: now, count: 1 });
  else current.count += 1;
  if (attempts.get(key).count > 20) return res.status(429).json({ error: "시도 횟수가 많아요. 15분 뒤 다시 해주세요." });
  next();
}
const attemptsCleanup = setInterval(() => {
  const cutoff = Date.now() - 15 * 60 * 1000;
  for (const [key, value] of attempts) if (value.startedAt < cutoff) attempts.delete(key);
}, 30 * 60 * 1000);
attemptsCleanup.unref();

function getCookie(req, name) {
  const part = (req.headers.cookie || "").split(";").map((item) => item.trim()).find((item) => item.startsWith(`${name}=`));
  return part ? decodeURIComponent(part.slice(name.length + 1)) : "";
}

function cookieOptions(req) {
  return { httpOnly: true, secure: req.secure, sameSite: "strict", path: "/", maxAge: sessionDuration };
}

function setSession(res, req, userId) {
  const token = crypto.randomBytes(32).toString("base64url");
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  db.prepare("INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)").run(tokenHash, userId, Date.now() + sessionDuration);
  res.cookie("ongyeol_session", token, cookieOptions(req));
}

function getSessionUser(req) {
  const token = getCookie(req, "ongyeol_session");
  if (!token) return null;
  const tokenHash = crypto.createHash("sha256").update(token).digest("hex");
  const session = db.prepare(`SELECT p.*, s.token_hash FROM sessions s JOIN profiles p ON p.id = s.user_id
    WHERE s.token_hash = ? AND s.expires_at > ?`).get(tokenHash, Date.now());
  if (!session) return null;
  return { ...session, tokenHash };
}

function requireUser(req, res, next) {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "로그인이 필요해요." });
  req.user = user;
  next();
}

function requireActive(req, res, next) {
  return requireUser(req, res, () => {
    if (req.user.status !== "active") return res.status(403).json({ error: "관리자 승인이 필요해요." });
    next();
  });
}

function requireAdmin(req, res, next) {
  return requireActive(req, res, () => {
    if (req.user.role !== "admin") return res.status(403).json({ error: "관리자 권한이 필요해요." });
    next();
  });
}

function getConfig() {
  const row = db.prepare("SELECT * FROM school_config WHERE id = 1").get();
  return { schoolName: row.school_name, departments: JSON.parse(row.departments_json), staff: JSON.parse(row.staff_json || "[]"), trainings: JSON.parse(row.trainings_json), onsiteTrainings: JSON.parse(row.onsite_trainings_json || "[]") };
}

function decodeUploadFilename(name) {
  const basename = path.basename(String(name || "연수자료").replaceAll("\\", "/")).replace(/[\r\n\0]/g, "_").slice(0, 180);
  const decoded = Buffer.from(basename, "latin1").toString("utf8");
  return decoded.includes("\uFFFD") ? basename : decoded;
}

function classifyTrainings(labels, trainings) {
  const matches = matchTrainingLabels(labels, trainings);
  const matchedSources = new Set(matches.flatMap((item) => item.sources));
  return { matches: matches.map((item) => item.training), individual: labels.filter((label) => !matchedSources.has(label)) };
}

function publicUser(user) {
  return { id: user.id, email: user.email, fullName: user.full_name, department: user.department, phone: user.phone || "", role: user.role, status: user.status, createdAt: user.created_at };
}

app.get("/api/setup-status", (_req, res) => {
  const adminExists = Boolean(db.prepare("SELECT 1 FROM profiles WHERE role = 'admin' AND status = 'active' LIMIT 1").get());
  res.json({ adminExists });
});

app.get("/api/public-config", (_req, res) => res.json(getConfig()));

app.post("/api/auth/register", limitAuthAttempts, async (req, res) => {
  const adminExists = db.prepare("SELECT 1 FROM profiles WHERE role = 'admin' AND status = 'active' LIMIT 1").get();
  if (!adminExists) return res.status(503).json({ error: "관리자가 먼저 계정을 설정해야 가입할 수 있어요." });
  const { email, password, fullName, department } = req.body || {};
  const phone = String(req.body?.phone || "").replace(/\D/g, "");
  const normalizedEmail = String(email || "").trim().toLowerCase();
  const name = String(fullName || "").trim();
  const config = getConfig();
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalizedEmail) || normalizedEmail.length > 254) return res.status(400).json({ error: "학교 이메일 주소를 확인해 주세요." });
  if (!name || name.length > 80 || !config.staff.some((person) => person.name === name && person.department === department)) return res.status(400).json({ error: "관리자에게 등록된 이름과 부서를 선택해 주세요." });
  if (!/^01[016789]\d{7,8}$/.test(phone)) return res.status(400).json({ error: "휴대폰 번호를 확인해 주세요." });
  if (typeof password !== "string" || password.length < 12 || password.length > 200) return res.status(400).json({ error: "비밀번호는 12자 이상으로 설정해 주세요." });
  if (db.prepare("SELECT 1 FROM profiles WHERE email = ? COLLATE NOCASE").get(normalizedEmail)) return res.status(409).json({ error: "이미 등록된 이메일입니다. 로그인해 주세요." });
  if (db.prepare("SELECT 1 FROM profiles WHERE full_name = ? AND department = ?").get(name, department)) return res.status(409).json({ error: "해당 이름과 부서의 계정이 이미 신청됐어요. 관리자에게 문의해 주세요." });
  try {
    const id = crypto.randomUUID();
    const passwordHash = await hashPassword(password);
    db.prepare("INSERT INTO profiles (id, email, full_name, department, phone, password_hash) VALUES (?, ?, ?, ?, ?, ?)").run(id, normalizedEmail, name, department, phone, passwordHash);
    res.status(201).json({ message: "가입 신청이 접수됐어요. 관리자 승인 후 로그인할 수 있습니다." });
  } catch (error) {
    console.error("Registration failed:", error.message);
    res.status(500).json({ error: "가입 신청을 처리하지 못했어요." });
  }
});

app.post("/api/auth/login", limitAuthAttempts, async (req, res) => {
  const email = String(req.body?.email || "").trim().toLowerCase();
  const password = String(req.body?.password || "");
  const user = db.prepare("SELECT * FROM profiles WHERE email = ? COLLATE NOCASE").get(email);
  if (!user || !(await verifyPassword(password, user.password_hash))) return res.status(401).json({ error: "이메일 또는 비밀번호를 확인해 주세요." });
  setSession(res, req, user.id);
  res.json({ user: publicUser(user) });
});

app.get("/api/auth/me", (req, res) => {
  const user = getSessionUser(req);
  if (!user) return res.status(401).json({ error: "로그인이 필요해요." });
  res.json({ user: publicUser(user) });
});

app.post("/api/auth/logout", (req, res) => {
  const user = getSessionUser(req);
  if (user) db.prepare("DELETE FROM sessions WHERE token_hash = ?").run(user.tokenHash);
  res.clearCookie("ongyeol_session", { httpOnly: true, secure: req.secure, sameSite: "strict", path: "/" });
  res.json({ ok: true });
});

app.get("/api/config", requireActive, (_req, res) => res.json(getConfig()));

app.put("/api/config", requireAdmin, (req, res) => {
  const schoolName = String(req.body?.schoolName || "").trim();
  const departments = Array.isArray(req.body?.departments) ? [...new Set(req.body.departments.map((item) => String(item).trim()).filter(Boolean))] : [];
  const staff = Array.isArray(req.body?.staff) ? req.body.staff.map((person) => ({ department: String(person.department || "").trim(), name: String(person.name || "").trim() })).filter((person) => person.department && person.name) : [];
  const trainings = Array.isArray(req.body?.trainings) ? [...new Set(req.body.trainings.map((item) => String(item).trim()).filter(Boolean))] : [];
  const onsiteTrainings = Array.isArray(req.body?.onsiteTrainings) ? [...new Set(req.body.onsiteTrainings.map((item) => String(item).trim()).filter(Boolean))] : [];
  if (!schoolName || schoolName.length > 120 || !departments.length || departments.length > 100 || !staff.length || staff.length > 2000 || staff.some((person) => !departments.includes(person.department) || person.name.length > 80) || !trainings.length || trainings.length > 100 || !onsiteTrainings.length || onsiteTrainings.length > 100) return res.status(400).json({ error: "학교·부서·교직원·원격 및 현장 연수 목록을 확인해 주세요." });
  const updateConfigAndMatches = db.transaction(() => {
    db.prepare("UPDATE school_config SET school_name = ?, departments_json = ?, staff_json = ?, trainings_json = ?, onsite_trainings_json = ? WHERE id = 1").run(schoolName, JSON.stringify(departments), JSON.stringify(staff), JSON.stringify(trainings), JSON.stringify(onsiteTrainings));
    const remoteRecords = db.prepare("SELECT id, extracted_trainings_json FROM records WHERE method = '원격연수'").all();
    const updateMatches = db.prepare("UPDATE records SET trainings_json = ?, individual_trainings_json = ?, training = ? WHERE id = ?");
    for (const record of remoteRecords) {
      const labels = JSON.parse(record.extracted_trainings_json || "[]");
      const { matches, individual } = classifyTrainings(labels, trainings);
      updateMatches.run(JSON.stringify(matches), JSON.stringify(individual), matches[0] || "미분류 연수", record.id);
    }
  });
  updateConfigAndMatches();
  res.json(getConfig());
});

const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 15 * 1024 * 1024, files: 1, fields: 6, parts: 7 } });
const insertRecord = db.prepare(`INSERT INTO records
  (id, user_id, teacher_name, department, training, trainings_json, extracted_trainings_json, individual_trainings_json, certificate_training_name, completion_date, method, file_name, file_path)
  VALUES (@id, @user_id, @teacher_name, @department, @training, @trainings_json, @extracted_trainings_json, @individual_trainings_json, @certificate_training_name, @completion_date, @method, @file_name, @file_path)`);

app.post("/api/records", requireActive, upload.single("file"), async (req, res) => {
  const { training: selectedTraining, certificateTrainingName = "", completionDate, method } = req.body || {};
  const config = getConfig();
  let extractedTrainings;
  let mappedTrainings;
  let individualTrainings;
  if (method === "원격연수") {
    try { extractedTrainings = JSON.parse(req.body.extractedTrainings || "[]"); } catch { return res.status(400).json({ error: "이수증에서 읽은 연수명을 확인해 주세요." }); }
    if (!Array.isArray(extractedTrainings) || extractedTrainings.length > 100 || extractedTrainings.some((label) => typeof label !== "string" || !label.trim() || label.length > 200)) return res.status(400).json({ error: "이수증 연수명 목록을 확인해 주세요." });
    if (!extractedTrainings.length && String(certificateTrainingName).trim()) extractedTrainings = [String(certificateTrainingName).trim()];
    if (!extractedTrainings.length) return res.status(400).json({ error: "PDF에서 연수명을 읽거나 직접 입력해 주세요." });
    const classification = classifyTrainings(extractedTrainings, config.trainings);
    const available = classification.matches;
    individualTrainings = classification.individual;
    if (req.body.selectedTrainings) {
      try { mappedTrainings = JSON.parse(req.body.selectedTrainings); } catch { return res.status(400).json({ error: "선택한 필수 연수를 확인해 주세요." }); }
      if (!Array.isArray(mappedTrainings) || mappedTrainings.some((item) => !available.includes(item))) return res.status(400).json({ error: "연수 연결 목록을 확인해 주세요." });
      mappedTrainings = [...new Set(mappedTrainings)];
    } else mappedTrainings = available;
  } else if (method === "학교현장연수") {
    if (!config.onsiteTrainings.includes(selectedTraining)) return res.status(400).json({ error: "현장연수 목록에서 연수명을 선택해 주세요." });
    extractedTrainings = [selectedTraining];
    mappedTrainings = [selectedTraining];
    individualTrainings = [];
  } else return res.status(400).json({ error: "연수 방법을 확인해 주세요." });
  const parsedDate = /^\d{4}-\d{2}-\d{2}$/.test(completionDate || "") ? new Date(`${completionDate}T00:00:00Z`) : null;
  if (!parsedDate || Number.isNaN(parsedDate.valueOf()) || parsedDate.toISOString().slice(0, 10) !== completionDate) return res.status(400).json({ error: "이수 날짜를 확인해 주세요." });
  if (!req.file) return res.status(400).json({ error: "제출 파일을 선택해 주세요." });
  const isPdf = method === "원격연수" && req.file.mimetype === "application/pdf" && req.file.buffer.subarray(0, 5).toString() === "%PDF-";
  const isPng = method === "학교현장연수" && req.file.mimetype === "image/png" && req.file.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  if (!isPdf && !isPng) return res.status(400).json({ error: "원격연수는 PDF, 현장연수는 서명 이미지로 제출해 주세요." });
  const id = crypto.randomUUID();
  const training = mappedTrainings[0] || "미분류 연수";
  const extractedName = method === "원격연수" ? extractedTrainings.join(" · ") : "";
  const extension = isPdf ? ".pdf" : ".png";
  const filePath = path.join(req.user.id, `${id}${extension}`);
  const absolutePath = path.join(uploadsDir, filePath);
  try {
    fs.mkdirSync(path.dirname(absolutePath), { recursive: true, mode: 0o700 });
    fs.writeFileSync(absolutePath, req.file.buffer, { flag: "wx", mode: 0o600 });
    const safeOriginalName = decodeUploadFilename(req.file.originalname || (isPdf ? "이수증.pdf" : "서명.png"));
    insertRecord.run({ id, user_id: req.user.id, teacher_name: req.user.full_name, department: req.user.department, training, trainings_json: JSON.stringify(mappedTrainings), extracted_trainings_json: JSON.stringify(extractedTrainings), individual_trainings_json: JSON.stringify(individualTrainings), certificate_training_name: extractedName, completion_date: completionDate, method, file_name: safeOriginalName, file_path: filePath });
    res.status(201).json({ ok: true, trainings: mappedTrainings, individualTrainings });
  } catch (error) {
    fs.rmSync(absolutePath, { force: true });
    console.error("Record save failed:", error.message);
    res.status(500).json({ error: "자료를 저장하지 못했어요." });
  }
});

app.get("/api/records", requireActive, (req, res) => {
  const rows = req.user.role === "admin"
    ? db.prepare("SELECT * FROM records ORDER BY created_at DESC").all()
    : db.prepare("SELECT * FROM records WHERE user_id = ? ORDER BY created_at DESC").all(req.user.id);
  res.json(rows.map(({ file_path, trainings_json, extracted_trainings_json, individual_trainings_json, ...record }) => ({ ...record, trainings: JSON.parse(trainings_json || "[]"), extractedTrainings: JSON.parse(extracted_trainings_json || "[]"), individualTrainings: JSON.parse(individual_trainings_json || "[]"), fileName: record.file_name, teacherName: record.teacher_name, certificateTrainingName: record.certificate_training_name, completionDate: record.completion_date, createdAt: record.created_at, userId: record.user_id })));
});

function getAuthorizedRecord(req, res, next) {
  const record = db.prepare("SELECT * FROM records WHERE id = ?").get(req.params.id);
  if (!record) return res.status(404).json({ error: "자료를 찾지 못했어요." });
  if (req.user.role !== "admin" && record.user_id !== req.user.id) return res.status(404).json({ error: "자료를 찾지 못했어요." });
  req.record = record;
  next();
}

app.get("/api/records/:id/file", requireActive, getAuthorizedRecord, (req, res) => {
  const fullPath = path.resolve(uploadsDir, req.record.file_path);
  if (!fullPath.startsWith(`${path.resolve(uploadsDir)}${path.sep}`) || !fs.existsSync(fullPath)) return res.status(404).json({ error: "파일이 없어요." });
  res.download(fullPath, req.record.file_name);
});

app.get("/api/records/:id/preview", requireActive, getAuthorizedRecord, (req, res, next) => {
  const fullPath = path.resolve(uploadsDir, req.record.file_path);
  if (!fullPath.startsWith(`${path.resolve(uploadsDir)}${path.sep}`) || !fs.existsSync(fullPath)) return res.status(404).json({ error: "파일이 없어요." });
  const encodedName = encodeURIComponent(req.record.file_name).replace(/['()*]/g, (character) => `%${character.charCodeAt(0).toString(16).toUpperCase()}`);
  const contentType = path.extname(req.record.file_name).toLowerCase() === ".pdf" ? "application/pdf" : "image/png";
  res.setHeader("Content-Type", contentType);
  res.setHeader("Content-Disposition", `inline; filename*=UTF-8''${encodedName}`);
  res.setHeader("Cache-Control", "private, no-store");
  fs.createReadStream(fullPath).on("error", next).pipe(res);
});

app.delete("/api/records/:id", requireActive, getAuthorizedRecord, (req, res) => {
  const fullPath = path.resolve(uploadsDir, req.record.file_path);
  db.prepare("DELETE FROM records WHERE id = ?").run(req.record.id);
  fs.rmSync(fullPath, { force: true });
  res.json({ ok: true });
});

app.get("/api/admin/users", requireAdmin, (_req, res) => {
  const users = db.prepare("SELECT id, email, full_name, department, phone, role, status, created_at FROM profiles ORDER BY created_at").all();
  res.json(users.map((user) => publicUser(user)));
});

app.patch("/api/admin/users/:id/approve", requireAdmin, (req, res) => {
  const result = db.prepare("UPDATE profiles SET status = 'active' WHERE id = ? AND role = 'teacher' AND status = 'pending'").run(req.params.id);
  if (!result.changes) return res.status(404).json({ error: "승인 대기 중인 계정을 찾지 못했어요." });
  res.json({ ok: true });
});

app.delete("/api/admin/users/:id", requireAdmin, (req, res) => {
  if (req.params.id === req.user.id) return res.status(400).json({ error: "현재 로그인한 관리자 계정은 삭제할 수 없어요." });
  const target = db.prepare("SELECT id FROM profiles WHERE id = ? AND role = 'teacher'").get(req.params.id);
  if (!target) return res.status(404).json({ error: "교직원 계정을 찾지 못했어요." });
  const files = db.prepare("SELECT file_path FROM records WHERE user_id = ?").all(target.id);
  db.prepare("DELETE FROM profiles WHERE id = ?").run(target.id);
  for (const file of files) fs.rmSync(path.join(uploadsDir, file.file_path), { force: true });
  res.json({ ok: true });
});

app.use((error, _req, res, _next) => {
  if (error instanceof multer.MulterError && error.code === "LIMIT_FILE_SIZE") return res.status(413).json({ error: "파일은 15MB 이하로 올려 주세요." });
  if (error instanceof multer.MulterError) return res.status(400).json({ error: "파일을 확인해 주세요." });
  console.error("Request failed:", error.message);
  res.status(500).json({ error: "요청을 처리하지 못했어요." });
});

app.listen(port, "0.0.0.0", () => {
  const adminExists = Boolean(db.prepare("SELECT 1 FROM profiles WHERE role = 'admin' AND status = 'active' LIMIT 1").get());
  console.log(`연수 확인 서버가 ${port} 포트에서 실행 중입니다.`);
  if (!adminExists) console.log("최초 관리자 설정: npm run admin:create");
});
