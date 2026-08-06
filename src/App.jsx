import { useState, useRef, useCallback, useEffect } from "react";
import React from "react";
import mammoth from "mammoth";
import { initializeApp } from "firebase/app";
import { getDatabase, ref, onValue, set, update, remove, get } from "firebase/database";

// ═══════════════════════════════════════════════════════════════════════
// FIREBASE CONFIG
// ═══════════════════════════════════════════════════════════════════════

const firebaseConfig = {
  apiKey: "AIzaSyCMIEfps34CsHDPJ2fdd7klqMpJQWK0gOA",
  authDomain: "academiq-analyser-c5e16.firebaseapp.com",
  databaseURL: "https://academiq-analyser-c5e16-default-rtdb.europe-west1.firebasedatabase.app",
  projectId: "academiq-analyser-c5e16",
  storageBucket: "academiq-analyser-c5e16.firebasestorage.app",
  messagingSenderId: "351045621256",
  appId: "1:351045621256:web:b906cf6e056f78a005e3bd"
};

const app = initializeApp(firebaseConfig);
const db_rt = getDatabase(app);

// ═══════════════════════════════════════════════════════════════════════
// CONSTANTS
// ═══════════════════════════════════════════════════════════════════════

const LEVELS = ["Diploma","Advanced Diploma","PGDip","BEng","MEng","PhD"];
const SA_FIELDS = ["Mechanical Engineering","Electrical Engineering","Civil Engineering","Chemical Engineering","Industrial Engineering","Electronics Engineering","Computer Engineering","Mechatronics Engineering","Aeronautical Engineering","Aerospace Engineering","Agricultural Engineering","Biomedical Engineering","Environmental Engineering","Mining Engineering","Metallurgical Engineering","Nuclear Engineering","Petroleum Engineering","Structural Engineering","Water Resources Engineering","Transportation Engineering","Systems Engineering","Safety Engineering","Fire Engineering","Geotechnical Engineering","Coastal Engineering","Construction Engineering","Materials Engineering","Welding Engineering","Industrial & Systems Engineering","Electrical & Computer Engineering","Mechanical & Nuclear Engineering","Civil & Environmental Engineering","Electrical & Electronics Engineering"];
const STRICTNESS = [{id:"lenient",label:"Lenient",desc:"Encouraging, gentle suggestions",color:"#16a34a"},{id:"balanced",label:"Balanced",desc:"Fair — equal weight to strengths & gaps",color:"#2563b0"},{id:"strict",label:"Strict",desc:"No-nonsense, rigorous academic standards",color:"#d97706"},{id:"brutal",label:"Brutal",desc:"Examiner-level — every weakness exposed",color:"#dc2626"}];
const STRICTNESS_PROMPTS = {lenient:"You are a supportive academic supervisor. Lead with strengths. Frame all criticism as gentle suggestions. Score generously.",balanced:"You are a fair academic supervisor. Equal weight to strengths and weaknesses. Professional, constructive tone.",strict:"You are a strict no-nonsense academic supervisor. Do not accept incomplete work, unsupported claims or methodological errors. Call out every gap. Scores reflect quality, not effort.",brutal:"You are a rigorous external examiner. Identify every flaw, every unsupported claim, every disciplinary gap. Award marks only for what is genuinely present and correct."};
const SECURITY_QUESTIONS = ["What is the name of your institution?","What city was your first university?","What is your staff/student number?","What is the name of your department?","What is your mother's maiden name?","What was the name of your first pet?","What is your date of birth (DD/MM/YYYY)?"];
const uid = () => Math.random().toString(36).slice(2);

// ═══════════════════════════════════════════════════════════════════════
// FIREBASE HELPERS — read/write to Realtime Database
// ═══════════════════════════════════════════════════════════════════════

// Convert Firebase object (keyed by id) → array
const objToArr = (obj) => obj ? Object.values(obj) : [];

// Write a single record (upsert) to a collection
const fbSet = (collection, id, data) =>
  set(ref(db_rt, `${collection}/${id}`), data);

// Delete a record
const fbDel = (collection, id) =>
  remove(ref(db_rt, `${collection}/${id}`));

// Seed default admin once (checks if admins node is empty)
async function seedAdmin() {
  const snap = await get(ref(db_rt, "admins/adm_default"));
  if (!snap.exists()) {
    await fbSet("admins", "adm_default", {
      id: "adm_default",
      username: "nyangal",
      password: "LueRoe2012!",
      name: "Lungile Nyanga",
      email: "",
      securityQ: { question: "What is the name of your institution?", answer: "nwu" },
      createdAt: new Date().toISOString(),
    });
  }
}

// useFirebase — live-synced state from a Firebase collection
function useFirebase(collection) {
  const [data, setData] = useState([]);
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const r = ref(db_rt, collection);
    const unsub = onValue(r, (snap) => {
      setData(objToArr(snap.val()));
      setReady(true);
    });
    return () => unsub();
  }, [collection]);

  // set(record) — upserts by record.id; or accepts updater fn
  const setCol = useCallback((recordOrFn) => {
    if (typeof recordOrFn === "function") {
      // updater: fn receives current array, returns new array
      // We get current snapshot and apply
      get(ref(db_rt, collection)).then(snap => {
        const current = objToArr(snap.val());
        const next = recordOrFn(current);
        // Diff: write changed/added records, delete removed ones
        const nextIds = new Set(next.map(r => r.id));
        const prevIds = new Set(current.map(r => r.id));
        // Write all (simple approach — write everything in next)
        const updates = {};
        next.forEach(r => { updates[`${collection}/${r.id}`] = r; });
        // Delete removed
        current.forEach(r => { if (!nextIds.has(r.id)) updates[`${collection}/${r.id}`] = null; });
        update(ref(db_rt), updates);
      });
    } else {
      // single record upsert
      fbSet(collection, recordOrFn.id, recordOrFn);
    }
  }, [collection]);

  return [data, setCol, ready];
}

// ═══════════════════════════════════════════════════════════════════════
// CLAUDE API — chunked analysis engine
// ═══════════════════════════════════════════════════════════════════════

const LEVEL_LABELS = {Diploma:"National Diploma","Advanced Diploma":"Advanced Diploma",PGDip:"Postgraduate Diploma",BEng:"Bachelor of Engineering",MEng:"Master of Engineering",PhD:"Doctor of Philosophy"};
const levelLabel = student => LEVEL_LABELS[student.level] || student.level;

// Documents at or under this size are analysed in a single pass (unchanged from original behaviour).
const SINGLE_PASS_LIMIT = 14000;
// Above that, the document is split into overlapping chunks and processed via map → reduce.
const CHUNK_SIZE = 12000;
const CHUNK_OVERLAP = 400;
const MAX_CHUNKS = 12; // caps total original-document coverage at roughly 12 * (12000-400) ≈ 139,000 characters

function chunkText(text, size = CHUNK_SIZE, overlap = CHUNK_OVERLAP, maxChunks = MAX_CHUNKS) {
  if (text.length <= size) return [text];
  const chunks = [];
  let start = 0;
  while (start < text.length && chunks.length < maxChunks) {
    const end = Math.min(start + size, text.length);
    chunks.push(text.slice(start, end));
    if (end >= text.length) break;
    start = end - overlap;
  }
  return chunks;
}

async function callClaudeAPI(prompt, system, maxTokens = 4000) {
  const r = await fetch("/api/analyse", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ prompt, system, maxTokens }),
  });
  if (!r.ok) { const e = await r.json().catch(() => ({})); throw new Error(e.error || "Server error " + r.status); }
  const d = await r.json();
  return (d.text || "").replace(/```json|```/g, "").trim();
}

// Structurally repairs truncated/malformed JSON by tracking open braces/brackets/strings
// and appending exactly what's needed to close them, in the correct order.
function autoCloseJson(raw) {
  let s = raw.trim();
  const firstBrace = s.indexOf("{");
  if (firstBrace > 0) s = s.slice(firstBrace); // strip any preamble prose before the JSON starts
  let inString = false, escape = false;
  const stack = [];
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (escape) { escape = false; continue; }
    if (ch === "\\" && inString) { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{" || ch === "[") stack.push(ch);
    else if (ch === "}" || ch === "]") stack.pop();
  }
  let repaired = s;
  if (inString) repaired += '"';
  repaired = repaired.replace(/,\s*$/, "");
  while (stack.length) repaired += stack.pop() === "{" ? "}" : "]";
  return repaired;
}

function parseJsonLoose(raw, failMessage) {
  try { return JSON.parse(raw); } catch (e) {
    try { return JSON.parse(autoCloseJson(raw)); } catch (e2) {}
    const repairs = [raw + '"]}', raw + '"}]}', raw + '"]}]}', raw.replace(/,\s*$/, "") + "}}}", raw.replace(/,\s*$/, "") + "}}}}", raw.replace(/,\s*$/, "") + "}}}}}", raw.replace(/,\s*$/, "") + "}}}}}}"];
    for (const a of repairs) { try { return JSON.parse(a); } catch (e3) {} }
    throw new Error(failMessage || "Could not parse the AI response as JSON.");
  }
}

// ── Single-pass (document fits in one call) ─────────────────────────────

async function analyzeDocSingle(text, student, supNotes, docContext) {
  const sys = STRICTNESS_PROMPTS[student.strictness || "strict"];
  const fields = (student.fields || []).join(", ") || "Engineering";
  const level = levelLabel(student);
  const prompt = `Analyse this ${level} engineering project in ${fields} for ${student.initials} ${student.surname} (${student.number}) at a South African university.
${student.rubric ? `\nRUBRIC:\n${student.rubric}\n` : ""}
${supNotes ? `\nSUPERVISOR NOTES:\n${supNotes}\n` : ""}
${buildDocContextInstruction(docContext)}
PROJECT TEXT:
---
${text}
---
Return ONLY valid JSON:
{"overallScore":<0-100>,"overallGrade":"<F|D|C|B|A|A+>","overallVerdict":"<2-3 sentences>","supervisorDecision":"<APPROVED|MINOR REVISIONS|MAJOR REVISIONS|NOT APPROVED>","sections":[{"name":"<n>","score":<0-100>,"grade":"<F|D|C|B|A>","strengths":["<s>"],"weaknesses":["<w>"],"supervisorInstruction":"<inst>"}],"criticalIssues":["<i>"],"positives":["<p>"],"priorityActions":[{"priority":"Critical|Serious|Important|Minor","action":"<a>"}],"disciplinaryAssessment":"<para>","ecsa_ga_notes":"<para>"}`;
  const raw = await callClaudeAPI(prompt, sys, 8000);
  return parseJsonLoose(raw, "Document may be too large. Try submitting one chapter at a time (under 500KB recommended).");
}

async function analyzeDocExtendedSingle(text, student, citationStyle, supNotes, docContext) {
  const fields = (student.fields || []).join(", ") || "Engineering";
  const level = levelLabel(student);
  const styleLabel = CITATION_STYLES.find(s => s.id === citationStyle)?.label || citationStyle;
  const prompt = `You are an expert academic editor and plagiarism/AI detection specialist conducting a comprehensive editorial review of a ${level} engineering project in ${fields} for ${student.initials} ${student.surname} (${student.number}) at a South African university.

Citation style declared: ${styleLabel}
${supNotes ? `Supervisor notes: ${supNotes}` : ""}
${buildDocContextInstruction(docContext)}
PROJECT TEXT (full):
---
${text}
---

Conduct the following comprehensive review and return ONLY valid JSON (no markdown):

{
  "languageReview": {
    "overallLanguageScore": <0-100>,
    "spellingErrors": [{"original":"<wrong>","correction":"<right>","context":"<surrounding text snippet>"}],
    "grammarErrors": [{"issue":"<description>","location":"<text snippet>","suggestion":"<corrected version>"}],
    "styleIssues": [{"type":"<Wordiness|Passive voice|Ambiguity|etc>","location":"<text snippet>","suggestion":"<improvement>"}],
    "readabilityScore": <0-100>,
    "readabilityComment": "<paragraph>"
  },
  "literatureReview": {
    "funnelApproachScore": <0-100>,
    "funnelApproachComment": "<paragraph — does it move from broad to specific?>",
    "relevanceScore": <0-100>,
    "relevanceComment": "<paragraph — are sources relevant to the topic?>",
    "criticalAnalysisScore": <0-100>,
    "criticalAnalysisComment": "<paragraph — does student critically analyse or just summarise?>",
    "flowScore": <0-100>,
    "flowComment": "<paragraph — does literature review flow logically?>",
    "gaps": ["<gap or missing aspect>"],
    "strengths": ["<strength>"]
  },
  "citationReview": {
    "declaredStyle": "${styleLabel}",
    "overallCitationScore": <0-100>,
    "inTextCitations": [
      {
        "citation": "<exact in-text citation as it appears>",
        "location": "<surrounding sentence>",
        "isCorrect": <true|false>,
        "issue": "<null or description of problem>",
        "correction": "<null or corrected version>",
        "referenceKey": "<surname/number that links to references list>",
        "searchQuery": "<best Google Scholar search query to find this source>"
      }
    ],
    "referenceList": [
      {
        "key": "<surname or number>",
        "fullReference": "<full reference as it appears in document>",
        "isCorrect": <true|false>,
        "issue": "<null or formatting problem>",
        "correction": "<null or corrected version>",
        "searchQuery": "<Google Scholar search query>",
        "doiOrUrl": "<DOI or URL if found in text, else null>"
      }
    ],
    "missingReferences": ["<citation that appears in text but not in reference list>"],
    "orphanedReferences": ["<reference in list but not cited in text>"],
    "citationIssuesSummary": "<paragraph>"
  },
  "aiDetection": {
    "estimatedAiPercentage": <0-100>,
    "confidence": "<Low|Medium|High>",
    "aiSections": [
      {
        "section": "<section name or heading>",
        "excerpt": "<first 120 chars of suspected AI text>",
        "likelihood": "<Low|Medium|High>",
        "indicators": ["<indicator 1>","<indicator 2>"]
      }
    ],
    "humanSections": ["<section or aspect that reads as genuinely human-written>"],
    "aiComment": "<overall paragraph about AI usage patterns detected>"
  },
  "informationFlow": {
    "overallFlowScore": <0-100>,
    "sectionFlow": [
      {"section":"<name>","flowScore":<0-100>,"comment":"<brief>","issue":"<null or problem>"}
    ],
    "transitionQuality": "<Poor|Fair|Good|Excellent>",
    "logicalProgressionComment": "<paragraph>",
    "recommendations": ["<recommendation>"]
  },
  "editorialSummary": "<2-3 paragraph overall editorial verdict>",
  "priorityCorrections": [
    {"priority":"Critical|Serious|Important|Minor","type":"<Language|Citation|AI|Flow|LitReview>","action":"<specific action required>"}
  ]
}`;
  const raw = await callClaudeAPI(prompt, "You are an expert academic editor, citation specialist, and AI-content detection analyst. Be thorough, specific and precise. Always return valid JSON only.", 8000);
  return parseJsonLoose(raw, "Document too large for extended analysis in one pass. Submit one chapter at a time.");
}

// ── Map phase: summarise each fragment of a large document ──────────────

async function mapChunkSummary(chunk, index, total, student, docContext) {
  const level = levelLabel(student);
  const ctxNote = docContext?.documentType === "proposal" ? "Note: this document is a RESEARCH PROPOSAL, not a completed thesis — do not flag the absence of Results/Discussion/Conclusion as a weakness.\n" : docContext?.documentType === "wip" ? "Note: this is a WORK-IN-PROGRESS submission — only note weaknesses within the content actually present; do not flag later chapters as missing.\n" : "";
  const prompt = `You are assisting with a chunked review of a large ${level} engineering document. This is FRAGMENT ${index + 1} of ${total} of the SAME document (it was split purely for processing length — treat it as a slice of a larger whole, not a standalone document).
${ctxNote}
FRAGMENT TEXT:
---
${chunk}
---

Return ONLY valid JSON summarising this fragment. Keep it concise — at most 5 items in each list (pick the most significant), and keep each list item to one short sentence, so the whole response stays compact:
{"likelySection":"<Introduction|Literature Review|Methodology|Results|Discussion|Conclusion|References|Appendix|Mixed/Unclear>","summary":"<3-4 sentence factual summary of what this fragment covers>","strengths":["<specific strength, one short sentence, max 5 items>"],"weaknesses":["<specific weakness/issue, one short sentence, max 5 items>"],"notableCitations":["<citation exactly as it appears, max 5 items, omit if none>"],"languageNotes":["<spelling/grammar/style issue with a short snippet, max 5 items, omit if none>"]}`;
  const raw = await callClaudeAPI(prompt, "You are a meticulous academic reviewer producing structured notes on one fragment of a larger document. Return only JSON. Be concise.", 2200);
  try {
    return parseJsonLoose(raw, `Could not process section ${index + 1} of ${total}.`);
  } catch (e) {
    // Degrade gracefully — one unparsable fragment shouldn't abort the whole submission.
    return { likelySection: "Unclear", summary: `[Section ${index + 1} of ${total} could not be automatically summarised — its content was not captured in this report.]`, strengths: [], weaknesses: [], notableCitations: [], languageNotes: [], _failed: true };
  }
}

const digestChunks = summaries => summaries.map((c, i) =>
  `--- Fragment ${i + 1}/${summaries.length} (${c.likelySection || "Unclear"}) ---\n` +
  `Summary: ${c.summary || "—"}\n` +
  `Strengths: ${(c.strengths || []).join("; ") || "none noted"}\n` +
  `Weaknesses: ${(c.weaknesses || []).join("; ") || "none noted"}` +
  (c.notableCitations?.length ? `\nCitations seen: ${c.notableCitations.join("; ")}` : "") +
  (c.languageNotes?.length ? `\nLanguage notes: ${c.languageNotes.join("; ")}` : "")
).join("\n\n");

// ── Reduce phase: synthesise the final report from all fragment notes ───

async function reduceStandardFromChunks(chunkSummaries, student, supNotes, docContext) {
  const sys = STRICTNESS_PROMPTS[student.strictness || "strict"];
  const fields = (student.fields || []).join(", ") || "Engineering";
  const level = levelLabel(student);
  const digest = digestChunks(chunkSummaries);
  const prompt = `Analyse this ${level} engineering project in ${fields} for ${student.initials} ${student.surname} (${student.number}) at a South African university.
${student.rubric ? `\nRUBRIC:\n${student.rubric}\n` : ""}
${supNotes ? `\nSUPERVISOR NOTES:\n${supNotes}\n` : ""}
${buildDocContextInstruction(docContext)}
This document was too large to read in a single pass, so it was split into ${chunkSummaries.length} sequential fragments covering the FULL document end-to-end, and each fragment was pre-analysed. Below are the fragment-by-fragment notes. Synthesise ONE holistic assessment of the WHOLE document from these notes, exactly as if you had read the entire document directly — do not mention that it was split into fragments anywhere in your output.

FRAGMENT-BY-FRAGMENT NOTES:
${digest}

Return ONLY valid JSON:
{"overallScore":<0-100>,"overallGrade":"<F|D|C|B|A|A+>","overallVerdict":"<2-3 sentences>","supervisorDecision":"<APPROVED|MINOR REVISIONS|MAJOR REVISIONS|NOT APPROVED>","sections":[{"name":"<n>","score":<0-100>,"grade":"<F|D|C|B|A>","strengths":["<s>"],"weaknesses":["<w>"],"supervisorInstruction":"<inst>"}],"criticalIssues":["<i>"],"positives":["<p>"],"priorityActions":[{"priority":"Critical|Serious|Important|Minor","action":"<a>"}],"disciplinaryAssessment":"<para>","ecsa_ga_notes":"<para>"}`;
  const raw = await callClaudeAPI(prompt, sys, 8000);
  return parseJsonLoose(raw, "Could not synthesise the final report from the analysed sections.");
}

async function reduceExtendedFromChunks(chunkSummaries, student, citationStyle, supNotes, docContext) {
  const fields = (student.fields || []).join(", ") || "Engineering";
  const level = levelLabel(student);
  const styleLabel = CITATION_STYLES.find(s => s.id === citationStyle)?.label || citationStyle;
  const digest = digestChunks(chunkSummaries);
  const prompt = `You are an expert academic editor and plagiarism/AI detection specialist conducting a comprehensive editorial review of a ${level} engineering project in ${fields} for ${student.initials} ${student.surname} (${student.number}) at a South African university.

Citation style declared: ${styleLabel}
${supNotes ? `Supervisor notes: ${supNotes}` : ""}
${buildDocContextInstruction(docContext)}
This document was too large to read in a single pass, so it was split into ${chunkSummaries.length} sequential fragments covering the FULL document end-to-end, and each fragment was pre-analysed (including any citations and language issues spotted in that fragment). Below are the fragment-by-fragment notes. Synthesise ONE holistic editorial review of the WHOLE document from these notes, exactly as if you had read the entire document directly — do not mention that it was split into fragments anywhere in your output.

FRAGMENT-BY-FRAGMENT NOTES:
${digest}

Conduct the following comprehensive review and return ONLY valid JSON (no markdown):

{
  "languageReview": {
    "overallLanguageScore": <0-100>,
    "spellingErrors": [{"original":"<wrong>","correction":"<right>","context":"<surrounding text snippet>"}],
    "grammarErrors": [{"issue":"<description>","location":"<text snippet>","suggestion":"<corrected version>"}],
    "styleIssues": [{"type":"<Wordiness|Passive voice|Ambiguity|etc>","location":"<text snippet>","suggestion":"<improvement>"}],
    "readabilityScore": <0-100>,
    "readabilityComment": "<paragraph>"
  },
  "literatureReview": {
    "funnelApproachScore": <0-100>,
    "funnelApproachComment": "<paragraph — does it move from broad to specific?>",
    "relevanceScore": <0-100>,
    "relevanceComment": "<paragraph — are sources relevant to the topic?>",
    "criticalAnalysisScore": <0-100>,
    "criticalAnalysisComment": "<paragraph — does student critically analyse or just summarise?>",
    "flowScore": <0-100>,
    "flowComment": "<paragraph — does literature review flow logically?>",
    "gaps": ["<gap or missing aspect>"],
    "strengths": ["<strength>"]
  },
  "citationReview": {
    "declaredStyle": "${styleLabel}",
    "overallCitationScore": <0-100>,
    "inTextCitations": [
      {
        "citation": "<exact in-text citation as it appears>",
        "location": "<surrounding sentence>",
        "isCorrect": <true|false>,
        "issue": "<null or description of problem>",
        "correction": "<null or corrected version>",
        "referenceKey": "<surname/number that links to references list>",
        "searchQuery": "<best Google Scholar search query to find this source>"
      }
    ],
    "referenceList": [
      {
        "key": "<surname or number>",
        "fullReference": "<full reference as it appears in document>",
        "isCorrect": <true|false>,
        "issue": "<null or formatting problem>",
        "correction": "<null or corrected version>",
        "searchQuery": "<Google Scholar search query>",
        "doiOrUrl": "<DOI or URL if found in text, else null>"
      }
    ],
    "missingReferences": ["<citation that appears in text but not in reference list>"],
    "orphanedReferences": ["<reference in list but not cited in text>"],
    "citationIssuesSummary": "<paragraph>"
  },
  "aiDetection": {
    "estimatedAiPercentage": <0-100>,
    "confidence": "<Low|Medium|High>",
    "aiSections": [
      {
        "section": "<section name or heading>",
        "excerpt": "<first 120 chars of suspected AI text>",
        "likelihood": "<Low|Medium|High>",
        "indicators": ["<indicator 1>","<indicator 2>"]
      }
    ],
    "humanSections": ["<section or aspect that reads as genuinely human-written>"],
    "aiComment": "<overall paragraph about AI usage patterns detected>"
  },
  "informationFlow": {
    "overallFlowScore": <0-100>,
    "sectionFlow": [
      {"section":"<name>","flowScore":<0-100>,"comment":"<brief>","issue":"<null or problem>"}
    ],
    "transitionQuality": "<Poor|Fair|Good|Excellent>",
    "logicalProgressionComment": "<paragraph>",
    "recommendations": ["<recommendation>"]
  },
  "editorialSummary": "<2-3 paragraph overall editorial verdict>",
  "priorityCorrections": [
    {"priority":"Critical|Serious|Important|Minor","type":"<Language|Citation|AI|Flow|LitReview>","action":"<specific action required>"}
  ]
}`;
  const raw = await callClaudeAPI(prompt, "You are an expert academic editor, citation specialist, and AI-content detection analyst. Be thorough, specific and precise. Always return valid JSON only.", 8000);
  return parseJsonLoose(raw, "Could not synthesise the final extended review from the analysed sections.");
}

// ── Orchestrator — used by every submission path (student/supervisor/admin/co-supervisor) ──

async function analyzeSubmission(text, student, supNotes, opts = {}) {
  const { extended = false, citationStyle = "apa", onProgress, docContext } = opts;
  const report = txt => onProgress?.(txt);

  if (text.length <= SINGLE_PASS_LIMIT) {
    report(extended ? "Analysing…" : "Analysing…");
    const result = await analyzeDocSingle(text, student, supNotes, docContext);
    let extendedResult = null;
    if (extended) {
      report("Running extended review…");
      extendedResult = await analyzeDocExtendedSingle(text, student, citationStyle, supNotes, docContext);
    }
    return { result, extendedResult, chunked: false, chunksUsed: 1, charsAnalysed: text.length, totalChars: text.length };
  }

  const chunks = chunkText(text);
  const chunkSummaries = [];
  for (let i = 0; i < chunks.length; i++) {
    report(`Analysing section ${i + 1} of ${chunks.length}…`);
    chunkSummaries.push(await mapChunkSummary(chunks[i], i, chunks.length, student, docContext));
  }
  report("Synthesising full report…");
  const result = await reduceStandardFromChunks(chunkSummaries, student, supNotes, docContext);
  let extendedResult = null;
  if (extended) {
    report("Synthesising extended review…");
    extendedResult = await reduceExtendedFromChunks(chunkSummaries, student, citationStyle, supNotes, docContext);
  }
  const charsAnalysed = CHUNK_SIZE + (chunks.length - 1) * (CHUNK_SIZE - CHUNK_OVERLAP);
  const chunksFailed = chunkSummaries.filter(c => c._failed).length;
  return { result, extendedResult, chunked: true, chunksUsed: chunks.length, chunksFailed, charsAnalysed: Math.min(charsAnalysed, text.length), totalChars: text.length };
}

// ═══════════════════════════════════════════════════════════════════════
// SCORE / COLOR UTILS
// ═══════════════════════════════════════════════════════════════════════

const sc  = s => s>=75?"#16a34a":s>=60?"#2563b0":s>=50?"#d97706":"#dc2626";
const sb  = s => s>=75?"#dcfce7":s>=60?"#dbeafe":s>=50?"#fef3c7":"#fee2e2";
const pc  = p => ({Critical:"#7f1d1d",Serious:"#dc2626",Important:"#d97706",Minor:"#2563b0"})[p]||"#666";
const pb  = p => ({Critical:"#450a0a",Serious:"#fee2e2",Important:"#fef3c7",Minor:"#eff6ff"})[p]||"#f5f5f5";
const dc2 = d => ({APPROVED:"#16a34a","MINOR REVISIONS":"#2563b0","MAJOR REVISIONS":"#d97706","NOT APPROVED":"#dc2626"})[d]||"#666";

// Returns a short display label for a submission's document-type context, or null for
// a plain full-thesis submission with no special context worth calling out.
function docTypeBadgeLabel(submission) {
  if (submission.documentType === "proposal") return "Research Proposal";
  if (submission.documentType === "wip") return "Work in Progress" + (submission.chaptersReviewed?.length ? ` · ${submission.chaptersReviewed.join(", ")}` : "");
  if (submission.chapterByChapter) return "Chapter-by-Chapter Review";
  return null;
}

// ═══════════════════════════════════════════════════════════════════════
// SHARED STYLES
// ═══════════════════════════════════════════════════════════════════════

const IS = {width:"100%",padding:"10px 12px",borderRadius:9,border:"1.5px solid #e2e8f0",fontSize:13,outline:"none",background:"white",color:"#0f172a",boxSizing:"border-box",fontFamily:"inherit"};
const LS = {display:"block",fontSize:11,fontWeight:700,color:"#64748b",marginBottom:5,textTransform:"uppercase",letterSpacing:"0.05em"};
const BP = {width:"100%",padding:"11px 20px",borderRadius:10,border:"none",background:"linear-gradient(135deg,#2563eb,#1d4ed8)",color:"white",fontWeight:700,fontSize:14,cursor:"pointer"};
const BS = {width:"100%",padding:"11px 20px",borderRadius:10,border:"1.5px solid #e2e8f0",background:"white",color:"#374151",fontWeight:600,fontSize:14,cursor:"pointer"};

// ═══════════════════════════════════════════════════════════════════════
// APP ROOT — now uses useFirebase instead of useStore
// ═══════════════════════════════════════════════════════════════════════

export default function App() {
  const [admins,     setAdmins,     adminsReady]     = useFirebase("admins");
  const [supervisors,setSupervisors,supervisorsReady] = useFirebase("supervisors");
  const [students,   setStudents,   studentsReady]   = useFirebase("students");
  const [submissions,setSubmissions,submissionsReady]= useFirebase("submissions");
  const [institutionBranding,setInstitutionBranding,brandingReady]= useFirebase("institutionBranding");
  const [session,    setSession]    = useState(null);
  const [toast,      setToast]      = useState(null);
  const [seeded,     setSeeded]     = useState(false);

  const ready = adminsReady && supervisorsReady && studentsReady && submissionsReady;
  const showToast = (msg, type="success") => setToast({msg, type});

  useEffect(() => {
    if (adminsReady && !seeded) {
      seedAdmin();
      setSeeded(true);
    }
  }, [adminsReady, seeded]);

  const db = { admins, setAdmins, supervisors, setSupervisors, students, setStudents, submissions, setSubmissions, institutionBranding, setInstitutionBranding };
  const logout = () => setSession(null);

  if (!ready) return (
    <div style={{minHeight:"100vh",background:"#0f172a",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"system-ui,sans-serif"}}>
      <div style={{textAlign:"center",color:"white"}}>
        <div style={{width:48,height:48,borderRadius:14,background:"linear-gradient(135deg,#3b82f6,#1d4ed8)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 16px"}}>
          <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="white" strokeWidth="2"><path d="M21 12a9 9 0 11-6.219-8.56" style={{animation:"spin 1s linear infinite",transformOrigin:"center"}}/></svg>
        </div>
        <div style={{fontWeight:700,fontSize:16}}>Connecting to AcademiQ…</div>
        <div style={{color:"rgba(255,255,255,.4)",fontSize:13,marginTop:5}}>Loading data from Firebase</div>
      </div>
      <style>{"@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}"}</style>
    </div>
  );

  if (!session) return (
    <>
      <LoginGateway db={db} onLogin={setSession} showToast={showToast}/>
      {toast && <Toast msg={toast.msg} type={toast.type} onDone={()=>setToast(null)}/>}
    </>
  );

  return (
    <>
      {session.role==="admin"      && <AdminPortal      db={db} session={session} onLogout={logout} showToast={showToast}/>}
      {session.role==="supervisor" && <SupervisorPortal db={db} session={session} onLogout={logout} showToast={showToast}/>}
      {session.role==="student"    && <StudentPortal    db={db} session={session} onLogout={logout} showToast={showToast}/>}
      {toast && <Toast msg={toast.msg} type={toast.type} onDone={()=>setToast(null)}/>}
      <style>{"@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}"}</style>
    </>
  );
}


// ═══════════════════════════════════════════════════════════════════════
// UI PRIMITIVES (Icon, PwdInput, Toast, Pill, Err, Modal)
// ═══════════════════════════════════════════════════════════════════════

function Ic({n,size=18,c="currentColor"}){
  const paths={
    award:`<circle cx="12" cy="8" r="7"/><polyline points="8.21 13.89 7 23 12 20 17 23 15.79 13.88"/>`,
    users:`<path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/>`,
    user:`<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>`,
    file:`<path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/>`,
    chart:`<line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/>`,
    settings:`<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 0 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 0 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 0 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 0 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>`,
    plus:`<line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/>`,
    edit:`<path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>`,
    trash:`<polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a1 1 0 0 1 1-1h4a1 1 0 0 1 1 1v2"/>`,
    eye:`<path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/>`,
    eyeoff:`<path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/>`,
    logout:`<path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/><polyline points="16 17 21 12 16 7"/><line x1="21" y1="12" x2="9" y2="12"/>`,
    check:`<polyline points="20 6 9 17 4 12"/>`,
    x:`<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>`,
    key:`<path d="M21 2l-2 2m-7.61 7.61a5.5 5.5 0 1 1-7.778 7.778 5.5 5.5 0 0 1 7.777-7.777zm0 0L15.5 7.5m0 0l3 3L22 7l-3-3m-3.5 3.5L19 4"/>`,
    lock:`<rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/>`,
    upload:`<polyline points="16 16 12 12 8 16"/><line x1="12" y1="12" x2="12" y2="21"/><path d="M20.39 18.39A5 5 0 0 0 18 9h-1.26A8 8 0 1 0 3 16.3"/>`,
    spin:`<path d="M21 12a9 9 0 11-6.219-8.56"/>`,
    chevron:`<polyline points="9 18 15 12 9 6"/>`,
    shield:`<path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/>`,
    link2:`<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>`,
    unlink:`<path d="M18.84 12.25l1.72-1.71a5.004 5.004 0 0 0-.12-7.07 5.006 5.006 0 0 0-6.95 0l-1.72 1.71"/><path d="M13.41 18.41l-1.72 1.71a5.004 5.004 0 0 1-7.07 0 4.996 4.996 0 0 1 0-7.07l1.71-1.71"/><line x1="8" y1="2" x2="8" y2="5"/><line x1="2" y1="8" x2="5" y2="8"/><line x1="16" y1="19" x2="16" y2="22"/><line x1="19" y1="16" x2="22" y2="16"/>`,
    bell:`<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>`,
    download:`<path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/>`,
    building:`<rect x="4" y="2" width="16" height="20" rx="1"/><line x1="9" y1="6" x2="9" y2="6.01"/><line x1="15" y1="6" x2="15" y2="6.01"/><line x1="9" y1="10" x2="9" y2="10.01"/><line x1="15" y1="10" x2="15" y2="10.01"/><line x1="9" y1="14" x2="9" y2="14.01"/><line x1="15" y1="14" x2="15" y2="14.01"/><line x1="9" y1="18" x2="15" y2="18"/>`,
  };
  return React.createElement("svg",{width:size,height:size,viewBox:"0 0 24 24",fill:"none",stroke:c,strokeWidth:"2",strokeLinecap:"round",strokeLinejoin:"round",dangerouslySetInnerHTML:{__html:paths[n]||""}});
}

function PwdInput({value,onChange,placeholder,onEnter}){
  const[show,setShow]=useState(false);
  return React.createElement("div",{style:{position:"relative"}},
    React.createElement("input",{type:show?"text":"password",value,onChange,placeholder:placeholder||"Password",onKeyDown:e=>e.key==="Enter"&&onEnter&&onEnter(),style:{...IS,paddingRight:40}}),
    React.createElement("button",{type:"button",onClick:()=>setShow(s=>!s),style:{position:"absolute",right:10,top:"50%",transform:"translateY(-50%)",background:"none",border:"none",cursor:"pointer",color:"#94a3b8",padding:2}},
      React.createElement(Ic,{n:show?"eyeoff":"eye",size:16}))
  );
}

function Toast({msg,type,onDone}){useEffect(()=>{const t=setTimeout(onDone,3500);return()=>clearTimeout(t);},[]);const bg=type==="success"?"#16a34a":type==="error"?"#dc2626":"#2563b0";return React.createElement("div",{style:{position:"fixed",bottom:24,right:24,background:bg,color:"white",padding:"12px 20px",borderRadius:12,fontSize:13,fontWeight:600,zIndex:9999,boxShadow:"0 8px 24px rgba(0,0,0,.25)",maxWidth:360,lineHeight:1.5}},msg);}


// ═══════════════════════════════════════════════════════════════
// LOGIN GATEWAY
// ═══════════════════════════════════════════════════════════════

function LoginGateway({db,onLogin,showToast}){
  const[tab,setTab]=useState("student");
  const[view,setView]=useState("login");
  const[err,setErr]=useState("");
  if(view==="forgot_admin") return <ForgotScreen role="admin" db={db} onBack={()=>setView("login")} showToast={showToast}/>;
  if(view==="forgot_sup")   return <ForgotScreen role="supervisor" db={db} onBack={()=>setView("login")} showToast={showToast}/>;
  if(view==="forgot_stu")   return <ForgotScreen role="student" db={db} onBack={()=>setView("login")} showToast={showToast}/>;
  if(view==="reg_sup")      return <RegisterSup db={db} onBack={()=>setView("login")} showToast={showToast}/>;
  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(135deg,#0f172a 0%,#1e3a5f 60%,#0f2744 100%)",display:"flex",flexDirection:"column",alignItems:"center",justifyContent:"center",fontFamily:"system-ui,sans-serif",padding:"1rem"}}>
      <div style={{textAlign:"center",marginBottom:"1.5rem"}}>
        <div style={{width:56,height:56,borderRadius:14,background:"linear-gradient(135deg,#3b82f6,#1d4ed8)",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 10px",boxShadow:"0 8px 32px rgba(59,130,246,.4)"}}>
          <Ic n="award" size={28} c="white"/>
        </div>
        <h1 style={{color:"white",fontSize:24,fontWeight:800,margin:0}}>AcademiQ Analyser</h1>
        <p style={{color:"rgba(255,255,255,.4)",fontSize:13,margin:"4px 0 0"}}>South African Engineering Project Assessment</p>
      </div>
      <div style={{background:"white",borderRadius:20,padding:"1.75rem",width:"100%",maxWidth:400,boxShadow:"0 25px 60px rgba(0,0,0,.4)"}}>
        <div style={{display:"flex",background:"#f1f5f9",borderRadius:11,padding:3,marginBottom:"1.25rem",gap:2}}>
          {[["student","Student"],["supervisor","Supervisor"],["admin","Admin"]].map(([k,l])=>(
            <button key={k} onClick={()=>{setTab(k);setErr("");}} style={{flex:1,padding:"7px 0",borderRadius:8,border:"none",fontWeight:600,fontSize:12,cursor:"pointer",background:tab===k?"white":"transparent",color:tab===k?"#0f172a":"#64748b",boxShadow:tab===k?"0 1px 4px rgba(0,0,0,.1)":"none"}}>{l}</button>
          ))}
        </div>
        {tab==="student"    && <LoginForm db={db} role="student"    onLogin={onLogin} setErr={setErr} onForgot={()=>setView("forgot_stu")}/>}
        {tab==="supervisor" && <LoginForm db={db} role="supervisor" onLogin={onLogin} setErr={setErr} onForgot={()=>setView("forgot_sup")} extra={<button onClick={()=>setView("reg_sup")} style={{background:"none",border:"none",color:"#64748b",fontSize:12,cursor:"pointer",textDecoration:"underline"}}>Create account</button>}/>}
        {tab==="admin"      && <LoginForm db={db} role="admin"      onLogin={onLogin} setErr={setErr} onForgot={()=>setView("forgot_admin")}/>}
        {err&&<div style={{background:"#fee2e2",color:"#991b1b",borderRadius:8,padding:"9px 13px",fontSize:13,marginTop:10}}>{err}</div>}
      </div>
    </div>
  );
}

function LoginForm({db,role,onLogin,setErr,onForgot,extra}){
  const[id,setId]=useState(""); const[pwd,setPwd]=useState("");
  const go=()=>{
    setErr("");
    if(role==="student"){
      const s=db.students.find(x=>x.number===id.trim());
      if(!s){setErr("Student number not found. Contact your supervisor.");return;}
      if(s.password&&s.password!==pwd){setErr("Incorrect password.");return;}
      onLogin({role:"student",id:s.id});
    } else if(role==="supervisor"){
      const s=db.supervisors.find(x=>x.username===id.trim()&&x.password===pwd);
      if(!s){setErr("Invalid username or password.");return;}
      onLogin({role:"supervisor",id:s.id});
    } else {
      const a=db.admins.find(x=>x.username===id.trim()&&x.password===pwd);
      if(!a){setErr("Invalid admin credentials.");return;}
      onLogin({role:"admin",id:a.id});
    }
  };
  return (
    <>
      <p style={{fontSize:13,color:"#64748b",marginBottom:12}}>
        {role==="student"?"Enter your student number.":role==="supervisor"?"Sign in to your supervisor account.":"Administrator access only."}
      </p>
      <label style={LS}>{role==="student"?"Student Number":"Username"}</label>
      <input value={id} onChange={e=>setId(e.target.value)} placeholder={role==="student"?"e.g. 38045869":"Username"} style={{...IS,marginBottom:9}}/>
      {(role!=="student"||id)&&<><label style={LS}>Password</label><PwdInput value={pwd} onChange={e=>setPwd(e.target.value)} onEnter={go}/></>}
      <button onClick={go} style={{...BP,marginTop:11}}>Sign In</button>
      <div style={{display:"flex",justifyContent:"space-between",marginTop:7}}>
        <button onClick={onForgot} style={{background:"none",border:"none",color:"#3b82f6",fontSize:12,cursor:"pointer",textDecoration:"underline"}}>Forgot password?</button>
        {extra}
      </div>
    </>
  );
}

function RegisterSup({db,onBack,showToast}){
  const[f,setF]=useState({name:"",username:"",email:"",password:"",conf:"",sqQ:SECURITY_QUESTIONS[0],sqA:""});
  const[err,setErr]=useState("");
  const up=k=>e=>setF(p=>({...p,[k]:e.target.value}));
  const save=()=>{
    setErr("");
    if(!f.name||!f.username||!f.password)return setErr("Name, username and password required.");
    if(f.password!==f.conf)return setErr("Passwords do not match.");
    if(f.password.length<6)return setErr("Min 6 characters.");
    if(!f.sqA.trim())return setErr("Enter a security answer.");
    if(db.supervisors.find(s=>s.username===f.username.trim()))return setErr("Username already taken.");
    const sup={id:"sup_"+uid(),name:f.name.trim(),username:f.username.trim(),email:f.email.trim(),password:f.password,securityQ:{question:f.sqQ,answer:f.sqA.trim().toLowerCase()},createdAt:new Date().toISOString()};
    db.setSupervisors(p=>[...p,sup]);
    showToast("Account created! Sign in to continue.");
    onBack();
  };
  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(135deg,#0f172a,#1e3a5f,#0f2744)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"system-ui,sans-serif",padding:"1rem"}}>
      <div style={{background:"white",borderRadius:20,padding:"2rem",width:"100%",maxWidth:440,boxShadow:"0 25px 60px rgba(0,0,0,.4)"}}>
        <h2 style={{margin:"0 0 4px",fontSize:17,fontWeight:800}}>Create Supervisor Account</h2>
        <p style={{fontSize:13,color:"#64748b",margin:"0 0 16px"}}>Register to start managing student projects.</p>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
          <div><label style={LS}>Full Name *</label><input value={f.name} onChange={up("name")} placeholder="Dr A Smith" style={IS}/></div>
          <div><label style={LS}>Username *</label><input value={f.username} onChange={up("username")} placeholder="Choose username" style={IS}/></div>
        </div>
        <label style={LS}>Email (optional)</label>
        <input value={f.email} onChange={up("email")} placeholder="you@institution.ac.za" style={{...IS,marginBottom:10}}/>
        <label style={LS}>Password *</label><PwdInput value={f.password} onChange={up("password")} placeholder="Min 6 characters"/>
        <div style={{marginTop:9}}><label style={LS}>Confirm Password *</label><PwdInput value={f.conf} onChange={up("conf")} placeholder="Repeat"/></div>
        <div style={{marginTop:13,background:"#f8fafc",borderRadius:10,padding:"11px 13px"}}>
          <p style={{fontSize:12,color:"#64748b",margin:"0 0 8px"}}>Security question — for password recovery.</p>
          <select value={f.sqQ} onChange={up("sqQ")} style={{...IS,marginBottom:7}}>{SECURITY_QUESTIONS.map(q=><option key={q}>{q}</option>)}</select>
          <label style={LS}>Answer</label>
          <input value={f.sqA} onChange={up("sqA")} placeholder="Your answer (case-insensitive)" style={IS}/>
        </div>
        <Err msg={err}/>
        <div style={{display:"flex",gap:8,marginTop:13}}>
          <button onClick={save} style={BP}>Create Account</button>
          <button onClick={onBack} style={BS}>← Back</button>
        </div>
      </div>
    </div>
  );
}

function ForgotScreen({role,db,onBack,showToast}){
  const[step,setStep]=useState("find");
  const[id,setId]=useState(""); const[found,setFound]=useState(null);
  const[ans,setAns]=useState(""); const[p1,setP1]=useState(""); const[p2,setP2]=useState("");
  const[err,setErr]=useState("");
  const find=()=>{
    setErr("");
    let rec=null;
    if(role==="admin")      rec=db.admins.find(x=>x.username===id.trim());
    else if(role==="supervisor") rec=db.supervisors.find(x=>x.username===id.trim());
    else rec=db.students.find(x=>x.number===id.trim());
    if(!rec||!rec.securityQ?.question){setErr("Account not found or no security question set.");return;}
    setFound(rec); setStep("verify");
  };
  const verify=()=>{
    setErr("");
    if(ans.trim().toLowerCase()===found.securityQ.answer.toLowerCase()) setStep("reset");
    else setErr("Incorrect answer. Try again.");
  };
  const reset=()=>{
    setErr("");
    const min=role==="student"?4:6;
    if(!p1)return setErr("Enter new password.");
    if(p1.length<min)return setErr(`Min ${min} characters.`);
    if(p1!==p2)return setErr("Passwords do not match.");
    if(role==="admin")           db.setAdmins(prev=>prev.map(a=>a.id===found.id?{...a,password:p1}:a));
    else if(role==="supervisor") db.setSupervisors(prev=>prev.map(s=>s.id===found.id?{...s,password:p1}:s));
    else                         db.setStudents(prev=>prev.map(s=>s.id===found.id?{...s,password:p1}:s));
    showToast("Password reset successfully.");
    onBack();
  };
  const labels={admin:"Admin Username",supervisor:"Supervisor Username",student:"Student Number"};
  return (
    <div style={{minHeight:"100vh",background:"linear-gradient(135deg,#0f172a,#1e3a5f,#0f2744)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"system-ui,sans-serif",padding:"1rem"}}>
      <div style={{background:"white",borderRadius:20,padding:"2rem",width:"100%",maxWidth:420,boxShadow:"0 25px 60px rgba(0,0,0,.4)"}}>
        <div style={{display:"flex",alignItems:"center",gap:10,marginBottom:16}}>
          <div style={{width:36,height:36,borderRadius:9,background:"#fef3c7",display:"flex",alignItems:"center",justifyContent:"center"}}><Ic n="key" size={18} c="#d97706"/></div>
          <div><h2 style={{margin:0,fontSize:16,fontWeight:700}}>Reset Password</h2><p style={{margin:0,fontSize:12,color:"#64748b"}}>Step {step==="find"?1:step==="verify"?2:3} of 3</p></div>
        </div>
        {step==="find"&&(
          <><label style={LS}>{labels[role]}</label>
          <input value={id} onChange={e=>setId(e.target.value)} onKeyDown={e=>e.key==="Enter"&&find()} placeholder={role==="student"?"e.g. 38045869":"Your username"} style={{...IS,marginBottom:8}}/>
          <Err msg={err}/><button onClick={find} style={{...BP,marginTop:8}}>Find Account</button></>
        )}
        {step==="verify"&&found&&(
          <><div style={{background:"#f0fdf4",borderRadius:8,padding:"9px 13px",fontSize:13,color:"#14532d",marginBottom:11}}>Found: <strong>{found.name||found.initials+" "+found.surname||found.username}</strong></div>
          <label style={LS}>Security Question</label>
          <div style={{background:"#f8fafc",borderRadius:8,padding:"9px 12px",fontSize:13,marginBottom:9}}>{found.securityQ.question}</div>
          <label style={LS}>Your Answer</label>
          <input value={ans} onChange={e=>setAns(e.target.value)} onKeyDown={e=>e.key==="Enter"&&verify()} placeholder="Answer" style={{...IS,marginBottom:6}}/>
          <Err msg={err}/><button onClick={verify} style={{...BP,marginTop:8}}>Verify</button></>
        )}
        {step==="reset"&&(
          <><div style={{background:"#f0fdf4",borderRadius:8,padding:"9px 13px",fontSize:13,color:"#14532d",marginBottom:11}}>Identity verified. Set your new password.</div>
          <label style={LS}>New Password</label><PwdInput value={p1} onChange={e=>setP1(e.target.value)} placeholder="New password"/>
          <div style={{marginTop:8}}><label style={LS}>Confirm</label><PwdInput value={p2} onChange={e=>setP2(e.target.value)} placeholder="Repeat"/></div>
          <Err msg={err}/><button onClick={reset} style={{...BP,marginTop:10}}>Save Password</button></>
        )}
        <button onClick={onBack} style={{...BS,marginTop:8}}>← Back to Login</button>
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// SHELL + SHARED UI
// ═══════════════════════════════════════════════════════════

function Shell({role,nav,active,setActive,onLogout,badge,children}){
  const colors={admin:"#f59e0b",supervisor:"#3b82f6",student:"#8b5cf6"};
  const col=colors[role]||"#3b82f6";
  return (
    <div style={{display:"flex",minHeight:"100vh",fontFamily:"system-ui,sans-serif",background:"#f8fafc"}}>
      <div style={{width:208,background:"#0f172a",display:"flex",flexDirection:"column",flexShrink:0}}>
        <div style={{padding:"1.2rem 1rem 1rem",borderBottom:"1px solid rgba(255,255,255,.07)"}}>
          <div style={{display:"flex",alignItems:"center",gap:9}}>
            <div style={{width:30,height:30,borderRadius:8,background:`${col}`,display:"flex",alignItems:"center",justifyContent:"center"}}><Ic n="award" size={15} c="white"/></div>
            <div><div style={{color:"white",fontWeight:700,fontSize:13}}>AcademiQ</div><div style={{color:"rgba(255,255,255,.35)",fontSize:10,textTransform:"capitalize"}}>{role}</div></div>
          </div>
          {badge&&<div style={{marginTop:8,background:"rgba(255,255,255,.06)",borderRadius:7,padding:"5px 8px",fontSize:12,color:"rgba(255,255,255,.5)",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{badge}</div>}
        </div>
        <nav style={{flex:1,padding:".6rem .5rem"}}>
          {nav.map(n=>(
            <button key={n.id} onClick={()=>setActive(n.id)} style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:"8px 9px",borderRadius:7,border:"none",cursor:"pointer",marginBottom:1,background:active===n.id?`${col}22`:"transparent",color:active===n.id?col:"rgba(255,255,255,.45)",fontWeight:active===n.id?600:400,fontSize:13,textAlign:"left"}}>
              <Ic n={n.icon} size={14} c={active===n.id?col:"rgba(255,255,255,.45)"}/>{n.label}
            </button>
          ))}
        </nav>
        <div style={{padding:".6rem .5rem",borderTop:"1px solid rgba(255,255,255,.07)"}}>
          <button onClick={onLogout} style={{width:"100%",display:"flex",alignItems:"center",gap:8,padding:"8px 9px",borderRadius:7,border:"none",cursor:"pointer",background:"transparent",color:"rgba(255,255,255,.3)",fontSize:13}}>
            <Ic n="logout" size={14} c="rgba(255,255,255,.3)"/> Sign Out
          </button>
        </div>
      </div>
      <div style={{flex:1,overflow:"auto"}}>{children}</div>
    </div>
  );
}

function PageHeader({title,action}){return(<div style={{background:"white",borderBottom:"1px solid #e2e8f0",padding:".8rem 1.6rem",display:"flex",alignItems:"center",justifyContent:"space-between"}}><h1 style={{fontSize:16,fontWeight:700,color:"#0f172a",margin:0}}>{title}</h1>{action||null}</div>);}
function Pad({children}){return <div style={{padding:"1.5rem 1.6rem"}}>{children}</div>;}
function Err({msg}){return msg?<div style={{background:"#fee2e2",color:"#991b1b",borderRadius:8,padding:"8px 12px",fontSize:13,marginTop:9}}>{msg}</div>:null;}
function Pill({label,bg,color}){return <span style={{background:bg,color,padding:"2px 8px",borderRadius:99,fontSize:11,fontWeight:700,whiteSpace:"nowrap"}}>{label}</span>;}

function StatCards({cards}){
  return(<div style={{display:"grid",gridTemplateColumns:"repeat(auto-fit,minmax(145px,1fr))",gap:12,marginBottom:20}}>
    {cards.map(c=>(
      <div key={c.label} style={{background:"white",borderRadius:12,padding:"1rem 1.1rem",border:"1px solid #e2e8f0"}}>
        <div style={{display:"flex",alignItems:"center",justifyContent:"space-between",marginBottom:5}}>
          <span style={{fontSize:11,color:"#64748b",fontWeight:600}}>{c.label}</span>
          <div style={{width:26,height:26,borderRadius:7,background:c.color+"22",display:"flex",alignItems:"center",justifyContent:"center"}}><Ic n={c.icon} size={13} c={c.color}/></div>
        </div>
        <div style={{fontSize:23,fontWeight:800,color:"#0f172a"}}>{c.value}</div>
      </div>
    ))}
  </div>);
}

function DataTable({cols,rows,empty="No records."}){
  return(
    <div style={{background:"white",borderRadius:12,border:"1px solid #e2e8f0",overflow:"hidden"}}>
      {rows.length===0?<div style={{padding:"2.5rem",textAlign:"center",color:"#94a3b8",fontSize:13}}>{empty}</div>:(
        <table style={{width:"100%",borderCollapse:"collapse",fontSize:13}}>
          <thead><tr style={{background:"#f8fafc"}}>
            {cols.map(c=><th key={c.label} style={{padding:"7px 12px",textAlign:"left",fontSize:11,color:"#94a3b8",fontWeight:700,textTransform:"uppercase",letterSpacing:".04em",whiteSpace:"nowrap"}}>{c.label}</th>)}
          </tr></thead>
          <tbody>
            {rows.map((r,i)=><tr key={i} style={{borderTop:"1px solid #f1f5f9"}}>
              {cols.map(c=><td key={c.label} style={{padding:"8px 12px",verticalAlign:"middle"}}>{c.render?c.render(r):r[c.key]}</td>)}
            </tr>)}
          </tbody>
        </table>
      )}
    </div>
  );
}

function FieldSelector({selected,onChange}){
  const[search,setSearch]=useState("");const[open,setOpen]=useState(false);
  const filtered=SA_FIELDS.filter(f=>f.toLowerCase().includes(search.toLowerCase()));
  const toggle=f=>onChange(selected.includes(f)?selected.filter(x=>x!==f):[...selected,f]);
  return(
    <div>
      {selected.length>0&&<div style={{display:"flex",flexWrap:"wrap",gap:5,marginBottom:6}}>{selected.map(f=><span key={f} style={{background:"#dbeafe",color:"#1e40af",padding:"2px 8px",borderRadius:99,fontSize:12,fontWeight:600,display:"flex",alignItems:"center",gap:3}}>{f}<button onClick={()=>toggle(f)} style={{background:"none",border:"none",cursor:"pointer",color:"#3b82f6",padding:0,lineHeight:1,fontSize:14}}>×</button></span>)}</div>}
      <div style={{position:"relative"}}>
        <input value={search} onChange={e=>{setSearch(e.target.value);setOpen(true);}} onFocus={()=>setOpen(true)} placeholder="Search engineering fields…" style={IS}/>
        {open&&<div style={{position:"absolute",top:"100%",left:0,right:0,background:"white",border:"1px solid #e2e8f0",borderRadius:10,maxHeight:170,overflow:"auto",zIndex:100,boxShadow:"0 8px 24px rgba(0,0,0,.1)"}}>
          {filtered.map(f=><div key={f} onClick={()=>{toggle(f);setSearch("");}} style={{padding:"7px 11px",cursor:"pointer",display:"flex",alignItems:"center",gap:7,background:selected.includes(f)?"#eff6ff":"white",borderBottom:"1px solid #f8fafc",fontSize:13}}>
            <div style={{width:14,height:14,borderRadius:3,border:`2px solid ${selected.includes(f)?"#3b82f6":"#cbd5e1"}`,background:selected.includes(f)?"#3b82f6":"white",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{selected.includes(f)&&<Ic n="check" size={8} c="white"/>}</div>{f}
          </div>)}
          <div onClick={()=>setOpen(false)} style={{padding:"5px 11px",color:"#94a3b8",fontSize:12,cursor:"pointer",textAlign:"center",borderTop:"1px solid #f1f5f9"}}>Close</div>
        </div>}
      </div>
    </div>
  );
}

function Modal({title,onClose,children,maxW=620}){
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.55)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:"1rem"}}>
      <div style={{background:"white",borderRadius:18,width:"100%",maxWidth:maxW,maxHeight:"90vh",overflow:"auto",boxShadow:"0 25px 60px rgba(0,0,0,.3)"}}>
        <div style={{padding:"1.1rem 1.4rem",borderBottom:"1px solid #f1f5f9",display:"flex",justifyContent:"space-between",alignItems:"center"}}>
          <h2 style={{margin:0,fontSize:15,fontWeight:700}}>{title}</h2>
          <button onClick={onClose} style={{background:"none",border:"none",cursor:"pointer",color:"#94a3b8"}}><Ic n="x" size={19}/></button>
        </div>
        <div style={{padding:"1.4rem"}}>{children}</div>
      </div>
    </div>
  );
}


// ═══════════════════════════════════════════════════════════
// STUDENT FORM MODAL (shared by admin + supervisor)
// ═══════════════════════════════════════════════════════════

function StudentFormModal({db,existing,supervisorId,onClose,showToast}){
  const isNew=!existing;
  const[f,setF]=useState({surname:existing?.surname||"",initials:existing?.initials||"",number:existing?.number||"",institution:existing?.institution||"",level:existing?.level||"BEng",fields:existing?.fields||[],strictness:existing?.strictness||"strict",rubric:existing?.rubric||"",extraPrompt:existing?.extraPrompt||"",password:existing?.password||"",securityQ:existing?.securityQ||null,supervisorId:existing?.supervisorId||supervisorId||null,coSupervisorIds:existing?.coSupervisorIds||[]});
  const knownInstitution=SA_UNIVERSITIES.some(u=>u.name===existing?.institution);
  const[customInst,setCustomInst]=useState(existing?.institution&&!knownInstitution);
  const[sqQ,setSqQ]=useState(existing?.securityQ?.question||SECURITY_QUESTIONS[0]);
  const[sqA,setSqA]=useState("");
  const[err,setErr]=useState("");
  const up=k=>e=>setF(p=>({...p,[k]:e.target.value}));
  const save=()=>{
    setErr("");
    if(!f.surname||!f.initials||!f.number)return setErr("Surname, initials and number required.");
    if(!f.institution)return setErr("Institution is required.");
    if(f.fields.length===0)return setErr("Select at least one field.");
    const dup=db.students.find(s=>s.number===f.number.trim()&&s.id!==existing?.id);
    if(dup)return setErr("Student number already registered.");
    const finalF={...f,securityQ:sqA.trim()?{question:sqQ,answer:sqA.trim().toLowerCase()}:(f.securityQ||null)};
    if(isNew){
      const s={id:"stu_"+uid(),...finalF,surname:f.surname.trim(),initials:f.initials.trim(),number:f.number.trim(),createdAt:new Date().toISOString()};
      db.setStudents(p=>[...p,s]);
    } else {
      db.setStudents(prev=>prev.map(s=>s.id===existing.id?{...s,...finalF,surname:f.surname.trim(),initials:f.initials.trim()}:s));
    }
    showToast(isNew?"Student registered.":"Student updated.");
    onClose();
  };
  return(
    <Modal title={isNew?"Register Student":"Edit Student"} onClose={onClose} maxW={660}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:11}}>
        <div><label style={LS}>Surname *</label><input value={f.surname} onChange={up("surname")} placeholder="Mazambara" style={IS}/></div>
        <div><label style={LS}>Initials *</label><input value={f.initials} onChange={up("initials")} placeholder="DA" style={IS}/></div>
        <div><label style={LS}>Student Number *</label><input value={f.number} onChange={up("number")} placeholder="38045869" disabled={!isNew} style={{...IS,background:!isNew?"#f8fafc":"white"}}/></div>
        <div><label style={LS}>Level *</label><select value={f.level} onChange={up("level")} style={IS}>{LEVELS.map(l=><option key={l}>{l}</option>)}</select></div>
        <div style={{gridColumn:"1 / -1"}}>
          <label style={LS}>Institution *</label>
          {!customInst?(
            <select value={SA_UNIVERSITIES.some(u=>u.name===f.institution)?f.institution:""} onChange={e=>{ if(e.target.value==="__other__"){setCustomInst(true);setF(p=>({...p,institution:""}));} else setF(p=>({...p,institution:e.target.value})); }} style={IS}>
              <option value="" disabled>Select university…</option>
              {SA_UNIVERSITIES.map(u=><option key={u.name} value={u.name}>{u.name}</option>)}
              <option value="__other__">Other / not listed…</option>
            </select>
          ):(
            <div style={{display:"flex",gap:6}}>
              <input value={f.institution} onChange={up("institution")} placeholder="Institution name" style={IS} autoFocus/>
              <button type="button" onClick={()=>{setCustomInst(false);setF(p=>({...p,institution:""}));}} style={{background:"#f1f5f9",border:"none",borderRadius:9,padding:"0 12px",cursor:"pointer",color:"#64748b",fontSize:12,whiteSpace:"nowrap"}}>Choose from list</button>
            </div>
          )}
        </div>
      </div>
      <div style={{marginBottom:11}}>
        <label style={LS}>Assign to Supervisor</label>
        <select value={f.supervisorId||""} onChange={e=>setF(p=>({...p,supervisorId:e.target.value||null}))} style={IS}>
          <option value="">— Unassigned —</option>
          {db.supervisors.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      <div style={{marginBottom:11}}>
        <label style={LS}>Co-Supervisors (optional — select one or more)</label>
        <div style={{display:"flex",flexDirection:"column",gap:5}}>
          {db.supervisors.filter(s=>s.id!==f.supervisorId).map(s=>{
            const checked=(f.coSupervisorIds||[]).includes(s.id);
            return(
              <div key={s.id} onClick={()=>setF(p=>({...p,coSupervisorIds:checked?p.coSupervisorIds.filter(x=>x!==s.id):[...(p.coSupervisorIds||[]),s.id]}))} style={{display:"flex",alignItems:"center",gap:9,padding:"7px 10px",borderRadius:8,border:`1.5px solid ${checked?"#3b82f6":"#e2e8f0"}`,cursor:"pointer",background:checked?"#eff6ff":"white"}}>
                <div style={{width:16,height:16,borderRadius:4,border:`2px solid ${checked?"#3b82f6":"#cbd5e1"}`,background:checked?"#3b82f6":"white",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}>{checked&&<Ic n="check" size={9} c="white"/>}</div>
                <span style={{fontSize:13,fontWeight:checked?600:400}}>{s.name}</span>
              </div>
            );
          })}
          {db.supervisors.filter(s=>s.id!==f.supervisorId).length===0&&<div style={{fontSize:13,color:"#94a3b8"}}>No other supervisors registered.</div>}
        </div>
      </div>
      <div style={{marginBottom:11}}>
        <label style={LS}>Engineering Field(s) *</label>
        <FieldSelector selected={f.fields} onChange={fields=>setF(p=>({...p,fields}))}/>
      </div>
      <div style={{marginBottom:11}}>
        <label style={LS}>Analysis Strictness</label>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:7}}>
          {STRICTNESS.map(s=><div key={s.id} onClick={()=>setF(p=>({...p,strictness:s.id}))} style={{border:`2px solid ${f.strictness===s.id?s.color:"#e2e8f0"}`,borderRadius:9,padding:"8px 10px",cursor:"pointer",background:f.strictness===s.id?s.color+"11":"white"}}>
            <div style={{fontWeight:700,fontSize:13,color:f.strictness===s.id?s.color:"#374151"}}>{s.label}</div>
            <div style={{fontSize:11,color:"#64748b",marginTop:1}}>{s.desc}</div>
          </div>)}
        </div>
      </div>
      <div style={{marginBottom:10}}>
        <label style={LS}>{isNew?"Initial Password (optional — student sets on first login)":"Reset Password (leave blank to keep)"}</label>
        <PwdInput value={f.password} onChange={up("password")} placeholder={isNew?"Student sets on first login":"Leave blank to keep"}/>
      </div>
      <div style={{background:"#f8fafc",borderRadius:9,padding:"10px 12px",marginBottom:10}}>
        <label style={LS}>Security Question for Password Reset</label>
        {f.securityQ&&<div style={{fontSize:12,color:"#64748b",marginBottom:5}}>Current: <em>{f.securityQ.question}</em></div>}
        <select value={sqQ} onChange={e=>setSqQ(e.target.value)} style={{...IS,marginBottom:6}}>{SECURITY_QUESTIONS.map(q=><option key={q}>{q}</option>)}</select>
        <label style={LS}>Answer {f.securityQ?"(leave blank to keep)":"*"}</label>
        <input value={sqA} onChange={e=>setSqA(e.target.value)} placeholder="Case-insensitive" style={IS}/>
      </div>
      <div style={{marginBottom:9}}>
        <label style={LS}>Assessment Rubric (optional)</label>
        <textarea value={f.rubric} onChange={up("rubric")} rows={3} placeholder="Paste rubric or marking criteria…" style={{...IS,resize:"vertical",fontFamily:"inherit"}}/>
      </div>
      <div style={{marginBottom:13}}>
        <label style={LS}>Supervisor Notes / Analysis Instructions (optional)</label>
        <textarea value={f.extraPrompt} onChange={up("extraPrompt")} rows={2} placeholder="e.g. Focus on ECSA GA04…" style={{...IS,resize:"vertical",fontFamily:"inherit"}}/>
      </div>
      <Err msg={err}/>
      <div style={{display:"flex",gap:8,marginTop:12}}><button onClick={save} style={BP}>{isNew?"Register":"Save"} Student</button><button onClick={onClose} style={BS}>Cancel</button></div>
    </Modal>
  );
}


// ═══════════════════════════════════════════════════════════════════════
// PDF TEXT EXTRACTION via PDF.js CDN
// ═══════════════════════════════════════════════════════════════════════

async function extractPdfText(file) {
  // Dynamically load PDF.js from CDN
  if (!window.pdfjsLib) {
    await new Promise((resolve, reject) => {
      const script = document.createElement("script");
      script.src = "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js";
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
    window.pdfjsLib.GlobalWorkerOptions.workerSrc =
      "https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js";
  }
  const buf = await file.arrayBuffer();
  const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
  const maxPages = Math.min(pdf.numPages, 40); // limit to 40 pages
  let text = "";
  for (let i = 1; i <= maxPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    text += content.items.map(item => item.str).join(" ") + "\n";
  }
  return text;
}

// ═══════════════════════════════════════════════════════════════════════
// PRINTABLE REPORT — builds a standalone HTML document and opens the
// browser's native print dialog (so the person picks "Save as PDF").
// This uses the browser's own text engine for layout/pagination, which
// sidesteps every class of bug we hit with programmatic PDF generation:
// no font-encoding issues, no manual width math, no rasterization/
// contrast problems, crisp text at any zoom level.
// ═══════════════════════════════════════════════════════════════════════

const esc = s => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");

// Light, print-safe colour palette for priority levels — matches the visual
// language of the reference reports (colour-coded left border + light tint,
// never a dark solid fill, since that reads poorly on paper/PDF).
const PRINT_PRIORITY = {
  Critical:  {bg:"#fef2f2", border:"#dc2626", text:"#7f1d1d"},
  Serious:   {bg:"#fff7ed", border:"#ea580c", text:"#9a3412"},
  Important: {bg:"#fffbeb", border:"#d97706", text:"#78350f"},
  Minor:     {bg:"#eff6ff", border:"#3b82f6", text:"#1e3a8a"},
};
const printPriorityColor = p => PRINT_PRIORITY[p] || {bg:"#f8fafc", border:"#94a3b8", text:"#334155"};

function printListBlock(title, items, color, bg, border, mark) {
  if (!items || !items.length) return "";
  return `<div class="card" style="margin-bottom:16px;">
    <div class="eyebrow" style="color:${color};">${esc(title)}</div>
    ${items.map(it => `<div class="row" style="background:${bg};border-left:4px solid ${border};color:${color};">${mark ? `<strong>${mark}</strong> ` : ""}${esc(it)}</div>`).join("")}
  </div>`;
}

function printSectionsBlock(sections) {
  if (!sections || !sections.length) return "";
  return `<h2 class="h2">Section-by-Section Breakdown</h2>
    ${sections.map(s => {
      const c = sc(s.score);
      return `<div class="card section-card">
        <div class="section-head">
          <span class="section-name">${esc(s.name)} <span class="muted">(Grade: ${esc(s.grade || "—")})</span></span>
          <span class="score-num" style="color:${c};">${s.score}/100</span>
        </div>
        <div class="bar"><div class="bar-fill" style="width:${Math.max(0, Math.min(100, s.score))}%;background:${c};"></div></div>
        ${printListBlock("Strengths", s.strengths, "#166534", "#f0fdf4", "#16a34a", "+")}
        ${printListBlock("Weaknesses", s.weaknesses, "#7f1d1d", "#fef2f2", "#dc2626", "–")}
        ${s.supervisorInstruction ? `<div class="row instruction"><strong>Instruction:</strong> ${esc(s.supervisorInstruction)}</div>` : ""}
      </div>`;
    }).join("")}`;
}

function printPriorityBlock(actions) {
  if (!actions || !actions.length) return "";
  return `<h2 class="h2">Priority Actions</h2>
    <div class="card">
      ${actions.map(a => { const c = printPriorityColor(a.priority); return `<div class="row" style="background:${c.bg};border-left:4px solid ${c.border};color:${c.text};"><strong>[${esc(a.priority)}]</strong> ${esc(a.action)}</div>`; }).join("")}
    </div>`;
}

function printParaBlock(title, text) {
  if (!text) return "";
  return `<h3 class="h3">${esc(title)}</h3><p class="para">${esc(text)}</p>`;
}

function printScoreLine(label, score, comment) {
  const c = sc(score);
  return `<div class="score-line">
    <div class="section-head" style="margin-bottom:4px;">
      <span class="muted-strong">${esc(label)}</span>
      <span class="score-num" style="font-size:13px;color:${c};">${score}/100</span>
    </div>
    <div class="bar" style="height:4px;"><div class="bar-fill" style="width:${Math.max(0, Math.min(100, score))}%;background:${c};"></div></div>
    ${comment ? `<p class="para small" style="margin-top:5px;">${esc(comment)}</p>` : ""}
  </div>`;
}

function printHeaderHTML(title, subtitle, submission, student, branding) {
  const badges = [];
  if (docTypeBadgeLabel(submission)) badges.push(esc(docTypeBadgeLabel(submission)));
  if (submission.chunked) badges.push(`Full document · ${submission.chunksUsed} sections`);
  if (submission.chunksFailed > 0) badges.push(`⚠ ${submission.chunksFailed} section(s) unreadable`);
  const instMark = student.institution ? (
    branding?.logoUrl
      ? `<img src="${esc(branding.logoUrl)}" alt="" style="height:34px;max-width:110px;object-fit:contain;background:white;border-radius:6px;padding:3px;"/>`
      : `<div style="width:34px;height:34px;border-radius:8px;background:${branding?.color || "#334155"};color:white;display:flex;align-items:center;justify-content:center;font-weight:800;font-size:11px;flex-shrink:0;">${esc((student.institution.match(/\b[A-Z]/g) || []).join("").slice(0, 4) || student.institution.slice(0,3).toUpperCase())}</div>`
  ) : "";
  return `<div class="header">
    <div style="display:flex;justify-content:space-between;align-items:flex-start;gap:14px;">
      <div>
        <h1>${esc(title)}</h1>
        <div class="header-sub">${esc(subtitle)}</div>
      </div>
      ${instMark ? `<div style="text-align:right;flex-shrink:0;">${instMark}<div style="font-size:9.5px;color:rgba(255,255,255,.6);margin-top:4px;max-width:120px;">${esc(student.institution)}</div></div>` : ""}
    </div>
    <div class="header-grid">
      <div><span class="hlabel">Student</span><br/>${esc(student.initials || "")} ${esc(student.surname || "")}</div>
      <div><span class="hlabel">Student No.</span><br/>${esc(student.number || "")}</div>
      <div><span class="hlabel">Level</span><br/>${esc(student.level || "")}</div>
      <div><span class="hlabel">Document</span><br/>${esc(submission.filename || "Document")}</div>
    </div>
    <div class="header-sub" style="margin-top:8px;">Submitted ${esc(new Date(submission.date).toLocaleDateString("en-ZA"))}${submission.submittedBy ? " · Submitted by " + esc(submission.submittedBy) : ""}${badges.length ? " · " + badges.join(" · ") : ""}</div>
  </div>`;
}

function buildStandardReportSection(submission, student, branding) {
  const r = submission.result;
  if (!r) return "";
  return `${printHeaderHTML("Assessment Report", "AcademiQ Analyser — Supervisor Assessment", submission, student, branding)}
    <div class="badges">
      <span class="badge" style="background:${sb(r.overallScore)};color:${sc(r.overallScore)};">${r.overallScore}% · ${esc(r.overallGrade)}</span>
      <span class="badge" style="background:${dc2(r.supervisorDecision)}22;color:${dc2(r.supervisorDecision)};">${esc(r.supervisorDecision)}</span>
    </div>
    ${r.overallVerdict ? `<p class="verdict">${esc(r.overallVerdict)}</p>` : ""}
    ${printListBlock("Strengths", r.positives, "#14532d", "#f0fdf4", "#16a34a", "+")}
    ${printListBlock("Critical Issues", r.criticalIssues, "#7f1d1d", "#fef2f2", "#dc2626", "–")}
    ${printSectionsBlock(r.sections)}
    ${printPriorityBlock(r.priorityActions)}
    ${printParaBlock("Disciplinary Assessment", r.disciplinaryAssessment)}
    ${printParaBlock("ECSA Graduate Attributes", r.ecsa_ga_notes)}`;
}

function buildExtendedReportSection(submission, student, branding) {
  const x = submission.extendedResult;
  if (!x) return "";
  let html = `<div class="page-break"></div>${printHeaderHTML("Extended Editorial Review", "AcademiQ Analyser — Language, Literature, Citations, AI Detection & Flow", submission, student, branding)}`;

  if (x.languageReview) {
    const l = x.languageReview;
    html += `<h2 class="h2">Language &amp; Grammar</h2>`;
    html += printScoreLine("Overall Language Score", l.overallLanguageScore, null);
    html += printScoreLine("Readability", l.readabilityScore, l.readabilityComment);
    if (l.spellingErrors?.length) html += printListBlock("Spelling Errors", l.spellingErrors.map(e => `${e.original} → ${e.correction}${e.context ? `  ("${e.context}")` : ""}`), "#7f1d1d", "#fef2f2", "#dc2626", null);
    if (l.grammarErrors?.length) html += printListBlock("Grammar Issues", l.grammarErrors.map(e => `${e.issue}${e.location ? `  ("${e.location}")` : ""}${e.suggestion ? "  → " + e.suggestion : ""}`), "#78350f", "#fffbeb", "#d97706", null);
    if (l.styleIssues?.length) html += printListBlock("Style Issues", l.styleIssues.map(e => `${e.type}${e.location ? `  ("${e.location}")` : ""}${e.suggestion ? "  → " + e.suggestion : ""}`), "#1e3a8a", "#eff6ff", "#3b82f6", null);
  }

  if (x.literatureReview) {
    const lr = x.literatureReview;
    html += `<h2 class="h2">Literature Review</h2>`;
    html += printScoreLine("Funnel Approach", lr.funnelApproachScore, lr.funnelApproachComment);
    html += printScoreLine("Relevance", lr.relevanceScore, lr.relevanceComment);
    html += printScoreLine("Critical Analysis", lr.criticalAnalysisScore, lr.criticalAnalysisComment);
    html += printScoreLine("Flow", lr.flowScore, lr.flowComment);
    if (lr.gaps?.length) html += printListBlock("Gaps Identified", lr.gaps, "#7f1d1d", "#fef2f2", "#dc2626", null);
    if (lr.strengths?.length) html += printListBlock("Strengths", lr.strengths, "#14532d", "#f0fdf4", "#16a34a", null);
  }

  if (x.citationReview) {
    const c = x.citationReview;
    html += `<h2 class="h2">Citations &amp; References</h2>`;
    html += printScoreLine("Citation Score", c.overallCitationScore, c.citationIssuesSummary);
    if (c.inTextCitations?.length) html += printListBlock("In-Text Citations", c.inTextCitations.map(ci => `${ci.citation}${ci.isCorrect ? " (correct)" : `  Issue: ${ci.issue || ""}${ci.correction ? "  → " + ci.correction : ""}`}`), "#334155", "#f8fafc", "#94a3b8", null);
    if (c.referenceList?.length) html += printListBlock("Reference List", c.referenceList.map(rf => `${rf.fullReference}${rf.isCorrect ? "" : `  Issue: ${rf.issue || ""}${rf.correction ? "  → " + rf.correction : ""}`}`), "#334155", "#f8fafc", "#94a3b8", null);
    if (c.missingReferences?.length) html += printListBlock("Cited but not in Reference List", c.missingReferences, "#7f1d1d", "#fef2f2", "#dc2626", null);
    if (c.orphanedReferences?.length) html += printListBlock("In Reference List but not Cited", c.orphanedReferences, "#78350f", "#fffbeb", "#d97706", null);
  }

  if (x.aiDetection) {
    const a = x.aiDetection;
    html += `<h2 class="h2">AI Detection</h2>`;
    html += printScoreLine("Estimated AI Content", a.estimatedAiPercentage, a.aiComment);
    if (a.aiSections?.length) html += printListBlock("Suspected AI-Generated Sections", a.aiSections.map(s => `${s.section} — ${s.likelihood} likelihood${s.excerpt ? `  ("${s.excerpt}…")` : ""}`), "#7f1d1d", "#fef2f2", "#dc2626", null);
    if (a.humanSections?.length) html += printListBlock("Human-Written Sections", a.humanSections, "#14532d", "#f0fdf4", "#16a34a", null);
  }

  if (x.informationFlow) {
    const f = x.informationFlow;
    html += `<h2 class="h2">Information Flow</h2>`;
    html += printScoreLine("Overall Flow", f.overallFlowScore, f.logicalProgressionComment);
    if (f.sectionFlow?.length) html += printListBlock("Section-by-Section Flow", f.sectionFlow.map(s => `${s.section} — ${s.flowScore}/100: ${s.comment}${s.issue ? "  Issue: " + s.issue : ""}`), "#334155", "#f8fafc", "#94a3b8", null);
    if (f.recommendations?.length) html += printListBlock("Recommendations", f.recommendations, "#1e40af", "#eff6ff", "#3b82f6", null);
  }

  html += printParaBlock("Editorial Summary", x.editorialSummary);
  if (x.priorityCorrections?.length) html += printListBlock("Priority Corrections", x.priorityCorrections.map(c => `[${c.priority}/${c.type}] ${c.action}`), "#334155", "#f8fafc", "#94a3b8", null);

  return html;
}

function buildPrintDocument(submission, student, branding) {
  const stu = student || {};
  const title = `${stu.surname || "Report"} — AcademiQ Assessment`;
  const body = buildStandardReportSection(submission, stu, branding) + (submission.extendedResult ? buildExtendedReportSection(submission, stu, branding) : "");
  return `<!DOCTYPE html>
<html>
<head>
<meta charset="utf-8"/>
<title>${esc(title)}</title>
<style>
  @page { size: A4; margin: 16mm 14mm; }
  * { box-sizing: border-box; }
  body { font-family: -apple-system, 'Segoe UI', Helvetica, Arial, sans-serif; color: #0f172a; margin: 0; padding: 0; font-size: 12.5px; line-height: 1.55; }
  .toolbar { position: sticky; top: 0; background: #1e293b; color: white; padding: 10px 16px; display: flex; justify-content: space-between; align-items: center; font-size: 13px; z-index: 10; }
  .toolbar button { background: #3b82f6; color: white; border: none; border-radius: 6px; padding: 8px 16px; font-size: 13px; font-weight: 600; cursor: pointer; }
  @media print { .toolbar { display: none; } }
  .content { max-width: 800px; margin: 0 auto; padding: 20px 24px 40px; }
  .header { background: linear-gradient(135deg,#1e293b,#334155); color: white; padding: 22px 26px; border-radius: 10px; margin-bottom: 18px; break-inside: avoid; }
  .header h1 { margin: 0 0 4px; font-size: 20px; font-weight: 800; }
  .header-sub { font-size: 11.5px; color: rgba(255,255,255,.75); }
  .header-grid { display: grid; grid-template-columns: repeat(4,1fr); gap: 10px; margin-top: 14px; font-size: 12px; }
  .hlabel { font-size: 9.5px; font-weight: 700; text-transform: uppercase; letter-spacing: .05em; color: rgba(255,255,255,.55); }
  .badges { display: flex; gap: 8px; margin: 0 0 16px; flex-wrap: wrap; }
  .badge { padding: 4px 12px; border-radius: 99px; font-size: 11.5px; font-weight: 700; }
  .verdict { background: #f0f9ff; color: #0c4a6e; border-radius: 8px; padding: 12px 15px; margin: 0 0 18px; font-size: 12.5px; }
  .card { break-inside: avoid; margin-bottom: 16px; }
  .section-card { background: #fafbfc; border: 1px solid #f1f5f9; border-radius: 10px; padding: 14px 16px; margin-bottom: 16px; break-inside: avoid; }
  .eyebrow { font-size: 11px; font-weight: 800; text-transform: uppercase; letter-spacing: .04em; margin-bottom: 7px; }
  .row { border-radius: 6px; padding: 8px 12px; margin-bottom: 6px; font-size: 12px; break-inside: avoid; }
  .instruction { background: #fffbeb; border-left: 4px solid #d97706; color: #78350f; }
  .section-head { display: flex; justify-content: space-between; align-items: baseline; margin-bottom: 6px; }
  .section-name { font-weight: 700; font-size: 13px; }
  .muted { font-weight: 500; color: #64748b; }
  .muted-strong { font-weight: 700; font-size: 12px; color: #374151; }
  .score-num { font-weight: 800; font-size: 13px; }
  .bar { height: 5px; background: #e2e8f0; border-radius: 3px; margin-bottom: 10px; overflow: hidden; }
  .bar-fill { height: 100%; }
  .score-line { margin-bottom: 12px; break-inside: avoid; }
  .h2 { font-size: 15px; font-weight: 800; margin: 22px 0 12px; border-top: 1px solid #e2e8f0; padding-top: 18px; break-after: avoid; }
  .h3 { font-size: 13px; font-weight: 800; margin: 18px 0 8px; break-after: avoid; }
  .para { font-size: 12.5px; line-height: 1.65; color: #334155; margin: 0 0 14px; }
  .para.small { font-size: 11.5px; color: #64748b; margin: 0; }
  .page-break { break-before: page; page-break-before: always; }
  .footer-note { text-align: center; font-size: 10px; color: #94a3b8; margin-top: 30px; }
</style>
</head>
<body>
  <div class="toolbar no-print">
    <span>Use your browser's print dialog and choose "Save as PDF" to download this report.</span>
    <button onclick="window.print()">Print / Save as PDF</button>
  </div>
  <div class="content">
    ${body}
    <div class="footer-note">AcademiQ Analyser — Generated report, for supervisory use</div>
  </div>
</body>
</html>`;
}

function printReport(submission, student, db) {
  const branding = student?.institution ? getInstitutionBranding(db, student.institution) : null;
  const html = buildPrintDocument(submission, student, branding);
  const win = window.open("", "_blank", "width=900,height=1000");
  if (!win) { alert("Your browser blocked the print window. Please allow pop-ups for this site and try again."); return; }
  win.document.open();
  win.document.write(html);
  win.document.close();
  const doPrint = () => { try { win.focus(); win.print(); } catch (e) {} };
  win.onload = doPrint;
  setTimeout(doPrint, 500);
}

// Shared print/download button — used everywhere a PDF report can be generated.
function PdfDownloadButton({submission,student,db,variant="icon"}){
  const run=()=>printReport(submission,student,db);
  if(variant==="header")return(
    <button onClick={run} title="Print / Save as PDF" style={{background:"rgba(255,255,255,.1)",border:"none",borderRadius:7,padding:"0 10px",height:28,cursor:"pointer",display:"flex",alignItems:"center",gap:5,color:"white",fontSize:11,fontWeight:600}}>
      <Ic n="download" size={13} c="white"/> PDF
    </button>
  );
  return(
    <button onClick={run} title="Print / Save as PDF" style={{background:"none",border:"none",cursor:"pointer",color:"#64748b"}}>
      <Ic n="download" size={14}/>
    </button>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// CITATION STYLES
// ═══════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════
// SOUTH AFRICAN UNIVERSITIES + INSTITUTION BRANDING
// ═══════════════════════════════════════════════════════════════════════

// All 26 accredited public universities in South Africa (DHET-recognised).
// Names/abbreviations only — factual data, not trademarked creative content.
const SA_UNIVERSITIES = [
  {name:"University of Cape Town", abbr:"UCT"},
  {name:"Stellenbosch University", abbr:"SU"},
  {name:"University of the Western Cape", abbr:"UWC"},
  {name:"University of Pretoria", abbr:"UP"},
  {name:"University of the Witwatersrand", abbr:"Wits"},
  {name:"Rhodes University", abbr:"RU"},
  {name:"University of the Free State", abbr:"UFS"},
  {name:"University of KwaZulu-Natal", abbr:"UKZN"},
  {name:"North-West University", abbr:"NWU"},
  {name:"University of Fort Hare", abbr:"UFH"},
  {name:"University of Limpopo", abbr:"UL"},
  {name:"University of Johannesburg", abbr:"UJ"},
  {name:"Nelson Mandela University", abbr:"NMU"},
  {name:"University of South Africa", abbr:"UNISA"},
  {name:"University of Venda", abbr:"UNIVEN"},
  {name:"University of Zululand", abbr:"UNIZULU"},
  {name:"Walter Sisulu University", abbr:"WSU"},
  {name:"Cape Peninsula University of Technology", abbr:"CPUT"},
  {name:"Central University of Technology", abbr:"CUT"},
  {name:"Durban University of Technology", abbr:"DUT"},
  {name:"Mangosuthu University of Technology", abbr:"MUT"},
  {name:"Tshwane University of Technology", abbr:"TUT"},
  {name:"Vaal University of Technology", abbr:"VUT"},
  {name:"Sol Plaatje University", abbr:"SPU"},
  {name:"University of Mpumalanga", abbr:"UMP"},
  {name:"Sefako Makgatho Health Sciences University", abbr:"SMU"},
];

// Deterministic fallback colour for an institution with no configured branding —
// gives visual variety without claiming to be anyone's "official" colour.
const FALLBACK_PALETTE = ["#1e3a8a","#7c2d12","#14532d","#581c87","#0c4a6e","#78350f","#831843","#164e63"];
function fallbackInstitutionColor(name) {
  let hash = 0;
  for (let i = 0; i < (name || "").length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return FALLBACK_PALETTE[hash % FALLBACK_PALETTE.length];
}
// Looks up admin-configured branding for an institution, falling back to a
// deterministic colour + no logo if the admin hasn't set anything up for it.
function getInstitutionBranding(db, institutionName) {
  const cfg = db?.institutionBranding?.find(b => b.id === institutionName);
  return { color: cfg?.color || fallbackInstitutionColor(institutionName || ""), logoUrl: cfg?.logoUrl || "" };
}

const CITATION_STYLES = [
  {id:"apa",    label:"APA 7th Edition"},
  {id:"ieee",   label:"IEEE"},
  {id:"harvard",label:"Harvard"},
  {id:"mla",    label:"MLA 9th Edition"},
  {id:"chicago",label:"Chicago 17th Edition"},
  {id:"vancouver",label:"Vancouver"},
];

// ═══════════════════════════════════════════════════════════════════════
// DOCUMENT TYPE / CHAPTER SELECTION
// ═══════════════════════════════════════════════════════════════════════

const DOCUMENT_TYPES = [
  {id:"full",     label:"Full Thesis"},
  {id:"proposal", label:"Research Proposal"},
  {id:"wip",      label:"Work in Progress"},
];

const CHAPTER_OPTIONS = ["Introduction","Literature Review","Methodology / Research Design","Results","Discussion","Conclusion & Recommendations","References","Appendices"];

// Builds the extra prompt instruction block that calibrates the AI's assessment
// to the selected document type — reuses the existing report schema entirely,
// so no changes are needed anywhere else in the app (rendering, PDF, etc.).
function buildDocContextInstruction(docContext) {
  if (!docContext) return "";
  const { documentType = "full", chapters = [], chapterByChapter = false } = docContext;
  if (documentType === "proposal") {
    return `\nASSESSMENT CONTEXT — RESEARCH PROPOSAL: This document is a RESEARCH PROPOSAL, not a completed thesis or in-progress report. Assess it against research-proposal expectations only: clarity of the problem statement and motivation, feasibility of the proposed approach, adequacy of the preliminary/planned literature review, methodological soundness of the PLANNED approach (it has not been executed yet, so judge the plan itself, not results), the research plan/timeline, risk identification, and ethical considerations. Do NOT penalise the student for the absence of Results, Discussion, or Conclusion chapters — a proposal by definition does not contain these; do not list their absence as a critical issue or weakness. Frame "supervisorDecision" as approval to proceed with the proposed research, not as a final-thesis verdict.\n`;
  }
  if (documentType === "wip") {
    const list = chapters.length ? chapters.join(", ") : "only the chapters actually present in the submitted text";
    return `\nASSESSMENT CONTEXT — WORK IN PROGRESS: This is a WORK-IN-PROGRESS submission. The supervisor has indicated that ONLY the following chapters/sections are ready for review at this stage: ${list}. Base your "sections" array and overall assessment ONLY on these chapters. Do NOT penalise the student for the absence of later chapters that are not yet due (e.g. Results, Discussion, Conclusion) if they fall outside this list — treat those simply as "not yet submitted", not as a deficiency, and do not list their absence as a critical issue. The overallScore and supervisorDecision should reflect the quality of the SUBMITTED chapters only, not the completeness of the thesis as a whole.\n`;
  }
  if (chapterByChapter) {
    return `\nASSESSMENT CONTEXT — CHAPTER-BY-CHAPTER: This is a full thesis/research report. Structure the "sections" array to follow the ACTUAL chapter structure of this specific document (e.g. "Chapter 1: Introduction", "Chapter 2: Literature Review", using the real chapter numbers/titles from the document itself where possible) rather than generic evaluation categories. Produce one entry per chapter, each thoroughly assessed with its own score, strengths, weaknesses and supervisor instruction.\n`;
  }
  return "";
}

// Shared UI for picking document type (+ chapters when relevant). Used by both the
// supervisor/admin/co-supervisor submit modal and the student's own submit form.
function DocTypeSelector({docType,setDocType,chapters,setChapters,chapterByChapter,setChapterByChapter,customChapters,setCustomChapters}) {
  return (
    <div style={{marginBottom:12}}>
      <label style={LS}>Analysis Type</label>
      <div style={{display:"flex",gap:6,marginBottom:docType!=="full"||chapterByChapter!==undefined?8:0}}>
        {DOCUMENT_TYPES.map(t=>(
          <button key={t.id} type="button" onClick={()=>setDocType(t.id)} style={{flex:1,padding:"7px 8px",borderRadius:8,border:docType===t.id?"2px solid #3b82f6":"1px solid #e2e8f0",background:docType===t.id?"#eff6ff":"white",color:docType===t.id?"#1e40af":"#64748b",fontWeight:600,fontSize:11.5,cursor:"pointer"}}>{t.label}</button>
        ))}
      </div>
      {docType==="wip"&&(
        <div style={{marginTop:8,marginBottom:4}}>
          <label style={{...LS,fontSize:10.5}}>Which chapters are ready for review? (select at least one)</label>
          <div style={{display:"flex",flexWrap:"wrap",gap:6,marginTop:6}}>
            {CHAPTER_OPTIONS.map(ch=>(
              <button key={ch} type="button" onClick={()=>setChapters(prev=>prev.includes(ch)?prev.filter(c=>c!==ch):[...prev,ch])} style={{padding:"5px 10px",borderRadius:99,border:chapters.includes(ch)?"1.5px solid #16a34a":"1px solid #e2e8f0",background:chapters.includes(ch)?"#f0fdf4":"white",color:chapters.includes(ch)?"#16a34a":"#64748b",fontSize:11,fontWeight:600,cursor:"pointer"}}>{ch}</button>
            ))}
          </div>
          <input value={customChapters} onChange={e=>setCustomChapters(e.target.value)} placeholder="Other chapters (comma-separated)…" style={{...IS,marginTop:8,fontSize:12,padding:"7px 10px"}}/>
        </div>
      )}
      {docType==="full"&&(
        <label style={{display:"flex",alignItems:"center",gap:7,fontSize:12,color:"#374151",cursor:"pointer",marginTop:4}}>
          <input type="checkbox" checked={chapterByChapter} onChange={e=>setChapterByChapter(e.target.checked)}/>
          Break down analysis chapter-by-chapter (matches the document's actual chapter structure)
        </label>
      )}
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// EXTENDED FEEDBACK MODAL
// ═══════════════════════════════════════════════════════════════════════

function ExtendedFeedbackModal({submission,students,db,onClose}){
  const[tab,setTab]=useState("language");
  const r=submission.extendedResult;
  const st=students.find(s=>s.id===submission.studentId)||{};
  if(!r)return null;

  const tabs=[
    {id:"language",  label:"Language & Grammar"},
    {id:"litreview", label:"Literature Review"},
    {id:"citations", label:"Citations & References"},
    {id:"ai",        label:"AI Detection"},
    {id:"flow",      label:"Information Flow"},
    {id:"summary",   label:"Summary"},
  ];

  const ScoreBadge=({score,size=22})=>(
    <span style={{fontSize:size,fontWeight:900,color:sc(score)}}>{score}<span style={{fontSize:size*0.5,color:"#94a3b8"}}>/100</span></span>
  );

  const buildScholarUrl=(query)=>`https://scholar.google.com/scholar?q=${encodeURIComponent(query)}`;

  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.65)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1100,padding:"1rem"}}>
      <div style={{background:"white",borderRadius:20,width:"100%",maxWidth:860,maxHeight:"93vh",overflow:"auto",boxShadow:"0 30px 80px rgba(0,0,0,.4)",display:"flex",flexDirection:"column"}}>
        {/* Header */}
        <div style={{background:"linear-gradient(135deg,#1e1b4b,#312e81)",padding:"1.25rem 1.5rem",borderRadius:"20px 20px 0 0",display:"flex",alignItems:"flex-start",justifyContent:"space-between"}}>
          <div>
            <div style={{color:"rgba(255,255,255,.5)",fontSize:12,marginBottom:3}}>Extended Editorial Review · {st.initials} {st.surname}</div>
            <h2 style={{color:"white",fontSize:16,fontWeight:700,margin:0}}>{submission.filename}</h2>
            <div style={{display:"flex",gap:7,marginTop:8,flexWrap:"wrap"}}>
              <span style={{background:"rgba(255,255,255,.15)",color:"white",padding:"3px 10px",borderRadius:99,fontSize:12,fontWeight:600}}>Citation: {r.citationReview?.declaredStyle}</span>
              <span style={{background:sc(r.aiDetection?.estimatedAiPercentage>50?30:70)+"30",color:r.aiDetection?.estimatedAiPercentage>50?"#fca5a5":"#86efac",padding:"3px 10px",borderRadius:99,fontSize:12,fontWeight:600}}>AI Usage: ~{r.aiDetection?.estimatedAiPercentage}%</span>
              <span style={{background:"rgba(255,255,255,.1)",color:"rgba(255,255,255,.8)",padding:"3px 10px",borderRadius:99,fontSize:12}}>Language: {r.languageReview?.overallLanguageScore}/100</span>
              {docTypeBadgeLabel(submission)&&<span style={{background:"rgba(255,255,255,.15)",color:"white",padding:"3px 10px",borderRadius:99,fontSize:12,fontWeight:600}}>{docTypeBadgeLabel(submission)}</span>}
              {submission.chunked&&<span style={{background:"rgba(255,255,255,.15)",color:"white",padding:"3px 10px",borderRadius:99,fontSize:12,fontWeight:600}}>Full document · {submission.chunksUsed} sections</span>}
              {submission.chunksFailed>0&&<span style={{background:"#dc2626",color:"white",padding:"3px 10px",borderRadius:99,fontSize:12,fontWeight:600}}>⚠ {submission.chunksFailed} section{submission.chunksFailed>1?"s":""} unreadable</span>}
            </div>
          </div>
          <div style={{display:"flex",gap:6,flexShrink:0}}>
            <PdfDownloadButton submission={submission} student={st} db={db} variant="header"/>
            <button onClick={onClose} style={{background:"rgba(255,255,255,.1)",border:"none",borderRadius:7,width:28,height:28,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><Ic n="x" size={14} c="white"/></button>
          </div>
        </div>

        {/* Tabs */}
        <div style={{padding:"0 1.4rem",background:"#f8fafc",borderBottom:"1px solid #e2e8f0",display:"flex",overflowX:"auto"}}>
          {tabs.map(t=><button key={t.id} onClick={()=>setTab(t.id)} style={{padding:"10px 13px",border:"none",background:"none",cursor:"pointer",fontWeight:tab===t.id?700:400,color:tab===t.id?"#1e1b4b":"#94a3b8",borderBottom:`2px solid ${tab===t.id?"#4f46e5":"transparent"}`,fontSize:12,whiteSpace:"nowrap"}}>{t.label}</button>)}
        </div>

        <div style={{padding:"1.4rem",overflow:"auto",flex:1}}>

          {/* ── LANGUAGE ── */}
          {tab==="language"&&r.languageReview&&(
            <>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:12,marginBottom:16}}>
                <div style={{background:"#f8fafc",borderRadius:11,padding:"1rem",textAlign:"center"}}>
                  <div style={{fontSize:11,color:"#64748b",fontWeight:600,marginBottom:4}}>LANGUAGE SCORE</div>
                  <ScoreBadge score={r.languageReview.overallLanguageScore}/>
                </div>
                <div style={{background:"#f8fafc",borderRadius:11,padding:"1rem",textAlign:"center"}}>
                  <div style={{fontSize:11,color:"#64748b",fontWeight:600,marginBottom:4}}>READABILITY</div>
                  <ScoreBadge score={r.languageReview.readabilityScore}/>
                  <div style={{fontSize:12,color:"#64748b",marginTop:4}}>{r.languageReview.readabilityComment}</div>
                </div>
              </div>
              {r.languageReview.spellingErrors?.length>0&&(
                <div style={{marginBottom:14}}>
                  <h3 style={{fontSize:13,fontWeight:700,color:"#dc2626",margin:"0 0 8px"}}>Spelling Errors ({r.languageReview.spellingErrors.length})</h3>
                  <div style={{display:"flex",flexDirection:"column",gap:5}}>
                    {r.languageReview.spellingErrors.map((e,i)=>(
                      <div key={i} style={{background:"#fee2e2",borderRadius:8,padding:"8px 11px",fontSize:13}}>
                        <span style={{textDecoration:"line-through",color:"#991b1b",fontWeight:600}}>{e.original}</span>
                        <span style={{color:"#64748b",margin:"0 6px"}}>→</span>
                        <span style={{color:"#14532d",fontWeight:600}}>{e.correction}</span>
                        {e.context&&<div style={{fontSize:11,color:"#64748b",marginTop:3,fontStyle:"italic"}}>"{e.context}"</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {r.languageReview.grammarErrors?.length>0&&(
                <div style={{marginBottom:14}}>
                  <h3 style={{fontSize:13,fontWeight:700,color:"#d97706",margin:"0 0 8px"}}>Grammar Issues ({r.languageReview.grammarErrors.length})</h3>
                  <div style={{display:"flex",flexDirection:"column",gap:5}}>
                    {r.languageReview.grammarErrors.map((e,i)=>(
                      <div key={i} style={{background:"#fffbeb",borderRadius:8,padding:"8px 11px",fontSize:13}}>
                        <div style={{fontWeight:600,color:"#78350f",marginBottom:3}}>{e.issue}</div>
                        {e.location&&<div style={{fontSize:12,color:"#92400e",fontStyle:"italic",marginBottom:3}}>"{e.location}"</div>}
                        {e.suggestion&&<div style={{fontSize:12,color:"#14532d"}}>✓ {e.suggestion}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {r.languageReview.styleIssues?.length>0&&(
                <div>
                  <h3 style={{fontSize:13,fontWeight:700,color:"#2563b0",margin:"0 0 8px"}}>Style Issues ({r.languageReview.styleIssues.length})</h3>
                  <div style={{display:"flex",flexDirection:"column",gap:5}}>
                    {r.languageReview.styleIssues.map((e,i)=>(
                      <div key={i} style={{background:"#eff6ff",borderRadius:8,padding:"8px 11px",fontSize:13}}>
                        <span style={{fontWeight:600,color:"#1e40af"}}>{e.type}: </span>
                        {e.location&&<span style={{fontStyle:"italic",color:"#1e3a8a"}}>"{e.location}"</span>}
                        {e.suggestion&&<div style={{fontSize:12,color:"#14532d",marginTop:3}}>✓ {e.suggestion}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

          {/* ── LIT REVIEW ── */}
          {tab==="litreview"&&r.literatureReview&&(
            <>
              <div style={{display:"grid",gridTemplateColumns:"repeat(2,1fr)",gap:10,marginBottom:14}}>
                {[
                  ["Funnel Approach",r.literatureReview.funnelApproachScore,r.literatureReview.funnelApproachComment],
                  ["Relevance",r.literatureReview.relevanceScore,r.literatureReview.relevanceComment],
                  ["Critical Analysis",r.literatureReview.criticalAnalysisScore,r.literatureReview.criticalAnalysisComment],
                  ["Flow",r.literatureReview.flowScore,r.literatureReview.flowComment],
                ].map(([label,score,comment])=>(
                  <div key={label} style={{background:"#f8fafc",borderRadius:10,padding:"11px 13px",border:"1px solid #e2e8f0"}}>
                    <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
                      <span style={{fontSize:12,fontWeight:700,color:"#374151"}}>{label}</span>
                      <ScoreBadge score={score} size={18}/>
                    </div>
                    <div style={{height:5,background:"#e2e8f0",borderRadius:99,overflow:"hidden",marginBottom:7}}><div style={{height:"100%",width:score+"%",background:sc(score),borderRadius:99}}/></div>
                    <div style={{fontSize:12,color:"#64748b",lineHeight:1.6}}>{comment}</div>
                  </div>
                ))}
              </div>
              <div style={{background:"#fef3c7",borderRadius:10,padding:"11px 13px",marginBottom:10}}>
                <div style={{fontWeight:700,fontSize:12,color:"#78350f",marginBottom:6}}>FUNNEL APPROACH — WHAT TO CHECK</div>
                <div style={{fontSize:12,color:"#92400e",lineHeight:1.7}}>The literature review should move from <strong>broad context</strong> → <strong>narrowing theme</strong> → <strong>specific gap/problem</strong>. Broad international/general literature first, then national context, then specific topic, then the exact gap this study addresses.</div>
              </div>
              {r.literatureReview.gaps?.length>0&&(
                <div style={{marginBottom:10}}>
                  <h3 style={{fontSize:13,fontWeight:700,color:"#dc2626",margin:"0 0 7px"}}>Gaps Identified</h3>
                  {r.literatureReview.gaps.map((g,i)=><div key={i} style={{background:"#fee2e2",borderRadius:7,padding:"7px 10px",fontSize:12,color:"#7f1d1d",marginBottom:4}}>✗ {g}</div>)}
                </div>
              )}
              {r.literatureReview.strengths?.length>0&&(
                <div>
                  <h3 style={{fontSize:13,fontWeight:700,color:"#16a34a",margin:"0 0 7px"}}>Strengths</h3>
                  {r.literatureReview.strengths.map((g,i)=><div key={i} style={{background:"#f0fdf4",borderRadius:7,padding:"7px 10px",fontSize:12,color:"#14532d",marginBottom:4}}>✓ {g}</div>)}
                </div>
              )}
            </>
          )}

          {/* ── CITATIONS ── */}
          {tab==="citations"&&r.citationReview&&(
            <>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr 1fr",gap:10,marginBottom:14}}>
                <div style={{background:"#f8fafc",borderRadius:10,padding:"11px",textAlign:"center"}}>
                  <div style={{fontSize:11,color:"#64748b",fontWeight:600,marginBottom:3}}>CITATION SCORE</div>
                  <ScoreBadge score={r.citationReview.overallCitationScore}/>
                </div>
                <div style={{background:"#fee2e2",borderRadius:10,padding:"11px",textAlign:"center"}}>
                  <div style={{fontSize:11,color:"#991b1b",fontWeight:600,marginBottom:3}}>MISSING REFS</div>
                  <div style={{fontSize:22,fontWeight:800,color:"#dc2626"}}>{r.citationReview.missingReferences?.length||0}</div>
                </div>
                <div style={{background:"#fffbeb",borderRadius:10,padding:"11px",textAlign:"center"}}>
                  <div style={{fontSize:11,color:"#78350f",fontWeight:600,marginBottom:3}}>ORPHANED REFS</div>
                  <div style={{fontSize:22,fontWeight:800,color:"#d97706"}}>{r.citationReview.orphanedReferences?.length||0}</div>
                </div>
              </div>
              {r.citationReview.citationIssuesSummary&&(
                <div style={{background:"#f0f9ff",border:"1px solid #bae6fd",borderLeft:"4px solid #0ea5e9",borderRadius:9,padding:"10px 13px",marginBottom:14,fontSize:13,color:"#0c4a6e",lineHeight:1.7}}>{r.citationReview.citationIssuesSummary}</div>
              )}
              {r.citationReview.inTextCitations?.length>0&&(
                <div style={{marginBottom:14}}>
                  <h3 style={{fontSize:13,fontWeight:700,margin:"0 0 8px"}}>In-Text Citations ({r.citationReview.inTextCitations.length})</h3>
                  <div style={{display:"flex",flexDirection:"column",gap:6}}>
                    {r.citationReview.inTextCitations.map((c,i)=>(
                      <div key={i} style={{background:c.isCorrect?"#f0fdf4":"#fef9ee",borderRadius:9,padding:"9px 12px",border:`1px solid ${c.isCorrect?"#bbf7d0":"#fde68a"}`}}>
                        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:10}}>
                          <div style={{flex:1}}>
                            <div style={{fontWeight:700,fontSize:13,color:c.isCorrect?"#14532d":"#78350f"}}>{c.citation}</div>
                            {c.location&&<div style={{fontSize:11,color:"#64748b",fontStyle:"italic",marginTop:2}}>"{c.location}"</div>}
                            {!c.isCorrect&&c.issue&&<div style={{fontSize:12,color:"#dc2626",marginTop:4}}>⚠ {c.issue}</div>}
                            {!c.isCorrect&&c.correction&&<div style={{fontSize:12,color:"#14532d",marginTop:2}}>✓ {c.correction}</div>}
                          </div>
                          <a href={buildScholarUrl(c.searchQuery||c.citation)} target="_blank" rel="noopener noreferrer" style={{background:"#eff6ff",color:"#1e40af",padding:"4px 9px",borderRadius:6,fontSize:11,fontWeight:600,whiteSpace:"nowrap",textDecoration:"none",border:"1px solid #bfdbfe",flexShrink:0}}>Find Source ↗</a>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {r.citationReview.referenceList?.length>0&&(
                <div style={{marginBottom:14}}>
                  <h3 style={{fontSize:13,fontWeight:700,margin:"0 0 8px"}}>Reference List ({r.citationReview.referenceList.length})</h3>
                  <div style={{display:"flex",flexDirection:"column",gap:6}}>
                    {r.citationReview.referenceList.map((ref,i)=>(
                      <div key={i} style={{background:ref.isCorrect?"#f0fdf4":"#fee2e2",borderRadius:9,padding:"9px 12px",border:`1px solid ${ref.isCorrect?"#bbf7d0":"#fecaca"}`}}>
                        <div style={{display:"flex",alignItems:"flex-start",justifyContent:"space-between",gap:10}}>
                          <div style={{flex:1}}>
                            <div style={{fontSize:12,lineHeight:1.6,color:"#1a1a1a"}}>{ref.fullReference}</div>
                            {!ref.isCorrect&&ref.issue&&<div style={{fontSize:11,color:"#dc2626",marginTop:4}}>⚠ {ref.issue}</div>}
                            {!ref.isCorrect&&ref.correction&&<div style={{fontSize:11,color:"#14532d",marginTop:2}}>✓ {ref.correction}</div>}
                          </div>
                          <div style={{display:"flex",flexDirection:"column",gap:4,flexShrink:0}}>
                            {ref.doiOrUrl?(
                              <a href={ref.doiOrUrl.startsWith("10.")?"https://doi.org/"+ref.doiOrUrl:ref.doiOrUrl} target="_blank" rel="noopener noreferrer" style={{background:"#dcfce7",color:"#14532d",padding:"4px 9px",borderRadius:6,fontSize:11,fontWeight:600,whiteSpace:"nowrap",textDecoration:"none",border:"1px solid #bbf7d0"}}>Open Source ↗</a>
                            ):(
                              <a href={buildScholarUrl(ref.searchQuery||ref.fullReference)} target="_blank" rel="noopener noreferrer" style={{background:"#eff6ff",color:"#1e40af",padding:"4px 9px",borderRadius:6,fontSize:11,fontWeight:600,whiteSpace:"nowrap",textDecoration:"none",border:"1px solid #bfdbfe"}}>Find Source ↗</a>
                            )}
                          </div>
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {(r.citationReview.missingReferences?.length>0||r.citationReview.orphanedReferences?.length>0)&&(
                <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                  {r.citationReview.missingReferences?.length>0&&(
                    <div>
                      <h3 style={{fontSize:12,fontWeight:700,color:"#dc2626",margin:"0 0 6px"}}>Cited but not in Reference List</h3>
                      {r.citationReview.missingReferences.map((m,i)=><div key={i} style={{background:"#fee2e2",borderRadius:6,padding:"5px 9px",fontSize:12,color:"#7f1d1d",marginBottom:3}}>✗ {m}</div>)}
                    </div>
                  )}
                  {r.citationReview.orphanedReferences?.length>0&&(
                    <div>
                      <h3 style={{fontSize:12,fontWeight:700,color:"#d97706",margin:"0 0 6px"}}>In Reference List but not Cited</h3>
                      {r.citationReview.orphanedReferences.map((m,i)=><div key={i} style={{background:"#fffbeb",borderRadius:6,padding:"5px 9px",fontSize:12,color:"#78350f",marginBottom:3}}>⚠ {m}</div>)}
                    </div>
                  )}
                </div>
              )}
            </>
          )}

          {/* ── AI DETECTION ── */}
          {tab==="ai"&&r.aiDetection&&(
            <>
              <div style={{display:"flex",gap:14,marginBottom:14,flexWrap:"wrap"}}>
                <div style={{background:"#0f172a",borderRadius:14,padding:"1.25rem 1.5rem",textAlign:"center",minWidth:160}}>
                  <div style={{fontSize:11,color:"rgba(255,255,255,.5)",fontWeight:600,marginBottom:6}}>ESTIMATED AI CONTENT</div>
                  <div style={{fontSize:52,fontWeight:900,color:r.aiDetection.estimatedAiPercentage>60?"#f87171":r.aiDetection.estimatedAiPercentage>30?"#fbbf24":"#4ade80",lineHeight:1}}>{r.aiDetection.estimatedAiPercentage}%</div>
                  <div style={{fontSize:12,color:"rgba(255,255,255,.4)",marginTop:4}}>Confidence: {r.aiDetection.confidence}</div>
                </div>
                <div style={{flex:1,background:"#f8fafc",borderRadius:14,padding:"1.1rem 1.3rem"}}>
                  <div style={{fontSize:12,fontWeight:700,color:"#374151",marginBottom:6}}>AI USAGE ASSESSMENT</div>
                  <div style={{fontSize:13,color:"#64748b",lineHeight:1.7}}>{r.aiDetection.aiComment}</div>
                </div>
              </div>
              {r.aiDetection.aiSections?.length>0&&(
                <div style={{marginBottom:12}}>
                  <h3 style={{fontSize:13,fontWeight:700,color:"#dc2626",margin:"0 0 8px"}}>Suspected AI-Generated Sections</h3>
                  <div style={{display:"flex",flexDirection:"column",gap:6}}>
                    {r.aiDetection.aiSections.map((s,i)=>(
                      <div key={i} style={{background:"#fee2e2",borderRadius:9,padding:"10px 13px",border:"1px solid #fecaca"}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:5}}>
                          <span style={{fontWeight:700,fontSize:13,color:"#7f1d1d"}}>{s.section}</span>
                          <span style={{background:s.likelihood==="High"?"#dc2626":s.likelihood==="Medium"?"#d97706":"#64748b",color:"white",padding:"2px 8px",borderRadius:99,fontSize:11,fontWeight:600}}>{s.likelihood} likelihood</span>
                        </div>
                        {s.excerpt&&<div style={{fontSize:12,color:"#991b1b",fontStyle:"italic",marginBottom:5}}>"{s.excerpt}…"</div>}
                        {s.indicators?.length>0&&<div style={{display:"flex",gap:5,flexWrap:"wrap"}}>{s.indicators.map((ind,j)=><span key={j} style={{background:"#fecaca",color:"#7f1d1d",padding:"2px 7px",borderRadius:99,fontSize:11}}>{ind}</span>)}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {r.aiDetection.humanSections?.length>0&&(
                <div>
                  <h3 style={{fontSize:13,fontWeight:700,color:"#16a34a",margin:"0 0 8px"}}>Human-Written Sections</h3>
                  {r.aiDetection.humanSections.map((s,i)=><div key={i} style={{background:"#f0fdf4",borderRadius:7,padding:"7px 10px",fontSize:12,color:"#14532d",marginBottom:4}}>✓ {s}</div>)}
                </div>
              )}
            </>
          )}

          {/* ── FLOW ── */}
          {tab==="flow"&&r.informationFlow&&(
            <>
              <div style={{display:"flex",gap:14,marginBottom:14,alignItems:"center"}}>
                <div style={{background:"#f8fafc",borderRadius:11,padding:"1rem",textAlign:"center",minWidth:120}}>
                  <div style={{fontSize:11,color:"#64748b",fontWeight:600,marginBottom:3}}>FLOW SCORE</div>
                  <ScoreBadge score={r.informationFlow.overallFlowScore}/>
                </div>
                <div style={{flex:1}}>
                  <div style={{fontSize:12,fontWeight:600,color:"#374151",marginBottom:4}}>Transition Quality: <span style={{color:r.informationFlow.transitionQuality==="Excellent"?"#16a34a":r.informationFlow.transitionQuality==="Good"?"#2563b0":r.informationFlow.transitionQuality==="Fair"?"#d97706":"#dc2626"}}>{r.informationFlow.transitionQuality}</span></div>
                  <div style={{fontSize:13,color:"#64748b",lineHeight:1.6}}>{r.informationFlow.logicalProgressionComment}</div>
                </div>
              </div>
              {r.informationFlow.sectionFlow?.length>0&&(
                <div style={{marginBottom:12}}>
                  <h3 style={{fontSize:13,fontWeight:700,margin:"0 0 8px"}}>Section-by-Section Flow</h3>
                  <div style={{display:"flex",flexDirection:"column",gap:6}}>
                    {r.informationFlow.sectionFlow.map((s,i)=>(
                      <div key={i} style={{background:"#f8fafc",borderRadius:9,padding:"9px 12px",border:"1px solid #e2e8f0"}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center",marginBottom:4}}>
                          <span style={{fontWeight:700,fontSize:13}}>{s.section}</span>
                          <ScoreBadge score={s.flowScore} size={16}/>
                        </div>
                        <div style={{height:4,background:"#e2e8f0",borderRadius:99,overflow:"hidden",marginBottom:5}}><div style={{height:"100%",width:s.flowScore+"%",background:sc(s.flowScore),borderRadius:99}}/></div>
                        <div style={{fontSize:12,color:"#64748b"}}>{s.comment}</div>
                        {s.issue&&<div style={{fontSize:11,color:"#dc2626",marginTop:3}}>⚠ {s.issue}</div>}
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {r.informationFlow.recommendations?.length>0&&(
                <div>
                  <h3 style={{fontSize:13,fontWeight:700,margin:"0 0 8px"}}>Recommendations</h3>
                  {r.informationFlow.recommendations.map((rec,i)=><div key={i} style={{background:"#eff6ff",borderRadius:7,padding:"7px 10px",fontSize:12,color:"#1e40af",marginBottom:4}}>→ {rec}</div>)}
                </div>
              )}
            </>
          )}

          {/* ── SUMMARY ── */}
          {tab==="summary"&&(
            <>
              <div style={{background:"#f0f9ff",border:"1px solid #bae6fd",borderLeft:"4px solid #0ea5e9",borderRadius:10,padding:"1rem 1.2rem",marginBottom:14,fontSize:14,color:"#0c4a6e",lineHeight:1.85}}>{r.editorialSummary}</div>
              {r.priorityCorrections?.length>0&&(
                <div>
                  <h3 style={{fontSize:13,fontWeight:700,margin:"0 0 9px"}}>Priority Corrections</h3>
                  <div style={{display:"flex",flexDirection:"column",gap:6}}>
                    {r.priorityCorrections.map((c,i)=>(
                      <div key={i} style={{display:"flex",gap:10,padding:"10px 12px",borderRadius:9,background:pb(c.priority)}}>
                        <div style={{display:"flex",gap:5,flexShrink:0}}>
                          <span style={{fontWeight:700,fontSize:11,color:pc(c.priority),background:pc(c.priority)+"22",padding:"2px 7px",borderRadius:5,height:"fit-content"}}>{c.priority}</span>
                          <span style={{fontWeight:600,fontSize:11,color:"#64748b",background:"#f1f5f9",padding:"2px 7px",borderRadius:5,height:"fit-content"}}>{c.type}</span>
                        </div>
                        <span style={{fontSize:13,lineHeight:1.6}}>{c.action}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </>
          )}

        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════════════════
// SUPERVISOR SUBMIT ON BEHALF OF STUDENT
// ═══════════════════════════════════════════════════════════════════════

function SupSubmitModal({db,student,onClose,showToast,actor}){
  const fileRef=useRef();
  const[file,setFile]=useState(null);
  const[text,setText]=useState("");
  const[citStyle,setCitStyle]=useState("apa");
  const[docType,setDocType]=useState("full");
  const[chapters,setChapters]=useState([]);
  const[chapterByChapter,setChapterByChapter]=useState(false);
  const[customChapters,setCustomChapters]=useState("");
  const[loading,setLoading]=useState(false);
  const[loadingExt,setLoadingExt]=useState(false);
  const[error,setError]=useState("");
  const sup=db.supervisors.find(s=>s.id===student.supervisorId);
  // actor: who is performing this upload — defaults to the student's primary supervisor.
  // Pass {role:"admin",name} for admin uploads, or {role:"cosupervisor",name} for co-supervisor uploads.
  const actorRole=actor?.role||"supervisor";
  const actorName=actor?.name||sup?.name;

  const handleFile=async f=>{
    if(!f)return;setFile(f);setError("");setText("");
    const ext=f.name.split(".").pop().toLowerCase();
    try{
      let extracted="";
      if(ext==="docx"||ext==="doc"){
        const buf=await f.arrayBuffer();
        const res=await mammoth.extractRawText({arrayBuffer:buf});
        extracted=res.value||"";
      } else if(ext==="pdf"){
        extracted=await extractPdfText(f);
      } else {
        extracted=await new Promise((res,rej)=>{const r=new FileReader();r.onload=e=>res(e.target.result||"");r.onerror=rej;r.readAsText(f);});
      }
      setText(extracted);
      if(extracted.length>139000) setError("⚠ Very large document ("+Math.round(extracted.length/1000)+"KB text). It will be analysed in sections, but only the first ~139,000 characters will be covered. Submit individual chapters for full coverage.");
      else if(extracted.length<100) setError("⚠ Could not extract text from this file. Try converting to .docx or .txt first.");
    }catch(e){setError("Could not read file: "+e.message);}
  };

  const[progress,setProgress]=useState("");
  const submit=async(extended)=>{
    if(!text.trim())return setError("Upload a document first.");
    const allChapters=[...chapters,...customChapters.split(",").map(c=>c.trim()).filter(Boolean)];
    if(docType==="wip"&&allChapters.length===0)return setError("Select at least one chapter that's ready for review.");
    extended?setLoadingExt(true):setLoading(true);setError("");setProgress("");
    try{
      const actorPrefix=actorRole==="admin"?`Admin: ${actorName||"Administrator"}. `:actorRole==="cosupervisor"?`Co-Supervisor: ${actorName||""}. `:actorName?`Supervisor: ${actorName}. `:"";
      const notes=actorPrefix+(student.extraPrompt||"");
      const docContext={documentType:docType,chapters:allChapters,chapterByChapter};
      const {result,extendedResult,chunked,chunksUsed,chunksFailed,charsAnalysed,totalChars}=await analyzeSubmission(text,student,notes,{extended,citationStyle:citStyle,onProgress:setProgress,docContext});
      const submittedByLabel=actorRole==="admin"?(actorName?`admin (${actorName})`:"admin"):actorRole==="cosupervisor"?(actorName?`co-supervisor (${actorName})`:"co-supervisor"):"supervisor";
      const sub={id:"sub_"+uid(),studentId:student.id,filename:file?.name||"Document",date:new Date().toISOString(),submittedBy:submittedByLabel,result,chunked,chunksUsed,chunksFailed,charsAnalysed,totalChars,documentType:docType,chaptersReviewed:docType==="wip"?allChapters:null,chapterByChapter:docType==="full"?chapterByChapter:false,...(extendedResult?{extendedResult,citationStyle:citStyle}:{})};
      db.setSubmissions(prev=>[...prev,sub]);
      showToast(extended?"Extended analysis complete!":"Analysis complete!");
      onClose();
    }catch(e){setError("Analysis failed: "+(e.message||"Try again."));}
    setLoading(false);setLoadingExt(false);
  };

  const sl=STRICTNESS.find(l=>l.id===(student.strictness||"strict"));
  return(
    <Modal title={`Submit on behalf of ${student.initials} ${student.surname}`} onClose={onClose} maxW={580}>
      <div style={{background:"#f8fafc",borderRadius:10,padding:"9px 12px",marginBottom:13,fontSize:13}}>
        <span style={{color:sl?.color||"#d97706",fontWeight:700}}>{sl?.label}</span> · {student.level} · {(student.fields||[]).slice(0,2).join(", ")}
      </div>
      <DocTypeSelector docType={docType} setDocType={setDocType} chapters={chapters} setChapters={setChapters} chapterByChapter={chapterByChapter} setChapterByChapter={setChapterByChapter} customChapters={customChapters} setCustomChapters={setCustomChapters}/>
      <label style={LS}>Citation Style Used in Document</label>
      <select value={citStyle} onChange={e=>setCitStyle(e.target.value)} style={{...IS,marginBottom:12}}>
        {CITATION_STYLES.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}
      </select>
      <div onClick={()=>fileRef.current?.click()} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();handleFile(e.dataTransfer.files[0]);}} style={{border:`2px dashed ${file?"#3b82f6":"#cbd5e1"}`,borderRadius:11,padding:"1.5rem",textAlign:"center",cursor:"pointer",background:file?"#eff6ff":"#fafafa",marginBottom:11}}>
        <input ref={fileRef} type="file" accept=".txt,.md,.pdf,.docx,.doc" style={{display:"none"}} onChange={e=>handleFile(e.target.files[0])}/>
        <Ic n="upload" size={24} c={file?"#3b82f6":"#94a3b8"}/>
        <div style={{marginTop:7,fontWeight:600,color:file?"#1e40af":"#374151",fontSize:13}}>{file?file.name:"Drop document here or click to browse"}</div>
        {file&&<div style={{fontSize:11,color:"#94a3b8",marginTop:2}}>{(file.size/1024).toFixed(1)} KB</div>}
      </div>
      {progress&&(loading||loadingExt)&&<div style={{background:"#eff6ff",color:"#1e40af",borderRadius:7,padding:"8px 11px",fontSize:13,marginBottom:8,display:"flex",alignItems:"center",gap:7}}><div style={{animation:"spin 1s linear infinite",display:"inline-flex"}}><Ic n="spin" size={13} c="#3b82f6"/></div>{progress}</div>}
      {error&&!loading&&!loadingExt&&<div style={{background:"#fee2e2",color:"#991b1b",borderRadius:7,padding:"8px 11px",fontSize:13,marginBottom:10}}>{error}</div>}
      <div style={{display:"flex",gap:8}}>
        <button onClick={()=>submit(false)} disabled={!text||loading||loadingExt} style={{...BP,display:"flex",alignItems:"center",justifyContent:"center",gap:6,opacity:(!text||loading||loadingExt)?0.6:1,cursor:(!text||loading||loadingExt)?"not-allowed":"pointer"}}>
          {loading?<><div style={{animation:"spin 1s linear infinite",display:"inline-flex"}}><Ic n="spin" size={14} c="white"/></div>Analysing…</>:<><Ic n="chart" size={14} c="white"/>Standard Analysis</>}
        </button>
        <button onClick={()=>submit(true)} disabled={!text||loading||loadingExt} style={{...BP,background:"linear-gradient(135deg,#4f46e5,#3730a3)",display:"flex",alignItems:"center",justifyContent:"center",gap:6,opacity:(!text||loading||loadingExt)?0.6:1,cursor:(!text||loading||loadingExt)?"not-allowed":"pointer"}}>
          {loadingExt?<><div style={{animation:"spin 1s linear infinite",display:"inline-flex"}}><Ic n="spin" size={14} c="white"/></div>Extended…</>:<><Ic n="award" size={14} c="white"/>+ Extended Review</>}
        </button>
      </div>
      <p style={{fontSize:11,color:"#94a3b8",marginTop:8}}>Extended Review includes: language/grammar check, literature review funnel analysis, citation verification with source links, AI detection, and information flow analysis.</p>
    </Modal>
  );
}

// ═══════════════════════════════════════════════════════════
// FEEDBACK MODAL
// ═══════════════════════════════════════════════════════════

function FeedbackModal({submission,students,db,onClose}){
  const[tab,setTab]=useState("overview");
  const r=submission.result;
  const st=students.find(s=>s.id===submission.studentId)||{};
  if(!r)return null;
  const tabs=[{id:"overview",label:"Overview"},{id:"sections",label:"Sections"},{id:"actions",label:"Actions"},{id:"discipline",label:"Disciplinary"}];
  return(
    <div style={{position:"fixed",inset:0,background:"rgba(0,0,0,.6)",display:"flex",alignItems:"center",justifyContent:"center",zIndex:1000,padding:"1rem"}}>
      <div style={{background:"white",borderRadius:20,width:"100%",maxWidth:740,maxHeight:"92vh",overflow:"auto",boxShadow:"0 30px 80px rgba(0,0,0,.35)",display:"flex",flexDirection:"column"}}>
        <div style={{background:"#0f172a",padding:"1.4rem",borderRadius:"20px 20px 0 0",display:"flex",alignItems:"flex-start",justifyContent:"space-between"}}>
          <div>
            <div style={{color:"rgba(255,255,255,.4)",fontSize:12,marginBottom:3}}>{st.initials} {st.surname} · {st.number}</div>
            <h2 style={{color:"white",fontSize:16,fontWeight:700,margin:0}}>{submission.filename}</h2>
            <div style={{display:"flex",gap:7,marginTop:7,flexWrap:"wrap"}}>
              <Pill label={`${r.overallScore}% · ${r.overallGrade}`} bg={sb(r.overallScore)} color={sc(r.overallScore)}/>
              <Pill label={r.supervisorDecision} bg={dc2(r.supervisorDecision)+"30"} color={dc2(r.supervisorDecision)}/>
              {docTypeBadgeLabel(submission)&&<Pill label={docTypeBadgeLabel(submission)} bg="rgba(255,255,255,.15)" color="white"/>}
              {submission.chunked&&<Pill label={`Full document · ${submission.chunksUsed} sections`} bg="rgba(255,255,255,.15)" color="white"/>}
              {submission.chunksFailed>0&&<Pill label={`⚠ ${submission.chunksFailed} section${submission.chunksFailed>1?"s":""} unreadable`} bg="#dc2626" color="white"/>}
            </div>
          </div>
          <div style={{display:"flex",gap:6,flexShrink:0}}>
            <PdfDownloadButton submission={submission} student={st} db={db} variant="header"/>
            <button onClick={onClose} style={{background:"rgba(255,255,255,.1)",border:"none",borderRadius:7,width:28,height:28,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><Ic n="x" size={14} c="white"/></button>
          </div>
        </div>
        <div style={{padding:"0 1.4rem",background:"#f8fafc",borderBottom:"1px solid #e2e8f0",display:"flex"}}>
          {tabs.map(t=><button key={t.id} onClick={()=>setTab(t.id)} style={{padding:"10px 14px",border:"none",background:"none",cursor:"pointer",fontWeight:tab===t.id?700:400,color:tab===t.id?"#0f172a":"#94a3b8",borderBottom:`2px solid ${tab===t.id?"#3b82f6":"transparent"}`,fontSize:13,whiteSpace:"nowrap"}}>{t.label}</button>)}
        </div>
        <div style={{padding:"1.4rem",overflow:"auto",flex:1}}>
          {tab==="overview"&&(
            <>
              <div style={{background:"#f0f9ff",border:"1px solid #bae6fd",borderLeft:"4px solid #0ea5e9",borderRadius:9,padding:".9rem 1.1rem",marginBottom:13,fontSize:14,color:"#0c4a6e",lineHeight:1.8}}>{r.overallVerdict}</div>
              <div style={{display:"flex",alignItems:"center",gap:16,background:"#f8fafc",borderRadius:12,padding:"1rem",marginBottom:13}}>
                <div style={{textAlign:"center",minWidth:68}}><div style={{fontSize:40,fontWeight:900,color:sc(r.overallScore),lineHeight:1}}>{r.overallScore}</div><div style={{fontSize:12,color:"#64748b"}}>/100</div></div>
                <div style={{flex:1}}>
                  <div style={{height:9,background:"#e2e8f0",borderRadius:99,overflow:"hidden",marginBottom:7}}><div style={{height:"100%",width:r.overallScore+"%",background:sc(r.overallScore),borderRadius:99}}/></div>
                  <div style={{display:"flex",gap:8,flexWrap:"wrap"}}>{(r.sections||[]).slice(0,4).map(s=><div key={s.name} style={{fontSize:11}}><span style={{color:"#94a3b8"}}>{s.name.slice(0,18)}: </span><span style={{fontWeight:700,color:sc(s.score)}}>{s.score}%</span></div>)}</div>
                </div>
              </div>
              <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10}}>
                <div><div style={{fontSize:11,fontWeight:700,color:"#16a34a",textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>Strengths</div><div style={{display:"flex",flexDirection:"column",gap:4}}>{(r.positives||[]).map((p,i)=><div key={i} style={{display:"flex",gap:6,background:"#f0fdf4",borderRadius:7,padding:"6px 8px",fontSize:12,color:"#14532d",lineHeight:1.5}}><span style={{flexShrink:0}}>✓</span>{p}</div>)}</div></div>
                <div><div style={{fontSize:11,fontWeight:700,color:"#dc2626",textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>Critical Issues</div><div style={{display:"flex",flexDirection:"column",gap:4}}>{(r.criticalIssues||[]).map((p,i)=><div key={i} style={{display:"flex",gap:6,background:"#fee2e2",borderRadius:7,padding:"6px 8px",fontSize:12,color:"#7f1d1d",lineHeight:1.5}}><span style={{flexShrink:0}}>✗</span>{p}</div>)}</div></div>
              </div>
            </>
          )}
          {tab==="sections"&&<div style={{display:"flex",flexDirection:"column",gap:10}}>
            {(r.sections||[]).map(s=>(
              <div key={s.name} style={{border:"1px solid #e2e8f0",borderRadius:10,overflow:"hidden"}}>
                <div style={{display:"flex",alignItems:"center",gap:10,padding:"10px 13px",background:"#f8fafc"}}>
                  <div style={{flex:1}}><div style={{fontWeight:700,fontSize:13}}>{s.name}</div><div style={{fontSize:11,color:"#94a3b8"}}>Grade: {s.grade}</div></div>
                  <div style={{textAlign:"right"}}><div style={{fontSize:20,fontWeight:800,color:sc(s.score)}}>{s.score}%</div><div style={{height:4,width:64,background:"#e2e8f0",borderRadius:99,overflow:"hidden",marginTop:3}}><div style={{height:"100%",width:s.score+"%",background:sc(s.score),borderRadius:99}}/></div></div>
                </div>
                <div style={{padding:"10px 13px"}}>
                  {s.strengths?.length>0&&<div style={{marginBottom:6}}><div style={{fontSize:11,fontWeight:700,color:"#16a34a",marginBottom:3}}>Strengths</div>{s.strengths.map((x,i)=><div key={i} style={{fontSize:12,color:"#166534",padding:"2px 0 2px 7px",borderLeft:"2px solid #86efac",marginBottom:2}}>{x}</div>)}</div>}
                  {s.weaknesses?.length>0&&<div style={{marginBottom:6}}><div style={{fontSize:11,fontWeight:700,color:"#dc2626",marginBottom:3}}>Weaknesses</div>{s.weaknesses.map((x,i)=><div key={i} style={{fontSize:12,color:"#7f1d1d",padding:"2px 0 2px 7px",borderLeft:"2px solid #fca5a5",marginBottom:2}}>{x}</div>)}</div>}
                  {s.supervisorInstruction&&<div style={{background:"#fffbeb",border:"1px solid #fde68a",borderRadius:7,padding:"6px 10px",fontSize:12,color:"#78350f"}}><strong>Instruction: </strong>{s.supervisorInstruction}</div>}
                </div>
              </div>
            ))}
          </div>}
          {tab==="actions"&&<div style={{display:"flex",flexDirection:"column",gap:6}}>
            {(r.priorityActions||[]).map((a,i)=>(
              <div key={i} style={{display:"flex",gap:10,padding:"10px 12px",borderRadius:9,background:pb(a.priority)}}>
                <span style={{fontWeight:700,fontSize:11,color:pc(a.priority),background:pc(a.priority)+"22",padding:"2px 7px",borderRadius:5,height:"fit-content",whiteSpace:"nowrap",flexShrink:0}}>{a.priority}</span>
                <span style={{fontSize:13,color:a.priority==="Critical"?"#fca5a5":"#1a1a1a",lineHeight:1.6}}>{a.action}</span>
              </div>
            ))}
          </div>}
          {tab==="discipline"&&<>
            <div style={{background:"#f8fafc",borderRadius:9,padding:".8rem 1rem",fontSize:13,color:"#334155",lineHeight:1.85,marginBottom:11}}>
              <div style={{fontWeight:700,fontSize:11,color:"#64748b",textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>Disciplinary Assessment</div>{r.disciplinaryAssessment}
            </div>
            <div style={{background:"#eff6ff",border:"1px solid #bfdbfe",borderRadius:9,padding:".8rem 1rem",fontSize:13,color:"#1e3a8a",lineHeight:1.85}}>
              <div style={{fontWeight:700,fontSize:11,color:"#1e40af",textTransform:"uppercase",letterSpacing:".06em",marginBottom:6}}>ECSA Graduate Attributes</div>{r.ecsa_ga_notes}
            </div>
          </>}
        </div>
      </div>
    </div>
  );
}

function RecentReports({db,submissions,students}){
  const[view,setView]=useState(null);
  const getStu=id=>students.find(s=>s.id===id)||{};
  const rows=[...submissions].reverse().slice(0,8);
  const cols=[
    {label:"Student",  render:r=>{const s=getStu(r.studentId);return <span style={{fontWeight:600}}>{s.initials} {s.surname}</span>;}},
    {label:"Level",    render:r=><Pill label={getStu(r.studentId).level||"—"} bg="#dbeafe" color="#1e40af"/>},
    {label:"File",     render:r=><span style={{color:"#64748b",fontSize:12,maxWidth:130,display:"block",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.filename}</span>},
    {label:"Score",    render:r=><span style={{fontWeight:800,color:sc(r.result?.overallScore||0)}}>{r.result?.overallScore??"-"}%</span>},
    {label:"Decision", render:r=>r.result?.supervisorDecision?<Pill label={r.result.supervisorDecision} bg={sb(r.result.overallScore||0)} color={dc2(r.result.supervisorDecision)}/>:"-"},
    {label:"Date",     render:r=><span style={{color:"#94a3b8",fontSize:12}}>{new Date(r.date).toLocaleDateString("en-ZA")}</span>},
    {label:"",         render:r=><div style={{display:"flex",gap:6}}>
      <button onClick={()=>setView(r)} style={{background:"none",border:"none",cursor:"pointer",color:"#3b82f6"}}><Ic n="eye" size={14}/></button>
      <PdfDownloadButton submission={r} student={getStu(r.studentId)} db={db}/>
    </div>},
  ];
  return(
    <>
      <div style={{background:"white",borderRadius:12,border:"1px solid #e2e8f0",overflow:"hidden"}}>
        <div style={{padding:".75rem 1.1rem",borderBottom:"1px solid #f1f5f9"}}><h3 style={{margin:0,fontSize:13,fontWeight:700}}>Recent Reports</h3></div>
        <DataTable cols={cols} rows={rows} empty="No reports yet."/>
      </div>
      {view&&<FeedbackModal submission={view} students={students} db={db} onClose={()=>setView(null)}/>}
    </>
  );
}


// ═══════════════════════════════════════════════════════════
// ADMIN PORTAL
// ═══════════════════════════════════════════════════════════

function AdminPortal({db,session,onLogout,showToast}){
  const[view,setView]=useState("dashboard");
  const me=db.admins.find(a=>a.id===session.id)||{};
  const nav=[
    {id:"dashboard",   icon:"chart",   label:"Dashboard"},
    {id:"admins",      icon:"shield",  label:"Admins"},
    {id:"supervisors", icon:"users",   label:"Supervisors"},
    {id:"students",    icon:"user",    label:"Students"},
    {id:"institutions",icon:"building",label:"Institutions"},
    {id:"reports",     icon:"file",    label:"All Reports"},
    {id:"allocate",    icon:"link2",   label:"Allocations"},
    {id:"settings",    icon:"settings",label:"My Settings"},
  ];
  return(
    <Shell role="admin" nav={nav} active={view} setActive={setView} onLogout={onLogout} badge={me.name||me.username}>
      {view==="dashboard"   && <AdminDashboard   db={db}/>}
      {view==="admins"      && <AdminsTab        db={db} session={session} showToast={showToast}/>}
      {view==="supervisors" && <SupervisorsTab   db={db} showToast={showToast}/>}
      {view==="students"    && <AdminStudentsTab db={db} session={session} showToast={showToast}/>}
      {view==="institutions"&& <InstitutionsTab  db={db} showToast={showToast}/>}
      {view==="reports"     && <AllReportsTab    db={db}/>}
      {view==="allocate"    && <AllocateTab      db={db} showToast={showToast}/>}
      {view==="settings"    && <AccountSettings  role="admin" db={db} session={session} showToast={showToast}/>}
    </Shell>
  );
}

function AdminDashboard({db}){
  const subs=db.submissions;
  const avg=subs.length?Math.round(subs.reduce((a,s)=>a+(s.result?.overallScore||0),0)/subs.length):0;
  return(
    <><PageHeader title="Dashboard"/>
    <Pad>
      <StatCards cards={[
        {label:"Admins",      value:db.admins.length,      icon:"shield",color:"#f59e0b"},
        {label:"Supervisors", value:db.supervisors.length,  icon:"users", color:"#3b82f6"},
        {label:"Students",    value:db.students.length,     icon:"user",  color:"#8b5cf6"},
        {label:"Reports",     value:subs.length,            icon:"file",  color:"#16a34a"},
        {label:"Avg Score",   value:avg+"%",                icon:"chart", color:"#d97706"},
      ]}/>
      <RecentReports db={db} submissions={subs} students={db.students}/>
    </Pad></>
  );
}

function AdminsTab({db,session,showToast}){
  const[showAdd,setShowAdd]=useState(false);
  const del=a=>{ if(a.id===session.id){showToast("Cannot delete your own account.","error");return;} if(window.confirm(`Delete admin ${a.name||a.username}?`)) db.setAdmins(prev=>prev.filter(x=>x.id!==a.id)); };
  const cols=[
    {label:"Name",    render:r=><span style={{fontWeight:700}}>{r.name||r.username}</span>},
    {label:"Username",render:r=><code style={{fontSize:12}}>{r.username}</code>},
    {label:"Email",   key:"email"},
    {label:"Created", render:r=>r.createdAt?new Date(r.createdAt).toLocaleDateString("en-ZA"):"-"},
    {label:"",        render:r=>r.id!==session.id?<button onClick={()=>del(r)} style={{background:"#fee2e2",border:"none",borderRadius:6,padding:"4px 8px",cursor:"pointer",color:"#dc2626"}}><Ic n="trash" size={13}/></button>:null},
  ];
  return(
    <><PageHeader title="Admins" action={<button onClick={()=>setShowAdd(true)} style={{...BP,width:"auto",padding:"7px 14px",display:"flex",alignItems:"center",gap:5,fontSize:13}}><Ic n="plus" size={14} c="white"/> Add Admin</button>}/>
    <Pad><DataTable cols={cols} rows={db.admins}/></Pad>
    {showAdd&&<AddAdminModal db={db} onClose={()=>setShowAdd(false)} showToast={showToast}/>}</>
  );
}

function AddAdminModal({db,onClose,showToast}){
  const[f,setF]=useState({name:"",username:"",email:"",password:"",conf:""});
  const[err,setErr]=useState("");
  const up=k=>e=>setF(p=>({...p,[k]:e.target.value}));
  const save=()=>{
    setErr("");
    if(!f.name||!f.username||!f.password)return setErr("Name, username and password required.");
    if(f.password!==f.conf)return setErr("Passwords do not match.");
    if(f.password.length<6)return setErr("Min 6 chars.");
    if(db.admins.find(a=>a.username===f.username.trim()))return setErr("Username taken.");
    db.setAdmins(p=>[...p,{id:"adm_"+uid(),name:f.name.trim(),username:f.username.trim(),email:f.email.trim(),password:f.password,securityQ:{question:SECURITY_QUESTIONS[0],answer:""},createdAt:new Date().toISOString()}]);
    showToast("Admin added.");onClose();
  };
  return(
    <Modal title="Add Admin" onClose={onClose}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
        <div><label style={LS}>Full Name *</label><input value={f.name} onChange={up("name")} style={IS}/></div>
        <div><label style={LS}>Username *</label><input value={f.username} onChange={up("username")} style={IS}/></div>
      </div>
      <label style={LS}>Email</label><input value={f.email} onChange={up("email")} style={{...IS,marginBottom:9}}/>
      <label style={LS}>Password *</label><PwdInput value={f.password} onChange={up("password")} placeholder="Min 6 chars"/>
      <div style={{marginTop:8}}><label style={LS}>Confirm *</label><PwdInput value={f.conf} onChange={up("conf")}/></div>
      <Err msg={err}/>
      <div style={{display:"flex",gap:8,marginTop:13}}><button onClick={save} style={BP}>Add Admin</button><button onClick={onClose} style={BS}>Cancel</button></div>
    </Modal>
  );
}

function SupervisorsTab({db,showToast}){
  const[showAdd,setShowAdd]=useState(false);const[edit,setEdit]=useState(null);
  const del=s=>{
    if(!window.confirm(`Delete ${s.name}?`))return;
    db.setStudents(prev=>prev.map(st=>st.supervisorId===s.id?{...st,supervisorId:null}:st));
    db.setSupervisors(prev=>prev.filter(x=>x.id!==s.id));
    showToast("Supervisor deleted.");
  };
  const cols=[
    {label:"Name",      render:r=><span style={{fontWeight:700}}>{r.name}</span>},
    {label:"Username",  render:r=><code style={{fontSize:12}}>{r.username}</code>},
    {label:"Email",     key:"email"},
    {label:"Students",  render:r=>db.students.filter(s=>s.supervisorId===r.id).length},
    {label:"",          render:r=><div style={{display:"flex",gap:5}}>
      <button onClick={()=>setEdit(r)} style={{background:"#eff6ff",border:"none",borderRadius:6,padding:"4px 7px",cursor:"pointer",color:"#3b82f6"}}><Ic n="edit" size={13}/></button>
      <button onClick={()=>del(r)} style={{background:"#fee2e2",border:"none",borderRadius:6,padding:"4px 7px",cursor:"pointer",color:"#dc2626"}}><Ic n="trash" size={13}/></button>
    </div>},
  ];
  return(
    <><PageHeader title="Supervisors" action={<button onClick={()=>setShowAdd(true)} style={{...BP,width:"auto",padding:"7px 14px",display:"flex",alignItems:"center",gap:5,fontSize:13}}><Ic n="plus" size={14} c="white"/> Add Supervisor</button>}/>
    <Pad><DataTable cols={cols} rows={db.supervisors}/></Pad>
    {showAdd&&<SupFormModal db={db} onClose={()=>setShowAdd(false)} showToast={showToast}/>}
    {edit&&<SupFormModal db={db} existing={edit} onClose={()=>setEdit(null)} showToast={showToast}/>}</>
  );
}

function SupFormModal({db,existing,onClose,showToast}){
  const isNew=!existing;
  const[f,setF]=useState({name:existing?.name||"",username:existing?.username||"",email:existing?.email||"",password:"",conf:""});
  const[err,setErr]=useState("");
  const up=k=>e=>setF(p=>({...p,[k]:e.target.value}));
  const save=()=>{
    setErr("");
    if(!f.name||!f.username)return setErr("Name and username required.");
    if(isNew&&!f.password)return setErr("Password required.");
    if(f.password&&f.password!==f.conf)return setErr("Passwords do not match.");
    if(f.password&&f.password.length<6)return setErr("Min 6 chars.");
    if(db.supervisors.find(s=>s.username===f.username.trim()&&s.id!==existing?.id))return setErr("Username taken.");
    if(isNew){ db.setSupervisors(p=>[...p,{id:"sup_"+uid(),name:f.name.trim(),username:f.username.trim(),email:f.email.trim(),password:f.password,securityQ:{question:SECURITY_QUESTIONS[0],answer:""},createdAt:new Date().toISOString()}]); }
    else { db.setSupervisors(prev=>prev.map(s=>s.id===existing.id?{...s,name:f.name.trim(),username:f.username.trim(),email:f.email.trim(),...(f.password?{password:f.password}:{})}:s)); }
    showToast(isNew?"Supervisor added.":"Supervisor updated.");onClose();
  };
  return(
    <Modal title={isNew?"Add Supervisor":"Edit Supervisor"} onClose={onClose}>
      <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:10,marginBottom:10}}>
        <div><label style={LS}>Full Name *</label><input value={f.name} onChange={up("name")} placeholder="Dr A Smith" style={IS}/></div>
        <div><label style={LS}>Username *</label><input value={f.username} onChange={up("username")} style={IS}/></div>
      </div>
      <label style={LS}>Email</label><input value={f.email} onChange={up("email")} style={{...IS,marginBottom:9}}/>
      <label style={LS}>{isNew?"Password *":"New Password (leave blank to keep)"}</label>
      <PwdInput value={f.password} onChange={up("password")} placeholder={isNew?"Min 6 chars":"Leave blank"}/>
      {f.password&&<div style={{marginTop:8}}><label style={LS}>Confirm</label><PwdInput value={f.conf} onChange={up("conf")}/></div>}
      <Err msg={err}/>
      <div style={{display:"flex",gap:8,marginTop:13}}><button onClick={save} style={BP}>{isNew?"Add":"Save"} Supervisor</button><button onClick={onClose} style={BS}>Cancel</button></div>
    </Modal>
  );
}

function AdminStudentsTab({db,session,showToast}){
  const[showAdd,setShowAdd]=useState(false);const[edit,setEdit]=useState(null);const[search,setSearch]=useState("");const[submitFor,setSubmitFor]=useState(null);
  const rows=db.students.filter(s=>`${s.surname} ${s.initials} ${s.number}`.toLowerCase().includes(search.toLowerCase()));
  const getSup=id=>db.supervisors.find(s=>s.id===id);
  const me=db.admins.find(a=>a.id===session?.id);
  const del=s=>{ if(!window.confirm(`Delete ${s.initials} ${s.surname}?`))return; db.setStudents(prev=>prev.filter(x=>x.id!==s.id)); showToast("Student deleted."); };
  const cols=[
    {label:"Student",   render:r=><span style={{fontWeight:700}}>{r.initials} {r.surname}</span>},
    {label:"Number",    render:r=><code style={{fontSize:12}}>{r.number}</code>},
    {label:"Institution", render:r=><span style={{fontSize:12,color:"#64748b"}}>{r.institution||"—"}</span>},
    {label:"Level",     render:r=><Pill label={r.level} bg="#dbeafe" color="#1e40af"/>},
    {label:"Supervisor",render:r=>{const s=getSup(r.supervisorId);return s?<span style={{color:"#14532d",fontSize:12}}>{s.name}</span>:<span style={{color:"#94a3b8",fontSize:12}}>Unassigned</span>;}},
    {label:"Co-Supervisors",render:r=>{const cos=(r.coSupervisorIds||[]).map(id=>db.supervisors.find(s=>s.id===id)?.name).filter(Boolean);return cos.length>0?<span style={{fontSize:12,color:"#5b21b6"}}>{cos.join(", ")}</span>:<span style={{color:"#e2e8f0",fontSize:12}}>—</span>;}},
    {label:"Reports",   render:r=>db.submissions.filter(s=>s.studentId===r.id).length},
    {label:"",          render:r=><div style={{display:"flex",gap:5}}>
      <button onClick={()=>setEdit(r)} style={{background:"#eff6ff",border:"none",borderRadius:6,padding:"4px 7px",cursor:"pointer",color:"#3b82f6"}}><Ic n="edit" size={13}/></button>
      <button onClick={()=>setSubmitFor(r)} title="Submit on behalf of student" style={{background:"#f0fdf4",border:"none",borderRadius:6,padding:"4px 7px",cursor:"pointer",color:"#16a34a"}}><Ic n="upload" size={13}/></button>
      <button onClick={()=>del(r)} style={{background:"#fee2e2",border:"none",borderRadius:6,padding:"4px 7px",cursor:"pointer",color:"#dc2626"}}><Ic n="trash" size={13}/></button>
    </div>},
  ];
  return(
    <><PageHeader title="Students" action={<button onClick={()=>setShowAdd(true)} style={{...BP,width:"auto",padding:"7px 14px",display:"flex",alignItems:"center",gap:5,fontSize:13}}><Ic n="plus" size={14} c="white"/> Add Student</button>}/>
    <Pad>
      <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search students…" style={{...IS,maxWidth:300,marginBottom:13}}/>
      <DataTable cols={cols} rows={rows}/>
    </Pad>
    {showAdd&&<StudentFormModal db={db} onClose={()=>setShowAdd(false)} showToast={showToast}/>}
    {edit&&<StudentFormModal db={db} existing={edit} onClose={()=>setEdit(null)} showToast={showToast}/>}
    {submitFor&&<SupSubmitModal db={db} student={submitFor} onClose={()=>setSubmitFor(null)} showToast={showToast} actor={{role:"admin",name:me?.name||me?.username}}/>}</>
  );
}

// ═══════════════════════════════════════════════════════════
// INSTITUTION BRANDING — logo + accent colour used on report letterheads.
// Not sourced/guessed by AcademiQ: since university names, logos and colour
// schemes are registered trademarks, the admin (who has legitimate access to
// their own institution's official assets) sets these directly rather than
// the app fabricating "official" branding it can't verify.
// ═══════════════════════════════════════════════════════════

// Reads an uploaded image, downsizes it (so logos stay small enough to comfortably
// store as a data URL in Firebase RTDB), and returns a PNG data URL — which works
// as a drop-in value for the same `logoUrl` field used for external links, since
// <img src> accepts data URLs exactly like normal ones.
function resizeImageToDataUrl(file, maxDim = 240) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => {
      const img = new Image();
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDim || height > maxDim) {
          if (width > height) { height = Math.round(height * maxDim / width); width = maxDim; }
          else { width = Math.round(width * maxDim / height); height = maxDim; }
        }
        const canvas = document.createElement("canvas");
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext("2d");
        ctx.clearRect(0, 0, width, height);
        ctx.drawImage(img, 0, 0, width, height);
        resolve(canvas.toDataURL("image/png"));
      };
      img.onerror = () => reject(new Error("Could not read that image file."));
      img.src = reader.result;
    };
    reader.onerror = () => reject(new Error("Could not read that file."));
    reader.readAsDataURL(file);
  });
}

function InstitutionEditModal({db,institution,onClose,showToast}){
  const existing=db.institutionBranding.find(b=>b.id===institution.name);
  const[color,setColor]=useState(existing?.color||fallbackInstitutionColor(institution.name));
  const[logoUrl,setLogoUrl]=useState(existing?.logoUrl||"");
  const[uploading,setUploading]=useState(false);
  const[uploadErr,setUploadErr]=useState("");
  const fileRef=useRef();
  const handleFile=async f=>{
    if(!f)return;
    if(!f.type.startsWith("image/")){setUploadErr("Please choose an image file.");return;}
    setUploading(true);setUploadErr("");
    try{ setLogoUrl(await resizeImageToDataUrl(f)); }
    catch(e){ setUploadErr(e.message||"Could not process that image."); }
    setUploading(false);
  };
  const save=()=>{
    db.setInstitutionBranding(prev=>{
      const rest=prev.filter(b=>b.id!==institution.name);
      return [...rest,{id:institution.name,color,logoUrl:logoUrl.trim()}];
    });
    showToast(`${institution.abbr} branding saved.`);
    onClose();
  };
  const reset=()=>{
    db.setInstitutionBranding(prev=>prev.filter(b=>b.id!==institution.name));
    showToast(`${institution.abbr} branding reset to default.`);
    onClose();
  };
  return(
    <Modal title={`Branding — ${institution.name}`} onClose={onClose} maxW={480}>
      <div style={{marginBottom:14}}>
        <label style={LS}>Accent Colour</label>
        <div style={{display:"flex",gap:8,alignItems:"center"}}>
          <input type="color" value={color} onChange={e=>setColor(e.target.value)} style={{width:44,height:38,border:"1.5px solid #e2e8f0",borderRadius:8,padding:2,cursor:"pointer"}}/>
          <input value={color} onChange={e=>setColor(e.target.value)} style={IS}/>
        </div>
      </div>
      <div style={{marginBottom:14}}>
        <label style={LS}>Logo</label>
        <input ref={fileRef} type="file" accept="image/*" style={{display:"none"}} onChange={e=>handleFile(e.target.files[0])}/>
        <div style={{display:"flex",gap:6,marginBottom:8}}>
          <button type="button" onClick={()=>fileRef.current?.click()} disabled={uploading} style={{...BP,width:"auto",flex:1,padding:"9px 12px",fontSize:12.5,display:"flex",alignItems:"center",justifyContent:"center",gap:6,opacity:uploading?.6:1}}>
            <Ic n="upload" size={14} c="white"/> {uploading?"Processing…":"Upload Image"}
          </button>
          {logoUrl&&<button type="button" onClick={()=>setLogoUrl("")} style={{background:"#fee2e2",border:"none",borderRadius:9,padding:"9px 12px",color:"#dc2626",fontWeight:700,fontSize:12.5,cursor:"pointer"}}>Clear</button>}
        </div>
        {uploadErr&&<p style={{fontSize:12,color:"#dc2626",marginBottom:8}}>{uploadErr}</p>}
        <label style={{...LS,fontSize:10.5}}>Or paste an image URL</label>
        <input value={logoUrl.startsWith("data:")?"":logoUrl} onChange={e=>setLogoUrl(e.target.value)} placeholder="https://www.example.ac.za/logo.png" style={IS} disabled={logoUrl.startsWith("data:")}/>
        {logoUrl.startsWith("data:")&&<p style={{fontSize:11,color:"#94a3b8",marginTop:4}}>An uploaded image is set — click Clear above to paste a URL instead.</p>}
        <p style={{fontSize:11.5,color:"#94a3b8",marginTop:6,lineHeight:1.5}}>Upload the institution's own official logo image (only from a source you have the rights to use), or link directly to it. Leave blank to use a plain monogram in the accent colour instead.</p>
      </div>
      <div style={{background:"#f8fafc",borderRadius:9,padding:12,marginBottom:16}}>
        <label style={{...LS,marginBottom:8}}>Preview</label>
        <div style={{display:"flex",alignItems:"center",gap:10,background:"white",border:"1px solid #e2e8f0",borderRadius:9,padding:10}}>
          {logoUrl?<img src={logoUrl} alt="" style={{height:36,maxWidth:100,objectFit:"contain"}} onError={e=>{e.target.style.display="none";}}/>
            :<div style={{width:36,height:36,borderRadius:8,background:color,color:"white",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:12}}>{institution.abbr.slice(0,4)}</div>}
          <div style={{fontWeight:700,fontSize:13}}>{institution.name}</div>
        </div>
      </div>
      <div style={{display:"flex",gap:8}}>
        <button onClick={save} style={{...BP,flex:1}}>Save Branding</button>
        {existing&&<button onClick={reset} style={{background:"#fee2e2",border:"none",borderRadius:9,padding:"10px 16px",color:"#dc2626",fontWeight:700,fontSize:13,cursor:"pointer"}}>Reset</button>}
      </div>
    </Modal>
  );
}

function InstitutionsTab({db,showToast}){
  const[search,setSearch]=useState("");
  const[edit,setEdit]=useState(null);
  const usedNames=new Set(db.students.map(s=>s.institution).filter(Boolean));
  const rows=SA_UNIVERSITIES.filter(u=>u.name.toLowerCase().includes(search.toLowerCase())||u.abbr.toLowerCase().includes(search.toLowerCase()))
    .sort((a,b)=>(usedNames.has(b.name)?1:0)-(usedNames.has(a.name)?1:0));
  return(
    <>
      <PageHeader title="Institutions"/>
      <Pad>
        <p style={{fontSize:12.5,color:"#64748b",marginBottom:13,lineHeight:1.6}}>Set an accent colour and (optionally) an official logo for each institution. This branding is used on the letterhead of generated PDF reports for students at that institution. Institutions with students currently registered are listed first.</p>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search institutions…" style={{...IS,maxWidth:320,marginBottom:13}}/>
        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill,minmax(280px,1fr))",gap:10}}>
          {rows.map(u=>{
            const b=getInstitutionBranding(db,u.name);
            const configured=db.institutionBranding.some(x=>x.id===u.name);
            return(
              <div key={u.name} onClick={()=>setEdit(u)} style={{border:"1px solid #e2e8f0",borderRadius:10,padding:12,display:"flex",alignItems:"center",gap:10,cursor:"pointer",background:"white"}}>
                {b.logoUrl?<img src={b.logoUrl} alt="" style={{height:30,maxWidth:60,objectFit:"contain",flexShrink:0}} onError={e=>{e.target.style.display="none";}}/>
                  :<div style={{width:30,height:30,borderRadius:7,background:b.color,color:"white",display:"flex",alignItems:"center",justifyContent:"center",fontWeight:800,fontSize:10,flexShrink:0}}>{u.abbr.slice(0,3)}</div>}
                <div style={{flex:1,minWidth:0}}>
                  <div style={{fontWeight:700,fontSize:12.5,whiteSpace:"nowrap",overflow:"hidden",textOverflow:"ellipsis"}}>{u.name}</div>
                  <div style={{fontSize:11,color:"#94a3b8"}}>{u.abbr}{usedNames.has(u.name)?" · has students":""}{configured?" · branded":""}</div>
                </div>
                <Ic n="edit" size={14} c="#94a3b8"/>
              </div>
            );
          })}
        </div>
      </Pad>
      {edit&&<InstitutionEditModal db={db} institution={edit} onClose={()=>setEdit(null)} showToast={showToast}/>}
    </>
  );
}

function AllReportsTab({db}){
  const[view,setView]=useState(null);
  const rows=[...db.submissions].reverse();
  const getStu=id=>db.students.find(s=>s.id===id)||{};
  const getSup=id=>db.supervisors.find(s=>s.id===id)||{};
  const cols=[
    {label:"Student",   render:r=>{const s=getStu(r.studentId);return <span style={{fontWeight:700}}>{s.initials} {s.surname}</span>;}},
    {label:"Number",    render:r=><code style={{fontSize:12}}>{getStu(r.studentId).number}</code>},
    {label:"Supervisor",render:r=>{const st=getStu(r.studentId);const sup=getSup(st.supervisorId);return sup.name?<span style={{fontSize:12,color:"#14532d"}}>{sup.name}</span>:<span style={{color:"#94a3b8",fontSize:12}}>—</span>;}},
    {label:"File",      render:r=><span style={{color:"#64748b",fontSize:12,maxWidth:140,display:"block",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.filename}</span>},
    {label:"Score",     render:r=><span style={{fontWeight:800,color:sc(r.result?.overallScore||0)}}>{r.result?.overallScore??"-"}%</span>},
    {label:"Decision",  render:r=>r.result?.supervisorDecision?<Pill label={r.result.supervisorDecision} bg={sb(r.result.overallScore||0)} color={dc2(r.result.supervisorDecision)}/>:"-"},
    {label:"Date",      render:r=><span style={{color:"#94a3b8",fontSize:12}}>{new Date(r.date).toLocaleDateString("en-ZA")}</span>},
    {label:"",          render:r=><div style={{display:"flex",gap:5}}><button onClick={()=>setView(r)} style={{background:"none",border:"none",cursor:"pointer",color:"#3b82f6"}}><Ic n="eye" size={14}/></button>{r.extendedResult&&<button onClick={()=>setViewExt(r)} style={{background:"#ede9fe",border:"none",borderRadius:6,padding:"3px 7px",cursor:"pointer",color:"#4f46e5",fontSize:11,fontWeight:600}}>Ext</button>}<PdfDownloadButton submission={r} student={getStu(r.studentId)} db={db}/></div>},
  ];
  const[viewExt,setViewExt]=useState(null);
  return(
    <><PageHeader title="All Reports"/>
    <Pad><DataTable cols={cols} rows={rows} empty="No reports submitted yet."/></Pad>
    {view&&<FeedbackModal submission={view} students={db.students} db={db} onClose={()=>setView(null)}/>}
    {viewExt&&<ExtendedFeedbackModal submission={viewExt} students={db.students} db={db} onClose={()=>setViewExt(null)}/>}</>
  );
}

function AllocateTab({db,showToast}){
  // Co-supervisor helpers
  const addCoSup=(stuId,supId)=>{ db.setStudents(prev=>prev.map(s=>s.id===stuId?{...s,coSupervisorIds:[...(s.coSupervisorIds||[]).filter(x=>x!==supId),supId]}:s)); showToast("Co-supervisor added."); };
  const removeCoSup=(stuId,supId)=>{ db.setStudents(prev=>prev.map(s=>s.id===stuId?{...s,coSupervisorIds:(s.coSupervisorIds||[]).filter(x=>x!==supId)}:s)); showToast("Co-supervisor removed."); };
  const[selSup,setSelSup]=useState("");const[search,setSearch]=useState("");const[allocTab,setAllocTab]=useState("primary");
  const sup=db.supervisors.find(s=>s.id===selSup);
  const all=db.students.filter(s=>`${s.surname} ${s.initials} ${s.number}`.toLowerCase().includes(search.toLowerCase()));
  const mine=all.filter(s=>s.supervisorId===selSup);
  const others=all.filter(s=>s.supervisorId!==selSup);
  const assign=stu=>{ db.setStudents(prev=>prev.map(s=>s.id===stu.id?{...s,supervisorId:selSup,requestedSupervisorId:null}:s)); showToast(`${stu.initials} ${stu.surname} assigned.`); };
  const remove=stu=>{ db.setStudents(prev=>prev.map(s=>s.id===stu.id?{...s,supervisorId:null}:s)); showToast(`${stu.initials} ${stu.surname} removed.`); };
  return(
    <><PageHeader title="Student Allocations"/>
    <Pad>
      <div style={{marginBottom:14}}>
        <label style={LS}>Select Supervisor</label>
        <select value={selSup} onChange={e=>setSelSup(e.target.value)} style={{...IS,maxWidth:340}}>
          <option value="">— Choose supervisor —</option>
          {db.supervisors.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
      </div>
      {selSup&&<>
        <div style={{display:"flex",background:"#f1f5f9",borderRadius:10,padding:3,marginBottom:14,gap:2,maxWidth:320}}>
          {[["primary","Primary Supervisor"],["cosup","Co-Supervisor"]].map(([k,l])=>(
            <button key={k} onClick={()=>setAllocTab(k)} style={{flex:1,padding:"6px 0",borderRadius:8,border:"none",fontWeight:600,fontSize:12,cursor:"pointer",background:allocTab===k?"white":"transparent",color:allocTab===k?"#0f172a":"#64748b",boxShadow:allocTab===k?"0 1px 4px rgba(0,0,0,.1)":"none"}}>{l}</button>
          ))}
        </div>
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search students…" style={{...IS,maxWidth:300,marginBottom:14}}/>
        {allocTab==="cosup"&&<CoSupAllocPanel db={db} selSup={selSup} search={search} addCoSup={addCoSup} removeCoSup={removeCoSup}/>}
        {allocTab==="primary"&&<div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
          <div>
            <h3 style={{fontSize:13,fontWeight:700,margin:"0 0 9px",color:"#16a34a"}}>✓ Assigned to {sup?.name} ({mine.length})</h3>
            <div style={{display:"flex",flexDirection:"column",gap:5}}>
              {mine.length===0?<div style={{fontSize:13,color:"#94a3b8"}}>None assigned.</div>:mine.map(s=>(
                <div key={s.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:"#f0fdf4",borderRadius:9,padding:"8px 11px",border:"1px solid #bbf7d0"}}>
                  <div><div style={{fontWeight:700,fontSize:13}}>{s.initials} {s.surname}</div><div style={{fontSize:11,color:"#64748b"}}>{s.number} · {s.level}</div></div>
                  <button onClick={()=>remove(s)} style={{background:"#fee2e2",border:"none",borderRadius:6,padding:"4px 8px",cursor:"pointer",color:"#dc2626",fontSize:12}}>Remove</button>
                </div>
              ))}
            </div>
          </div>
          <div>
            <h3 style={{fontSize:13,fontWeight:700,margin:"0 0 9px",color:"#64748b"}}>Other students ({others.length})</h3>
            <div style={{display:"flex",flexDirection:"column",gap:5}}>
              {others.length===0?<div style={{fontSize:13,color:"#94a3b8"}}>No other students.</div>:others.map(s=>{
                const curSup=db.supervisors.find(x=>x.id===s.supervisorId);
                return(
                  <div key={s.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:"#f8fafc",borderRadius:9,padding:"8px 11px",border:"1px solid #e2e8f0"}}>
                    <div><div style={{fontWeight:700,fontSize:13}}>{s.initials} {s.surname}</div><div style={{fontSize:11,color:"#64748b"}}>{s.number} · {s.level}{curSup?<> · <span style={{color:"#d97706"}}>{curSup.name}</span></>:""}</div></div>
                    <button onClick={()=>assign(s)} style={{background:"#dbeafe",border:"none",borderRadius:6,padding:"4px 8px",cursor:"pointer",color:"#1e40af",fontSize:12}}>Assign</button>
                  </div>
                );
              })}
            </div>
          </div>
        </div>}
      </>}
    </Pad></>
  );
}



function CoSupAllocPanel({db,selSup,search,addCoSup,removeCoSup}){
  const all=db.students.filter(s=>`${s.surname} ${s.initials} ${s.number}`.toLowerCase().includes(search.toLowerCase()));
  const assigned=all.filter(s=>(s.coSupervisorIds||[]).includes(selSup));
  const notAssigned=all.filter(s=>!(s.coSupervisorIds||[]).includes(selSup));
  return(
    <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
      <div>
        <h3 style={{fontSize:13,fontWeight:700,margin:"0 0 9px",color:"#8b5cf6"}}>Co-supervising ({assigned.length})</h3>
        <div style={{display:"flex",flexDirection:"column",gap:5}}>
          {assigned.length===0?<div style={{fontSize:13,color:"#94a3b8"}}>None assigned.</div>:assigned.map(s=>(
            <div key={s.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:"#f5f3ff",borderRadius:9,padding:"8px 11px",border:"1px solid #ddd6fe"}}>
              <div><div style={{fontWeight:700,fontSize:13}}>{s.initials} {s.surname}</div><div style={{fontSize:11,color:"#64748b"}}>{s.number} · {s.level}</div></div>
              <button onClick={()=>removeCoSup(s.id,selSup)} style={{background:"#fee2e2",border:"none",borderRadius:6,padding:"4px 8px",cursor:"pointer",color:"#dc2626",fontSize:12}}>Remove</button>
            </div>
          ))}
        </div>
      </div>
      <div>
        <h3 style={{fontSize:13,fontWeight:700,margin:"0 0 9px",color:"#64748b"}}>Other students ({notAssigned.length})</h3>
        <div style={{display:"flex",flexDirection:"column",gap:5}}>
          {notAssigned.length===0?<div style={{fontSize:13,color:"#94a3b8"}}>No other students.</div>:notAssigned.map(s=>{
            const primarySup=db.supervisors.find(x=>x.id===s.supervisorId);
            return(
              <div key={s.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:"#f8fafc",borderRadius:9,padding:"8px 11px",border:"1px solid #e2e8f0"}}>
                <div><div style={{fontWeight:700,fontSize:13}}>{s.initials} {s.surname}</div><div style={{fontSize:11,color:"#64748b"}}>{s.number}{primarySup?<> · <span style={{color:"#3b82f6"}}>{primarySup.name}</span></>:""}</div></div>
                <button onClick={()=>addCoSup(s.id,selSup)} style={{background:"#ede9fe",border:"none",borderRadius:6,padding:"4px 8px",cursor:"pointer",color:"#5b21b6",fontSize:12}}>Add</button>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}

// ═══════════════════════════════════════════════════════════
// ACCOUNT SETTINGS (shared by admin + supervisor)
// ═══════════════════════════════════════════════════════════

function AccountSettings({role,db,session,showToast}){
  const me=(role==="admin"?db.admins:db.supervisors).find(x=>x.id===session.id)||{};
  const[name,setName]=useState(me.name||"");
  const[username,setUsername]=useState(me.username||"");
  const[email,setEmail]=useState(me.email||"");
  const[pwd,setPwd]=useState({old:"",n1:"",n2:""});
  const[sq,setSq]=useState({q:me.securityQ?.question||SECURITY_QUESTIONS[0],a:""});
  const[errs,setErrs]=useState({});
  const set=role==="admin"?db.setAdmins:db.setSupervisors;
  const all=role==="admin"?db.admins:db.supervisors;

  const saveProfile=()=>{
    if(all.find(x=>x.username===username.trim()&&x.id!==session.id)){setErrs({prof:"Username taken."});return;}
    set(prev=>prev.map(x=>x.id===session.id?{...x,name:name.trim(),username:username.trim(),email:email.trim()}:x));
    setErrs({});showToast("Profile updated.");
  };
  const savePwd=()=>{
    if(pwd.old!==me.password){setErrs({pwd:"Current password incorrect."});return;}
    if(pwd.n1.length<6){setErrs({pwd:"Min 6 chars."});return;}
    if(pwd.n1!==pwd.n2){setErrs({pwd:"Passwords do not match."});return;}
    set(prev=>prev.map(x=>x.id===session.id?{...x,password:pwd.n1}:x));
    setPwd({old:"",n1:"",n2:""});setErrs({});showToast("Password updated.");
  };
  const saveSQ=()=>{
    if(!sq.a.trim()){setErrs({sq:"Enter answer."});return;}
    set(prev=>prev.map(x=>x.id===session.id?{...x,securityQ:{question:sq.q,answer:sq.a.trim().toLowerCase()}}:x));
    setSq(p=>({...p,a:""}));setErrs({});showToast("Security question updated.");
  };

  return(
    <><PageHeader title="My Settings"/>
    <Pad>
      <div style={{maxWidth:500,display:"flex",flexDirection:"column",gap:14}}>
        <div style={{background:"white",borderRadius:13,border:"1px solid #e2e8f0",padding:"1.2rem"}}>
          <h3 style={{margin:"0 0 13px",fontSize:14,fontWeight:700}}>Profile</h3>
          <label style={LS}>Full Name</label><input value={name} onChange={e=>setName(e.target.value)} style={{...IS,marginBottom:9}}/>
          <label style={LS}>Username</label><input value={username} onChange={e=>setUsername(e.target.value)} style={{...IS,marginBottom:9}}/>
          <label style={LS}>Email</label><input value={email} onChange={e=>setEmail(e.target.value)} style={IS}/>
          {errs.prof&&<Err msg={errs.prof}/>}
          <button onClick={saveProfile} style={{...BP,marginTop:11,width:"auto",padding:"8px 17px"}}>Save Profile</button>
        </div>
        <div style={{background:"white",borderRadius:13,border:"1px solid #e2e8f0",padding:"1.2rem"}}>
          <h3 style={{margin:"0 0 13px",fontSize:14,fontWeight:700}}>Change Password</h3>
          <label style={LS}>Current Password</label><PwdInput value={pwd.old} onChange={e=>setPwd(p=>({...p,old:e.target.value}))} placeholder="Current password"/>
          <div style={{marginTop:8}}><label style={LS}>New Password</label><PwdInput value={pwd.n1} onChange={e=>setPwd(p=>({...p,n1:e.target.value}))} placeholder="Min 6 chars"/></div>
          <div style={{marginTop:8}}><label style={LS}>Confirm</label><PwdInput value={pwd.n2} onChange={e=>setPwd(p=>({...p,n2:e.target.value}))} placeholder="Repeat"/></div>
          {errs.pwd&&<Err msg={errs.pwd}/>}
          <button onClick={savePwd} style={{...BP,marginTop:11,width:"auto",padding:"8px 17px"}}>Update Password</button>
        </div>
        <div style={{background:"white",borderRadius:13,border:"1px solid #e2e8f0",padding:"1.2rem"}}>
          <h3 style={{margin:"0 0 10px",fontSize:14,fontWeight:700}}>Security Question</h3>
          {me.securityQ&&<div style={{fontSize:12,color:"#64748b",marginBottom:9}}>Current: <em>{me.securityQ.question}</em></div>}
          <select value={sq.q} onChange={e=>setSq(p=>({...p,q:e.target.value}))} style={{...IS,marginBottom:8}}>{SECURITY_QUESTIONS.map(q=><option key={q}>{q}</option>)}</select>
          <label style={LS}>New Answer</label>
          <input value={sq.a} onChange={e=>setSq(p=>({...p,a:e.target.value}))} placeholder="Your answer" style={IS}/>
          {errs.sq&&<Err msg={errs.sq}/>}
          <button onClick={saveSQ} style={{...BP,marginTop:9,width:"auto",padding:"8px 17px"}}>Update Question</button>
        </div>
      </div>
    </Pad></>
  );
}

// ═══════════════════════════════════════════════════════════
// SUPERVISOR PORTAL
// ═══════════════════════════════════════════════════════════

function SupervisorPortal({db,session,onLogout,showToast}){
  const[view,setView]=useState("dashboard");
  const me=db.supervisors.find(s=>s.id===session.id)||{};
  const myStudents=db.students.filter(s=>s.supervisorId===session.id);
  const coStudents=db.students.filter(s=>s.supervisorId!==session.id&&(s.coSupervisorIds||[]).includes(session.id));
  const allMyIds=new Set([...myStudents.map(s=>s.id),...coStudents.map(s=>s.id)]);
  const myIds=new Set(myStudents.map(s=>s.id));
  const mySubs=db.submissions.filter(s=>allMyIds.has(s.studentId));
  const pending=db.students.filter(s=>s.requestedSupervisorId===session.id&&s.supervisorId!==session.id);

  const nav=[
    {id:"dashboard",icon:"chart",   label:"Dashboard"},
    {id:"students", icon:"users",   label:"My Students"},
    {id:"reports",  icon:"file",    label:"Reports"},
    {id:"settings", icon:"settings",label:"Settings"},
  ];

  return(
    <Shell role="supervisor" nav={nav} active={view} setActive={setView} onLogout={onLogout} badge={me.name}>
      {view==="dashboard"&&<SupDashboard db={db} myStudents={myStudents} coStudents={coStudents} mySubs={mySubs}/>}
      {view==="students" &&<SupStudents  db={db} session={session} myStudents={myStudents} coStudents={coStudents} pending={pending} showToast={showToast}/>}
      {view==="reports"  &&<SupReports  db={db} myStudents={[...myStudents,...coStudents]} mySubs={mySubs}/>}
      {view==="settings" &&<AccountSettings role="supervisor" db={db} session={session} showToast={showToast}/>}
    </Shell>
  );
}

function SupDashboard({db,myStudents,coStudents,mySubs}){
  const avg=mySubs.length?Math.round(mySubs.reduce((a,s)=>a+(s.result?.overallScore||0),0)/mySubs.length):0;
  const approved=mySubs.filter(s=>s.result?.supervisorDecision==="APPROVED").length;
  return(
    <><PageHeader title="Dashboard"/>
    <Pad>
      <StatCards cards={[
        {label:"My Students",value:myStudents.length, icon:"users",color:"#3b82f6"},
        {label:"Co-Supervised",value:(coStudents||[]).length,icon:"users",color:"#8b5cf6"},
        {label:"Reports",    value:mySubs.length,     icon:"file", color:"#8b5cf6"},
        {label:"Approved",   value:approved,          icon:"check",color:"#16a34a"},
        {label:"Avg Score",  value:avg+"%",           icon:"chart",color:"#d97706"},
      ]}/>
      <RecentReports db={db} submissions={mySubs} students={myStudents}/>
    </Pad></>
  );
}

function SupStudents({db,session,myStudents,coStudents,pending,showToast}){
  const[showAdd,setShowAdd]=useState(false);const[edit,setEdit]=useState(null);const[showPending,setShowPending]=useState(false);const[submitFor,setSubmitFor]=useState(null);
  const approve=s=>{db.setStudents(prev=>prev.map(st=>st.id===s.id?{...st,supervisorId:session.id,requestedSupervisorId:null}:st));showToast(`${s.initials} ${s.surname} approved.`);};
  const decline=s=>{db.setStudents(prev=>prev.map(st=>st.id===s.id?{...st,requestedSupervisorId:null}:st));showToast(`${s.initials} ${s.surname} declined.`,"error");};
  const remove=s=>{if(!window.confirm(`Remove ${s.initials} ${s.surname}?`))return;db.setStudents(prev=>prev.map(st=>st.id===s.id?{...st,supervisorId:null}:st));showToast("Student removed.");};
  const cols=[
    {label:"Student",render:r=><span style={{fontWeight:700}}>{r.initials} {r.surname}</span>},
    {label:"Number", render:r=><code style={{fontSize:12}}>{r.number}</code>},
    {label:"Level",  render:r=><Pill label={r.level} bg="#dbeafe" color="#1e40af"/>},
    {label:"Field",  render:r=>(r.fields||[]).slice(0,1).join("")||"—"},
    {label:"Reports",render:r=>db.submissions.filter(s=>s.studentId===r.id).length},
    {label:"",       render:r=><div style={{display:"flex",gap:5}}>
      <button onClick={()=>setEdit(r)} style={{background:"#eff6ff",border:"none",borderRadius:6,padding:"4px 7px",cursor:"pointer",color:"#3b82f6"}}><Ic n="edit" size={13}/></button>
      <button onClick={()=>setSubmitFor(r)} title="Submit on behalf of student" style={{background:"#f0fdf4",border:"none",borderRadius:6,padding:"4px 7px",cursor:"pointer",color:"#16a34a"}}><Ic n="upload" size={13}/></button>
      <button onClick={()=>remove(r)} style={{background:"#fee2e2",border:"none",borderRadius:6,padding:"4px 7px",cursor:"pointer",color:"#dc2626"}}><Ic n="trash" size={13}/></button>
    </div>},
  ];
  return(
    <>
      <PageHeader title="My Students" action={
        <div style={{display:"flex",gap:7}}>
          {pending.length>0&&<button onClick={()=>setShowPending(true)} style={{...BP,background:"linear-gradient(135deg,#d97706,#b45309)",width:"auto",padding:"7px 13px",fontSize:13,display:"flex",alignItems:"center",gap:5}}><Ic n="bell" size={14} c="white"/> Requests ({pending.length})</button>}
          <button onClick={()=>setShowAdd(true)} style={{...BP,width:"auto",padding:"7px 13px",fontSize:13,display:"flex",alignItems:"center",gap:5}}><Ic n="plus" size={14} c="white"/> Add Student</button>
        </div>
      }/>
      <Pad><DataTable cols={cols} rows={myStudents} empty="No students assigned to you yet."/></Pad>
      {showAdd&&<StudentFormModal db={db} supervisorId={session.id} onClose={()=>setShowAdd(false)} showToast={showToast}/>}
      {(coStudents||[]).length>0&&(
        <Pad>
          <h3 style={{fontSize:14,fontWeight:700,margin:"0 0 10px",color:"#8b5cf6"}}>Co-Supervised Students ({coStudents.length})</h3>
          <DataTable cols={[
            {label:"Student", render:r=><span style={{fontWeight:700}}>{r.initials} {r.surname}</span>},
            {label:"Number",  render:r=><code style={{fontSize:12}}>{r.number}</code>},
            {label:"Level",   render:r=><Pill label={r.level} bg="#ede9fe" color="#5b21b6"/>},
            {label:"Primary Supervisor", render:r=>{const s=db.supervisors.find(x=>x.id===r.supervisorId);return s?<span style={{fontSize:12}}>{s.name}</span>:<span style={{color:"#94a3b8",fontSize:12}}>None</span>;}},
            {label:"Reports", render:r=>db.submissions.filter(s=>s.studentId===r.id).length},
            {label:"",        render:r=><button onClick={()=>setSubmitFor(r)} title="Submit on behalf of student" style={{background:"#f0fdf4",border:"none",borderRadius:6,padding:"4px 7px",cursor:"pointer",color:"#16a34a"}}><Ic n="upload" size={13}/></button>},
          ]} rows={coStudents} empty="No co-supervised students."/>
        </Pad>
      )}
      {edit&&<StudentFormModal db={db} existing={edit} onClose={()=>setEdit(null)} showToast={showToast}/>}
      {submitFor&&<SupSubmitModal db={db} student={submitFor} onClose={()=>setSubmitFor(null)} showToast={showToast} actor={myStudents.some(s=>s.id===submitFor.id)?undefined:{role:"cosupervisor",name:db.supervisors.find(s=>s.id===session.id)?.name}}/>}
      {showPending&&(
        <Modal title={`Student Requests (${pending.length})`} onClose={()=>setShowPending(false)}>
          {pending.length===0?<p style={{color:"#94a3b8",fontSize:13}}>No pending requests.</p>:pending.map(s=>(
            <div key={s.id} style={{display:"flex",alignItems:"center",justifyContent:"space-between",background:"#fffbeb",borderRadius:9,padding:"9px 12px",border:"1px solid #fde68a",marginBottom:7}}>
              <div><div style={{fontWeight:700,fontSize:13}}>{s.initials} {s.surname}</div><div style={{fontSize:12,color:"#64748b"}}>{s.number} · {s.level} · {(s.fields||[]).slice(0,1).join("")}</div></div>
              <div style={{display:"flex",gap:6}}>
                <button onClick={()=>approve(s)} style={{background:"#dcfce7",border:"none",borderRadius:7,padding:"5px 10px",cursor:"pointer",color:"#14532d",fontWeight:600,fontSize:12}}>Approve</button>
                <button onClick={()=>decline(s)} style={{background:"#fee2e2",border:"none",borderRadius:7,padding:"5px 10px",cursor:"pointer",color:"#dc2626",fontWeight:600,fontSize:12}}>Decline</button>
              </div>
            </div>
          ))}
        </Modal>
      )}
    </>
  );
}

function SupReports({db,myStudents,mySubs}){
  const[view,setView]=useState(null);const[viewExt,setViewExt]=useState(null);
  const getStu=id=>myStudents.find(s=>s.id===id)||db.students.find(s=>s.id===id)||{};
  const rows=[...mySubs].reverse();
  const cols=[
    {label:"Student", render:r=>{const s=getStu(r.studentId);return <span style={{fontWeight:700}}>{s.initials} {s.surname}</span>;}},
    {label:"File",    render:r=><span style={{color:"#64748b",fontSize:12,maxWidth:140,display:"block",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.filename}</span>},
    {label:"Score",   render:r=><span style={{fontWeight:800,color:sc(r.result?.overallScore||0)}}>{r.result?.overallScore??"-"}%</span>},
    {label:"Decision",render:r=>r.result?.supervisorDecision?<Pill label={r.result.supervisorDecision} bg={sb(r.result.overallScore||0)} color={dc2(r.result.supervisorDecision)}/>:"-"},
    {label:"Date",    render:r=><span style={{color:"#94a3b8",fontSize:12}}>{new Date(r.date).toLocaleDateString("en-ZA")}</span>},
    {label:"",        render:r=><div style={{display:"flex",gap:5}}><button onClick={()=>setView(r)} style={{background:"none",border:"none",cursor:"pointer",color:"#3b82f6"}}><Ic n="eye" size={14}/></button>{r.extendedResult&&<button onClick={()=>setViewExt(r)} style={{background:"#ede9fe",border:"none",borderRadius:6,padding:"3px 7px",cursor:"pointer",color:"#4f46e5",fontSize:11,fontWeight:600}}>Ext</button>}<PdfDownloadButton submission={r} student={getStu(r.studentId)} db={db}/></div>},
  ];
  return(
    <><PageHeader title="Student Reports"/>
    <Pad><DataTable cols={cols} rows={rows} empty="No reports from your students yet."/></Pad>
    {view&&<FeedbackModal submission={view} students={[...myStudents,...db.students]} db={db} onClose={()=>setView(null)}/>}
    {viewExt&&<ExtendedFeedbackModal submission={viewExt} students={[...myStudents,...db.students]} db={db} onClose={()=>setViewExt(null)}/>}</>
  );
}


// ═══════════════════════════════════════════════════════════
// STUDENT PORTAL
// ═══════════════════════════════════════════════════════════

function StudentPortal({db,session,onLogout,showToast}){
  const stu=db.students.find(s=>s.id===session.id)||{};
  const[view,setView]=useState("submit");
  const[needsSetup,setNeedsSetup]=useState(!stu.password||!stu.securityQ);
  const[needsSup,setNeedsSup]=useState(!stu.supervisorId&&!stu.requestedSupervisorId);
  const fileRef=useRef();
  const[file,setFile]=useState(null);const[text,setText]=useState("");
  const[loading,setLoading]=useState(false);const[loadingExt,setLoadingExt]=useState(false);
  const[error,setError]=useState("");const[citStyle,setCitStyle]=useState("apa");
  const[docType,setDocType]=useState("full");const[chapters,setChapters]=useState([]);const[chapterByChapter,setChapterByChapter]=useState(false);const[customChapters,setCustomChapters]=useState("");
  const[viewSub,setViewSub]=useState(null);const[viewExtSub,setViewExtSub]=useState(null);

  const mySubs=db.submissions.filter(s=>s.studentId===stu.id);
  const sup=db.supervisors.find(s=>s.id===stu.supervisorId);
  const reqSup=db.supervisors.find(s=>s.id===stu.requestedSupervisorId);
  const sl=STRICTNESS.find(l=>l.id===(stu.strictness||"strict"));

  const handleFile=async f=>{
    if(!f)return;setFile(f);setError("");setText("");
    const ext=f.name.split(".").pop().toLowerCase();
    try{
      let extracted="";
      if(ext==="docx"||ext==="doc"){
        const buf=await f.arrayBuffer();
        const res=await mammoth.extractRawText({arrayBuffer:buf});
        extracted=res.value||"";
      } else if(ext==="pdf"){
        extracted=await extractPdfText(f);
      } else {
        extracted=await new Promise((res,rej)=>{const r=new FileReader();r.onload=e=>res(e.target.result||"");r.onerror=rej;r.readAsText(f);});
      }
      setText(extracted);
      if(extracted.length>139000) setError("⚠ Very large document ("+Math.round(extracted.length/1000)+"KB text). It will be analysed in sections, but only the first ~139,000 characters will be covered. Submit individual chapters for full coverage.");
      else if(extracted.length<100) setError("⚠ Could not extract text from this file. Try converting to .docx or .txt first.");
    }catch(e){setError("Could not read file: "+e.message);}
  };
  const[progress,setProgress]=useState("");
  const handleSubmit=async(extended=false)=>{
    if(!text.trim())return setError("Upload a document first.");
    const allChapters=[...chapters,...customChapters.split(",").map(c=>c.trim()).filter(Boolean)];
    if(docType==="wip"&&allChapters.length===0)return setError("Select at least one chapter that's ready for review.");
    extended?setLoadingExt(true):setLoading(true);setError("");setProgress("");
    try{
      const notes=(sup?`Supervisor: ${sup.name}. `:"")+( stu.extraPrompt||"");
      const docContext={documentType:docType,chapters:allChapters,chapterByChapter};
      const {result,extendedResult,chunked,chunksUsed,chunksFailed,charsAnalysed,totalChars}=await analyzeSubmission(text,stu,notes,{extended,citationStyle:citStyle,onProgress:setProgress,docContext});
      const sub={id:"sub_"+uid(),studentId:stu.id,filename:file?.name||"Document",date:new Date().toISOString(),result,chunked,chunksUsed,chunksFailed,charsAnalysed,totalChars,documentType:docType,chaptersReviewed:docType==="wip"?allChapters:null,chapterByChapter:docType==="full"?chapterByChapter:false,...(extendedResult?{extendedResult,citationStyle:citStyle}:{})};
      db.setSubmissions(prev=>[...prev,sub]);
      extended?setViewExtSub(sub):setViewSub(sub);
      setFile(null);setText("");
      showToast(extended?"Extended analysis complete!":"Analysis complete!");
    }catch(e){setError("Analysis failed: "+(e.message||"Please try again."));}
    setLoading(false);setLoadingExt(false);
  };

  if(needsSetup) return <StudentFirstSetup stu={stu} db={db} onDone={()=>{setNeedsSetup(false);showToast("Account set up. Welcome!");}}/>;
  if(needsSup)   return <SupSelectScreen stu={stu} db={db} onDone={()=>{setNeedsSup(false);showToast("Request sent to supervisor.");}} onSkip={()=>setNeedsSup(false)}/>;

  return(
    <div style={{minHeight:"100vh",background:"#f8fafc",fontFamily:"system-ui,sans-serif"}}>
      <div style={{background:"#0f172a",padding:".9rem 1.5rem",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:32,height:32,borderRadius:9,background:"#8b5cf6",display:"flex",alignItems:"center",justifyContent:"center"}}><Ic n="award" size={17} c="white"/></div>
          <div><div style={{color:"white",fontWeight:700,fontSize:14}}>AcademiQ Analyser</div><div style={{color:"rgba(255,255,255,.4)",fontSize:11}}>{stu.initials} {stu.surname} · {stu.number}{stu.institution?` · ${stu.institution}`:""}</div></div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
          {sup?<span style={{background:"rgba(139,92,246,.25)",color:"#c4b5fd",padding:"3px 9px",borderRadius:99,fontSize:11,fontWeight:600}}>{stu.level} · {sup.name}</span>:reqSup?<span style={{background:"rgba(217,119,6,.2)",color:"#fcd34d",padding:"3px 9px",borderRadius:99,fontSize:11}}>Pending: {reqSup.name}</span>:null}
          {(stu.coSupervisorIds||[]).length>0&&<span style={{background:"rgba(139,92,246,.15)",color:"#a78bfa",padding:"3px 9px",borderRadius:99,fontSize:11}}>+{stu.coSupervisorIds.length} co-sup</span>}
          {[["submit","Submit"],["history","My Reports"],["account","Account"]].map(([v,l])=><button key={v} onClick={()=>setView(v)} style={{background:view===v?"rgba(139,92,246,.25)":"rgba(255,255,255,.06)",border:"none",borderRadius:7,padding:"5px 10px",color:view===v?"#c4b5fd":"rgba(255,255,255,.45)",cursor:"pointer",fontSize:12,fontWeight:view===v?600:400}}>{l}</button>)}
          <button onClick={onLogout} style={{background:"rgba(255,255,255,.06)",border:"none",borderRadius:7,padding:"5px 9px",color:"rgba(255,255,255,.35)",cursor:"pointer",fontSize:12,display:"flex",alignItems:"center",gap:4}}><Ic n="logout" size={13} c="rgba(255,255,255,.35)"/>Out</button>
        </div>
      </div>

      <div style={{maxWidth:820,margin:"0 auto",padding:"1.5rem 1rem"}}>
        {view==="submit"&&(
          <div style={{background:"white",borderRadius:16,border:"1px solid #e2e8f0",padding:"1.75rem"}}>
            <h2 style={{fontSize:16,fontWeight:700,marginBottom:4}}>Submit Your Project</h2>
            <p style={{fontSize:13,color:"#64748b",marginBottom:16}}>Upload your project document for AI-powered analysis.</p>
            <DocTypeSelector docType={docType} setDocType={setDocType} chapters={chapters} setChapters={setChapters} chapterByChapter={chapterByChapter} setChapterByChapter={setChapterByChapter} customChapters={customChapters} setCustomChapters={setCustomChapters}/>
            <div style={{marginBottom:13}}>
              <label style={LS}>Citation Style Used in Your Document</label>
              <select value={citStyle} onChange={e=>setCitStyle(e.target.value)} style={IS}>
                {CITATION_STYLES.map(s=><option key={s.id} value={s.id}>{s.label}</option>)}
              </select>
            </div>
            <div style={{background:"#f8fafc",borderRadius:10,padding:"10px 13px",marginBottom:16,display:"flex",gap:11,alignItems:"flex-start"}}>
              <div style={{width:32,height:32,borderRadius:8,background:(sl?.color||"#d97706")+"20",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0}}><Ic n="settings" size={15} c={sl?.color||"#d97706"}/></div>
              <div><div style={{fontSize:13,fontWeight:700}}><span style={{color:sl?.color||"#d97706"}}>{sl?.label}</span> analyser</div><div style={{fontSize:12,color:"#64748b"}}>{sl?.desc}</div>{(stu.fields||[]).length>0&&<div style={{fontSize:11,color:"#94a3b8",marginTop:3}}>{stu.fields.join(" · ")}</div>}</div>
            </div>
            <div onClick={()=>fileRef.current?.click()} onDragOver={e=>e.preventDefault()} onDrop={e=>{e.preventDefault();handleFile(e.dataTransfer.files[0]);}} style={{border:`2px dashed ${file?"#8b5cf6":"#cbd5e1"}`,borderRadius:12,padding:"2rem",textAlign:"center",cursor:"pointer",background:file?"#f5f3ff":"#fafafa",transition:"all .2s"}}>
              <input ref={fileRef} type="file" accept=".txt,.md,.pdf,.docx,.doc" style={{display:"none"}} onChange={e=>handleFile(e.target.files[0])}/>
              <Ic n="upload" size={28} c={file?"#8b5cf6":"#94a3b8"}/>
              <div style={{marginTop:9,fontWeight:600,color:file?"#5b21b6":"#374151",fontSize:14}}>{file?file.name:"Drop your document here or click to browse"}</div>
              <div style={{fontSize:12,color:"#94a3b8",marginTop:3}}>{file?`${(file.size/1024).toFixed(1)} KB`:"Supported: .txt .md .pdf .docx"}</div>
            </div>
            {progress&&(loading||loadingExt)&&<div style={{background:"#eff6ff",color:"#1e40af",borderRadius:8,padding:"9px 13px",fontSize:13,marginTop:11,display:"flex",alignItems:"center",gap:8}}><div style={{animation:"spin 1s linear infinite",display:"inline-flex"}}><Ic n="spin" size={14} c="#3b82f6"/></div>{progress}</div>}
            {error&&!loading&&!loadingExt&&<div style={{background:"#fee2e2",color:"#991b1b",borderRadius:8,padding:"9px 13px",fontSize:13,marginTop:11}}>{error}</div>}
            <div style={{display:"flex",gap:8,marginTop:13}}>
              <button onClick={()=>handleSubmit(false)} disabled={!text||loading||loadingExt} style={{...BP,flex:1,background:"linear-gradient(135deg,#8b5cf6,#7c3aed)",display:"flex",alignItems:"center",justifyContent:"center",gap:6,opacity:(!text||loading||loadingExt)?0.6:1,cursor:(!text||loading||loadingExt)?"not-allowed":"pointer"}}>
                {loading?<><div style={{animation:"spin 1s linear infinite",display:"inline-flex"}}><Ic n="spin" size={14} c="white"/></div>Analysing…</>:<><Ic n="chart" size={14} c="white"/>Standard Analysis</>}
              </button>
              <button onClick={()=>handleSubmit(true)} disabled={!text||loading||loadingExt} style={{...BP,flex:1,background:"linear-gradient(135deg,#4f46e5,#3730a3)",display:"flex",alignItems:"center",justifyContent:"center",gap:6,opacity:(!text||loading||loadingExt)?0.6:1,cursor:(!text||loading||loadingExt)?"not-allowed":"pointer"}}>
                {loadingExt?<><div style={{animation:"spin 1s linear infinite",display:"inline-flex"}}><Ic n="spin" size={14} c="white"/></div>Extended…</>:<><Ic n="award" size={14} c="white"/>+ Extended Review</>}
              </button>
            </div>
            <p style={{fontSize:11,color:"#94a3b8",marginTop:6}}>Extended Review adds language, citation verification, AI detection and literature review analysis.</p>
          </div>
        )}

        {view==="history"&&(
          <div style={{background:"white",borderRadius:16,border:"1px solid #e2e8f0",overflow:"hidden"}}>
            <div style={{padding:".8rem 1.2rem",borderBottom:"1px solid #f1f5f9"}}><h3 style={{margin:0,fontSize:14,fontWeight:700}}>My Reports</h3></div>
            {mySubs.length===0?<div style={{padding:"2.5rem",textAlign:"center",color:"#94a3b8",fontSize:13}}>No reports submitted yet.</div>:(
              [...mySubs].reverse().map(sub=>(
                <div key={sub.id} style={{padding:"12px 17px",borderBottom:"1px solid #f8fafc",display:"flex",alignItems:"center",gap:13}}>
                  <Ic n="file" size={18} c="#8b5cf6"/>
                  <Ic n="file" size={18} c="#8b5cf6"/>
                  <div style={{flex:1,cursor:"pointer"}} onClick={()=>setViewSub(sub)}><div style={{fontWeight:600,fontSize:14}}>{sub.filename}{sub.submittedBy==="supervisor"&&<span style={{fontSize:10,background:"#dbeafe",color:"#1e40af",padding:"1px 6px",borderRadius:99,marginLeft:6,fontWeight:600}}>by supervisor</span>}</div><div style={{fontSize:12,color:"#94a3b8"}}>{new Date(sub.date).toLocaleDateString("en-ZA",{weekday:"short",year:"numeric",month:"short",day:"numeric"})}</div></div>
                  <div style={{textAlign:"right"}}><div style={{fontSize:19,fontWeight:800,color:sc(sub.result?.overallScore||0)}}>{sub.result?.overallScore??"-"}%</div>{sub.result?.supervisorDecision&&<div style={{fontSize:11,color:dc2(sub.result.supervisorDecision),fontWeight:600}}>{sub.result.supervisorDecision}</div>}</div>
                  {sub.extendedResult&&<button onClick={()=>setViewExtSub(sub)} style={{background:"linear-gradient(135deg,#4f46e5,#3730a3)",border:"none",borderRadius:7,padding:"5px 9px",cursor:"pointer",color:"white",fontSize:11,fontWeight:600,whiteSpace:"nowrap"}}>Extended ↗</button>}
                  <Ic n="chevron" size={14} c="#cbd5e1"/>
                </div>
              ))
            )}
          </div>
        )}

        {view==="account"&&<StudentAccountPage stu={stu} db={db} showToast={showToast}/>}
      </div>

      {viewSub&&<FeedbackModal submission={viewSub} students={db.students} db={db} onClose={()=>setViewSub(null)}/>}
      {viewExtSub&&<ExtendedFeedbackModal submission={viewExtSub} students={db.students} db={db} onClose={()=>setViewExtSub(null)}/>}
      <style>{"@keyframes spin{from{transform:rotate(0deg)}to{transform:rotate(360deg)}}"}</style>
    </div>
  );
}

function StudentFirstSetup({stu,db,onDone}){
  const[pwd,setPwd]=useState("");const[conf,setConf]=useState("");
  const[sqQ,setSqQ]=useState(SECURITY_QUESTIONS[0]);const[sqA,setSqA]=useState("");
  const[err,setErr]=useState("");
  const save=()=>{
    setErr("");
    if(!pwd)return setErr("Choose a password.");
    if(pwd.length<4)return setErr("Min 4 characters.");
    if(pwd!==conf)return setErr("Passwords do not match.");
    if(!sqA.trim())return setErr("Enter a security answer.");
    db.setStudents(prev=>prev.map(s=>s.id===stu.id?{...s,password:pwd,securityQ:{question:sqQ,answer:sqA.trim().toLowerCase()}}:s));
    onDone();
  };
  return(
    <div style={{minHeight:"100vh",background:"linear-gradient(135deg,#0f172a,#4c1d95,#0f172a)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"system-ui,sans-serif",padding:"1rem"}}>
      <div style={{background:"white",borderRadius:20,padding:"2rem",width:"100%",maxWidth:420,boxShadow:"0 25px 60px rgba(0,0,0,.4)"}}>
        <div style={{textAlign:"center",marginBottom:16}}>
          <div style={{width:44,height:44,borderRadius:13,background:"#8b5cf6",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 9px"}}><Ic n="award" size={22} c="white"/></div>
          <h2 style={{margin:0,fontSize:18,fontWeight:800}}>Welcome, {stu.initials} {stu.surname}</h2>
          <p style={{fontSize:13,color:"#64748b",margin:"5px 0 0"}}>Set your password to complete account setup.</p>
        </div>
        <label style={LS}>Choose a Password</label><PwdInput value={pwd} onChange={e=>setPwd(e.target.value)} placeholder="Min 4 characters"/>
        <div style={{marginTop:8}}><label style={LS}>Confirm</label><PwdInput value={conf} onChange={e=>setConf(e.target.value)} placeholder="Repeat"/></div>
        <div style={{marginTop:14,borderTop:"1px solid #f1f5f9",paddingTop:13}}>
          <p style={{fontSize:12,color:"#64748b",margin:"0 0 8px"}}>Security question — used if you forget your password.</p>
          <select value={sqQ} onChange={e=>setSqQ(e.target.value)} style={{...IS,marginBottom:7}}>{SECURITY_QUESTIONS.map(q=><option key={q}>{q}</option>)}</select>
          <label style={LS}>Answer</label><input value={sqA} onChange={e=>setSqA(e.target.value)} placeholder="Your answer" style={IS}/>
        </div>
        <Err msg={err}/>
        <button onClick={save} style={{...BP,marginTop:13,background:"linear-gradient(135deg,#8b5cf6,#7c3aed)"}}>Complete Setup</button>
      </div>
    </div>
  );
}

function SupSelectScreen({stu,db,onDone,onSkip}){
  const[sel,setSel]=useState("");const[err,setErr]=useState("");
  const request=()=>{
    if(!sel)return setErr("Select a supervisor.");
    db.setStudents(prev=>prev.map(s=>s.id===stu.id?{...s,requestedSupervisorId:sel}:s));
    onDone();
  };
  return(
    <div style={{minHeight:"100vh",background:"linear-gradient(135deg,#0f172a,#4c1d95,#0f172a)",display:"flex",alignItems:"center",justifyContent:"center",fontFamily:"system-ui,sans-serif",padding:"1rem"}}>
      <div style={{background:"white",borderRadius:20,padding:"2rem",width:"100%",maxWidth:440,boxShadow:"0 25px 60px rgba(0,0,0,.4)"}}>
        <div style={{textAlign:"center",marginBottom:16}}>
          <div style={{width:44,height:44,borderRadius:13,background:"#8b5cf6",display:"flex",alignItems:"center",justifyContent:"center",margin:"0 auto 9px"}}><Ic n="users" size={22} c="white"/></div>
          <h2 style={{margin:0,fontSize:18,fontWeight:800}}>Select Your Supervisor</h2>
          <p style={{fontSize:13,color:"#64748b",margin:"5px 0 0"}}>Your selected supervisor will need to approve your request.</p>
        </div>
        {db.supervisors.length===0?<p style={{fontSize:13,color:"#94a3b8",textAlign:"center"}}>No supervisors registered yet.</p>:(
          <div style={{display:"flex",flexDirection:"column",gap:7,marginBottom:13}}>
            {db.supervisors.map(s=>(
              <div key={s.id} onClick={()=>setSel(s.id)} style={{display:"flex",alignItems:"center",gap:10,padding:"10px 12px",borderRadius:10,border:`2px solid ${sel===s.id?"#8b5cf6":"#e2e8f0"}`,cursor:"pointer",background:sel===s.id?"#f5f3ff":"white"}}>
                <div style={{width:34,height:34,borderRadius:99,background:"#8b5cf6",display:"flex",alignItems:"center",justifyContent:"center",flexShrink:0,fontSize:13,fontWeight:700,color:"white"}}>{s.name[0]}</div>
                <div><div style={{fontWeight:700,fontSize:14}}>{s.name}</div><div style={{fontSize:12,color:"#64748b"}}>{s.email||"Supervisor"}</div></div>
                {sel===s.id&&<div style={{marginLeft:"auto"}}><Ic n="check" size={17} c="#8b5cf6"/></div>}
              </div>
            ))}
          </div>
        )}
        <Err msg={err}/>
        <button onClick={request} style={{...BP,background:"linear-gradient(135deg,#8b5cf6,#7c3aed)"}}>Send Request</button>
        <button onClick={onSkip} style={{...BS,marginTop:8}}>Skip for now</button>
      </div>
    </div>
  );
}

function StudentAccountPage({stu,db,showToast}){
  const[pwd,setPwd]=useState({old:"",n1:"",n2:""});
  const[sq,setSq]=useState({q:stu.securityQ?.question||SECURITY_QUESTIONS[0],a:""});
  const[showChangeSup,setShowChangeSup]=useState(false);
  const[errs,setErrs]=useState({});
  const sup=db.supervisors.find(s=>s.id===stu.supervisorId);
  const reqSup=db.supervisors.find(s=>s.id===stu.requestedSupervisorId);

  const savePwd=()=>{
    if(pwd.old!==stu.password){setErrs({pwd:"Current password incorrect."});return;}
    if(pwd.n1.length<4){setErrs({pwd:"Min 4 chars."});return;}
    if(pwd.n1!==pwd.n2){setErrs({pwd:"Mismatch."});return;}
    db.setStudents(prev=>prev.map(s=>s.id===stu.id?{...s,password:pwd.n1}:s));
    setPwd({old:"",n1:"",n2:""});setErrs({});showToast("Password updated.");
  };
  const saveSQ=()=>{
    if(!sq.a.trim()){setErrs({sq:"Enter answer."});return;}
    db.setStudents(prev=>prev.map(s=>s.id===stu.id?{...s,securityQ:{question:sq.q,answer:sq.a.trim().toLowerCase()}}:s));
    setSq(p=>({...p,a:""}));setErrs({});showToast("Security question updated.");
  };

  return(
    <div style={{maxWidth:500}}>
      <div style={{background:"white",borderRadius:13,border:"1px solid #e2e8f0",padding:"1.2rem",marginBottom:13}}>
        <h3 style={{margin:"0 0 11px",fontSize:14,fontWeight:700}}>Account Details</h3>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:9}}>
          {[["Name",`${stu.initials} ${stu.surname}`],["Number",stu.number],["Institution",stu.institution||"—"],["Level",stu.level],["Supervisor",sup?.name||(reqSup?`Pending: ${reqSup.name}`:"None")],["Co-Supervisors",(stu.coSupervisorIds||[]).map(id=>db.supervisors.find(s=>s.id===id)?.name).filter(Boolean).join(", ")||"None"]].map(([k,v])=>(
            <div key={k} style={{background:"#f8fafc",borderRadius:8,padding:"8px 10px"}}>
              <div style={{fontSize:11,color:"#94a3b8",fontWeight:600,marginBottom:2}}>{k}</div>
              <div style={{fontWeight:700,fontSize:13}}>{v}</div>
            </div>
          ))}
        </div>
        <button onClick={()=>setShowChangeSup(true)} style={{...BS,marginTop:11,fontSize:12,padding:"6px 13px",width:"auto"}}>Change Supervisor</button>
      </div>
      <div style={{background:"white",borderRadius:13,border:"1px solid #e2e8f0",padding:"1.2rem",marginBottom:13}}>
        <h3 style={{margin:"0 0 12px",fontSize:14,fontWeight:700}}>Change Password</h3>
        <PwdInput value={pwd.old} onChange={e=>setPwd(p=>({...p,old:e.target.value}))} placeholder="Current password"/>
        <div style={{marginTop:8}}><PwdInput value={pwd.n1} onChange={e=>setPwd(p=>({...p,n1:e.target.value}))} placeholder="New password (min 4)"/></div>
        <div style={{marginTop:8}}><PwdInput value={pwd.n2} onChange={e=>setPwd(p=>({...p,n2:e.target.value}))} placeholder="Confirm"/></div>
        {errs.pwd&&<Err msg={errs.pwd}/>}
        <button onClick={savePwd} style={{...BP,marginTop:11,width:"auto",padding:"8px 17px"}}>Update Password</button>
      </div>
      <div style={{background:"white",borderRadius:13,border:"1px solid #e2e8f0",padding:"1.2rem"}}>
        <h3 style={{margin:"0 0 10px",fontSize:14,fontWeight:700}}>Security Question</h3>
        {stu.securityQ&&<div style={{fontSize:12,color:"#64748b",marginBottom:9}}>Current: <em>{stu.securityQ.question}</em></div>}
        <select value={sq.q} onChange={e=>setSq(p=>({...p,q:e.target.value}))} style={{...IS,marginBottom:7}}>{SECURITY_QUESTIONS.map(q=><option key={q}>{q}</option>)}</select>
        <label style={LS}>Answer</label><input value={sq.a} onChange={e=>setSq(p=>({...p,a:e.target.value}))} placeholder="New answer" style={IS}/>
        {errs.sq&&<Err msg={errs.sq}/>}
        <button onClick={saveSQ} style={{...BP,marginTop:9,width:"auto",padding:"8px 17px"}}>Update</button>
      </div>
      {showChangeSup&&<SupSelectScreen stu={stu} db={db} onDone={()=>{setShowChangeSup(false);showToast("Request sent.");}} onSkip={()=>setShowChangeSup(false)}/>}
    </div>
  );
}
