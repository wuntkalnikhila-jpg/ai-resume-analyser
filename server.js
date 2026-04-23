require("dotenv").config();
const express = require("express");
const GROQ_KEY = process.env.GROQ_API_KEY || "";
console.log("GROQ_API_KEY:", GROQ_KEY ? "FOUND" : "MISSING");
const cors = require("cors");
const Groq = require("groq-sdk");
const pdfParse = require("pdf-parse");
const PDFDocument = require("pdfkit");
const path = require("path");

const app = express();
const PORT = process.env.PORT || 3001;

app.use(cors());
app.use(express.json({ limit: "20mb" }));
app.use(express.static(path.join(__dirname)));

const groq = new Groq({ apiKey: GROQ_KEY });

async function ask(prompt, system) {
  const res = await groq.chat.completions.create({
    model: "llama-3.3-70b-versatile",
    max_tokens: 4000,
    messages: [
      { role: "system", content: system || "You are a helpful AI career assistant." },
      { role: "user", content: prompt }
    ]
  });
  return res.choices[0].message.content || "";
}

async function vision(base64, mime) {
  const res = await groq.chat.completions.create({
    model: "meta-llama/llama-4-scout-17b-16e-instruct",
    max_tokens: 4000,
    messages: [{
      role: "user",
      content: [
        { type: "image_url", image_url: { url: "data:" + mime + ";base64," + base64 } },
        { type: "text", text: "Extract every word of text from this resume image. Output only the raw text." }
      ]
    }]
  });
  return res.choices[0].message.content || "";
}

function parseJSON(text) {
  const t = text.replace(/```json/g, "").replace(/```/g, "").trim();
  try { return JSON.parse(t); } catch(e) {}
  try {
    const s = t.indexOf("{"), e2 = t.lastIndexOf("}") + 1;
    if (s >= 0 && e2 > s) return JSON.parse(t.substring(s, e2));
  } catch(e) {}
  try {
    const s = t.indexOf("["), e2 = t.lastIndexOf("]") + 1;
    if (s >= 0 && e2 > s) return JSON.parse(t.substring(s, e2));
  } catch(e) {}
  return null;
}

// index.html
app.get("/", (req, res) => res.sendFile(path.join(__dirname, "index.html")));

// Generic chat
app.post("/api/chat", async (req, res) => {
  try {
    const { prompt, system } = req.body;
    if (!prompt) return res.status(400).json({ error: "prompt required" });
    const reply = await ask(prompt, system);
    res.json({ reply });
  } catch(e) {
    console.error("chat error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Analyze
app.post("/api/resume/analyze", async (req, res) => {
  try {
    const raw = (req.body && req.body.text) ? req.body.text : "";
    if (!raw) return res.status(400).json({ error: "No content provided" });

    let resumeText = "";
    if (raw.startsWith("data:application/pdf")) {
      const buf = Buffer.from(raw.split(",")[1], "base64");
      resumeText = (await pdfParse(buf)).text;
    } else if (raw.startsWith("data:image/")) {
      const mime = raw.split(";")[0].split(":")[1];
      const b64 = raw.split(",")[1];
      resumeText = await vision(b64, mime);
    } else {
      resumeText = raw;
    }

    if (!resumeText || resumeText.trim().length < 20)
      return res.status(400).json({ error: "Could not extract text. Try a PDF or TXT file." });

    const result = await ask(
      `Analyze this resume. Return ONLY JSON, no markdown:\n{"name":"","email":"","phone":"","location":"","summary":"2 sentences","overallScore":75,"atsScore":70,"careerLevel":"Entry","scores":{"formatting":80,"content":70,"keywords":65,"experience":75,"education":85},"strengths":["s1","s2","s3"],"weaknesses":["w1","w2","w3"],"skills":["s1","s2","s3"],"missingSkills":["m1","m2"],"experience":[{"company":"","role":"","duration":"","description":""}],"education":[{"institution":"","degree":"","year":""}],"suggestions":["t1","t2","t3","t4"],"atsTips":["t1","t2","t3"],"jobRoles":["r1","r2","r3"],"industryFit":["i1","i2"]}\n\nResume:\n${resumeText.substring(0, 4000)}`,
      "You are an expert resume analyzer. Return ONLY valid JSON. No markdown."
    );

    const data = parseJSON(result);
    if (!data) return res.status(500).json({ error: "Failed to parse AI response. Try again." });
    res.json({ success: true, data });
  } catch(e) {
    console.error("analyze error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Match
app.post("/api/resume/match", async (req, res) => {
  try {
    const { resume, jobDescription } = req.body;
    if (!resume || !jobDescription) return res.status(400).json({ error: "Resume and job description required" });

    const result = await ask(
      `Match this resume to the job description. Return ONLY JSON:\n{"matchScore":75,"matchLevel":"Good Match","matchedSkills":["s1"],"missingSkills":["s1"],"matchedKeywords":["k1"],"missingKeywords":["k1"],"suggestions":["t1","t2","t3"],"summary":"one sentence"}\n\nResume: ${resume.substring(0, 2000)}\nJob: ${jobDescription.substring(0, 1000)}`,
      "You are an ATS expert. Return ONLY valid JSON."
    );

    const data = parseJSON(result);
    if (!data) return res.status(500).json({ error: "Failed to parse response. Try again." });
    res.json({ success: true, data });
  } catch(e) {
    console.error("match error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Cover Letter
app.post("/api/resume/coverletter", async (req, res) => {
  try {
    const { resume, jobDescription, company, role } = req.body;
    if (!resume) return res.status(400).json({ error: "Resume required" });

    const letter = await ask(
      `Write a ${req.body.tone || "professional"} cover letter for ${role || "this position"} at ${company || "this company"}. ${jobDescription ? "Job: " + jobDescription.substring(0, 500) : ""}\nResume: ${resume.substring(0, 2000)}\nReturn ONLY the letter text.`,
      "You are an expert cover letter writer. Return only the letter."
    );
    res.json({ success: true, letter });
  } catch(e) {
    console.error("cover error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// Interview Questions — two batches for large counts
app.post("/api/resume/interview", async (req, res) => {
  try {
    const { role, level, type, count, resume } = req.body;
    if (!role) return res.status(400).json({ error: "Role required" });

    const ctx = resume ? ` Candidate background: ${resume.substring(0, 300)}` : "";
    const batchSize = count > 25 ? 25 : count;
    const batches = count > 25 ? 2 : 1;
    let all = [];

    const cats = type === 'all' ? ['Technical','HR','Behavioral','Situational']
      : type === 'technical' ? ['Technical']
      : type === 'hr' ? ['HR','Behavioral']
      : type === 'situational' ? ['Situational']
      : ['Technical','HR','Behavioral'];

    for (let b = 0; b < batches; b++) {
      const start = b * batchSize + 1;
      const end = Math.min((b + 1) * batchSize, count);
      const n = end - start + 1;
      const result = await ask(
        `Generate exactly ${n} interview questions for a ${level} ${role}.${ctx}
Mix these categories evenly: ${cats.join(', ')}.
Mark important/tough questions difficulty "Hard", normal as "Medium", warmups as "Easy".
Return ONLY a JSON array of exactly ${n} objects, no markdown, no explanation:
[{"category":"Technical","question":"full question text","tip":"how to answer well","difficulty":"Hard"}]`,
        "You are a senior interviewer. Return ONLY a valid JSON array. No markdown."
      );
      const batch = parseJSON(result);
      if (batch && batch.length) all = all.concat(batch);
    }

    if (!all.length) return res.status(500).json({ error: "Could not generate questions. Try again." });
    res.json({ success: true, questions: all });
  } catch(e) {
    console.error("interview error:", e.message);
    res.status(500).json({ error: e.message });
  }
});

// PDF
app.post("/api/resume/pdf", (req, res) => {
  try {
    const { data } = req.body;
    if (!data) return res.status(400).json({ error: "Data required" });

    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Content-Disposition", "attachment; filename=resume-analysis.pdf");

    const doc = new PDFDocument({ margin: 50, size: "A4" });
    doc.pipe(res);

    doc.rect(0, 0, 595, 80).fill("#4f46e5");
    doc.fillColor("white").fontSize(22).font("Helvetica-Bold").text("AI Resume Analyzer Pro", 50, 20);
    doc.fontSize(11).font("Helvetica").text("Resume Analysis Report", 50, 46);
    doc.fontSize(10).text("Generated: " + new Date().toLocaleDateString(), 420, 46);
    let y = 100;

    doc.fillColor("#4f46e5").fontSize(16).font("Helvetica-Bold").text(data.name || "Candidate", 50, y); y += 22;
    doc.fillColor("#555").fontSize(10).font("Helvetica");
    if (data.email) { doc.text("Email: " + data.email, 50, y); y += 16; }
    if (data.phone) { doc.text("Phone: " + data.phone, 50, y); y += 16; }
    if (data.location) { doc.text("Location: " + data.location, 50, y); y += 16; }
    y += 10;

    doc.rect(50, y, 495, 55).fill("#eef2ff");
    doc.fillColor("#4f46e5").fontSize(12).font("Helvetica-Bold").text("Overall Score: " + (data.overallScore || 0) + "/100", 60, y + 8);
    doc.fillColor("#555").fontSize(10).font("Helvetica").text("ATS Score: " + (data.atsScore || 0) + "/100   Level: " + (data.careerLevel || "—"), 60, y + 30);
    y += 70;

    function sec(title, color) {
      if (y > 740) { doc.addPage(); y = 50; }
      doc.rect(50, y, 495, 22).fill(color || "#4f46e5");
      doc.fillColor("white").fontSize(11).font("Helvetica-Bold").text(title, 58, y + 5);
      y += 30; doc.fillColor("#000").font("Helvetica").fontSize(10);
    }
    function bul(text) {
      if (y > 740) { doc.addPage(); y = 50; }
      doc.text("• " + text, 60, y, { width: 480 }); y += doc.currentLineHeight() + 4;
    }

    sec("Score Breakdown");
    Object.entries(data.scores || {}).forEach(function([k, v]) {
      if (y > 740) { doc.addPage(); y = 50; }
      doc.rect(60, y, 380, 13).fill("#f0f0f0");
      doc.rect(60, y, Math.min(v / 100 * 380, 380), 13).fill(v >= 70 ? "#059669" : v >= 50 ? "#d97706" : "#dc2626");
      doc.fillColor("#000").fontSize(9).text(k.charAt(0).toUpperCase() + k.slice(1) + ": " + v + "/100", 450, y + 2);
      y += 19;
    }); y += 6;

    sec("Strengths", "#059669"); (data.strengths || []).forEach(bul); y += 6;
    sec("Areas to Improve", "#dc2626"); (data.weaknesses || []).forEach(bul); y += 6;
    sec("AI Suggestions", "#d97706"); (data.suggestions || []).forEach(bul); y += 6;
    sec("Skills Found", "#0891b2");
    doc.fillColor("#000").fontSize(10).text((data.skills || []).join(" · "), 60, y, { width: 480 });
    y += doc.currentLineHeight() + 14;
    sec("Missing Skills", "#7c3aed");
    doc.fillColor("#000").fontSize(10).text((data.missingSkills || []).join(" · "), 60, y, { width: 480 });
    y += doc.currentLineHeight() + 14;
    sec("Suitable Job Roles", "#0f766e");
    doc.fillColor("#000").fontSize(10).text((data.jobRoles || []).join(" · "), 60, y, { width: 480 });
    y += doc.currentLineHeight() + 14;
    sec("ATS Tips", "#1e1b4b"); (data.atsTips || []).forEach(bul);

    doc.end();
  } catch(e) {
    console.error("pdf error:", e.message);
    if (!res.headersSent) res.status(500).json({ error: e.message });
  }
});

// Catch-all — return JSON not HTML
app.use((req, res) => {
  res.status(404).json({ error: "Route not found: " + req.path });
});

app.listen(PORT, () => console.log("\n✅ AI Resume Analyzer running at http://localhost:" + PORT + "\n"));