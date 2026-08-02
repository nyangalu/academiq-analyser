import { useState, useRef, useCallback, useEffect } from "react";
import React from "react";
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-app.js";
import { getDatabase, ref, onValue, set, update, remove, get } from "https://www.gstatic.com/firebasejs/10.12.0/firebase-database.js";

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
// CLAUDE API
// ═══════════════════════════════════════════════════════════════════════

async function analyzeDoc(text, student, supNotes) {
  const sys = STRICTNESS_PROMPTS[student.strictness || "strict"];
  const fields = (student.fields || []).join(", ") || "Engineering";
  const lvMap = {Diploma:"National Diploma","Advanced Diploma":"Advanced Diploma",PGDip:"Postgraduate Diploma",BEng:"Bachelor of Engineering",MEng:"Master of Engineering",PhD:"Doctor of Philosophy"};
  const level = lvMap[student.level] || student.level;
  const prompt = `Analyse this ${level} engineering project in ${fields} for ${student.initials} ${student.surname} (${student.number}) at a South African university.
${student.rubric ? `\nRUBRIC:\n${student.rubric}\n` : ""}
${supNotes ? `\nSUPERVISOR NOTES:\n${supNotes}\n` : ""}
PROJECT TEXT:
---
${text.slice(0, 28000)}
---
Return ONLY valid JSON:
{"overallScore":<0-100>,"overallGrade":"<F|D|C|B|A|A+>","overallVerdict":"<2-3 sentences>","supervisorDecision":"<APPROVED|MINOR REVISIONS|MAJOR REVISIONS|NOT APPROVED>","sections":[{"name":"<n>","score":<0-100>,"grade":"<F|D|C|B|A>","strengths":["<s>"],"weaknesses":["<w>"],"supervisorInstruction":"<inst>"}],"criticalIssues":["<i>"],"positives":["<p>"],"priorityActions":[{"priority":"Critical|Serious|Important|Minor","action":"<a>"}],"disciplinaryAssessment":"<para>","ecsa_ga_notes":"<para>"}`;
  const r = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model: "claude-sonnet-4-6", max_tokens: 4000, system: sys, messages: [{ role: "user", content: prompt }] }),
  });
  const d = await r.json();
  const raw = (d.content || []).map(b => b.text || "").join("").replace(/```json|```/g, "").trim();
  return JSON.parse(raw);
}

// ═══════════════════════════════════════════════════════════════════════
// SCORE / COLOR UTILS
// ═══════════════════════════════════════════════════════════════════════

const sc  = s => s>=75?"#16a34a":s>=60?"#2563b0":s>=50?"#d97706":"#dc2626";
const sb  = s => s>=75?"#dcfce7":s>=60?"#dbeafe":s>=50?"#fef3c7":"#fee2e2";
const pc  = p => ({Critical:"#7f1d1d",Serious:"#dc2626",Important:"#d97706",Minor:"#2563b0"})[p]||"#666";
const pb  = p => ({Critical:"#450a0a",Serious:"#fee2e2",Important:"#fef3c7",Minor:"#eff6ff"})[p]||"#f5f5f5";
const dc2 = d => ({APPROVED:"#16a34a","MINOR REVISIONS":"#2563b0","MAJOR REVISIONS":"#d97706","NOT APPROVED":"#dc2626"})[d]||"#666";

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

  const db = { admins, setAdmins, supervisors, setSupervisors, students, setStudents, submissions, setSubmissions };
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
  const[f,setF]=useState({surname:existing?.surname||"",initials:existing?.initials||"",number:existing?.number||"",level:existing?.level||"BEng",fields:existing?.fields||[],strictness:existing?.strictness||"strict",rubric:existing?.rubric||"",extraPrompt:existing?.extraPrompt||"",password:existing?.password||"",securityQ:existing?.securityQ||null,supervisorId:existing?.supervisorId||supervisorId||null});
  const[sqQ,setSqQ]=useState(existing?.securityQ?.question||SECURITY_QUESTIONS[0]);
  const[sqA,setSqA]=useState("");
  const[err,setErr]=useState("");
  const up=k=>e=>setF(p=>({...p,[k]:e.target.value}));
  const save=()=>{
    setErr("");
    if(!f.surname||!f.initials||!f.number)return setErr("Surname, initials and number required.");
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
      </div>
      <div style={{marginBottom:11}}>
        <label style={LS}>Assign to Supervisor</label>
        <select value={f.supervisorId||""} onChange={e=>setF(p=>({...p,supervisorId:e.target.value||null}))} style={IS}>
          <option value="">— Unassigned —</option>
          {db.supervisors.map(s=><option key={s.id} value={s.id}>{s.name}</option>)}
        </select>
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

// ═══════════════════════════════════════════════════════════
// FEEDBACK MODAL
// ═══════════════════════════════════════════════════════════

function FeedbackModal({submission,students,onClose}){
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
            </div>
          </div>
          <button onClick={onClose} style={{background:"rgba(255,255,255,.1)",border:"none",borderRadius:7,width:28,height:28,cursor:"pointer",display:"flex",alignItems:"center",justifyContent:"center"}}><Ic n="x" size={14} c="white"/></button>
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
    {label:"",         render:r=><button onClick={()=>setView(r)} style={{background:"none",border:"none",cursor:"pointer",color:"#3b82f6"}}><Ic n="eye" size={14}/></button>},
  ];
  return(
    <>
      <div style={{background:"white",borderRadius:12,border:"1px solid #e2e8f0",overflow:"hidden"}}>
        <div style={{padding:".75rem 1.1rem",borderBottom:"1px solid #f1f5f9"}}><h3 style={{margin:0,fontSize:13,fontWeight:700}}>Recent Reports</h3></div>
        <DataTable cols={cols} rows={rows} empty="No reports yet."/>
      </div>
      {view&&<FeedbackModal submission={view} students={students} onClose={()=>setView(null)}/>}
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
    {id:"reports",     icon:"file",    label:"All Reports"},
    {id:"allocate",    icon:"link2",   label:"Allocations"},
    {id:"settings",    icon:"settings",label:"My Settings"},
  ];
  return(
    <Shell role="admin" nav={nav} active={view} setActive={setView} onLogout={onLogout} badge={me.name||me.username}>
      {view==="dashboard"   && <AdminDashboard   db={db}/>}
      {view==="admins"      && <AdminsTab        db={db} session={session} showToast={showToast}/>}
      {view==="supervisors" && <SupervisorsTab   db={db} showToast={showToast}/>}
      {view==="students"    && <AdminStudentsTab db={db} showToast={showToast}/>}
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

function AdminStudentsTab({db,showToast}){
  const[showAdd,setShowAdd]=useState(false);const[edit,setEdit]=useState(null);const[search,setSearch]=useState("");
  const rows=db.students.filter(s=>`${s.surname} ${s.initials} ${s.number}`.toLowerCase().includes(search.toLowerCase()));
  const getSup=id=>db.supervisors.find(s=>s.id===id);
  const del=s=>{ if(!window.confirm(`Delete ${s.initials} ${s.surname}?`))return; db.setStudents(prev=>prev.filter(x=>x.id!==s.id)); showToast("Student deleted."); };
  const cols=[
    {label:"Student",   render:r=><span style={{fontWeight:700}}>{r.initials} {r.surname}</span>},
    {label:"Number",    render:r=><code style={{fontSize:12}}>{r.number}</code>},
    {label:"Level",     render:r=><Pill label={r.level} bg="#dbeafe" color="#1e40af"/>},
    {label:"Supervisor",render:r=>{const s=getSup(r.supervisorId);return s?<span style={{color:"#14532d",fontSize:12}}>{s.name}</span>:<span style={{color:"#94a3b8",fontSize:12}}>Unassigned</span>;}},
    {label:"Reports",   render:r=>db.submissions.filter(s=>s.studentId===r.id).length},
    {label:"",          render:r=><div style={{display:"flex",gap:5}}>
      <button onClick={()=>setEdit(r)} style={{background:"#eff6ff",border:"none",borderRadius:6,padding:"4px 7px",cursor:"pointer",color:"#3b82f6"}}><Ic n="edit" size={13}/></button>
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
    {edit&&<StudentFormModal db={db} existing={edit} onClose={()=>setEdit(null)} showToast={showToast}/>}</>
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
    {label:"",          render:r=><button onClick={()=>setView(r)} style={{background:"none",border:"none",cursor:"pointer",color:"#3b82f6"}}><Ic n="eye" size={14}/></button>},
  ];
  return(
    <><PageHeader title="All Reports"/>
    <Pad><DataTable cols={cols} rows={rows} empty="No reports submitted yet."/></Pad>
    {view&&<FeedbackModal submission={view} students={db.students} onClose={()=>setView(null)}/>}</>
  );
}

function AllocateTab({db,showToast}){
  const[selSup,setSelSup]=useState("");const[search,setSearch]=useState("");
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
        <input value={search} onChange={e=>setSearch(e.target.value)} placeholder="Search students…" style={{...IS,maxWidth:300,marginBottom:14}}/>
        <div style={{display:"grid",gridTemplateColumns:"1fr 1fr",gap:14}}>
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
        </div>
      </>}
    </Pad></>
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
  const myIds=new Set(myStudents.map(s=>s.id));
  const mySubs=db.submissions.filter(s=>myIds.has(s.studentId));
  const pending=db.students.filter(s=>s.requestedSupervisorId===session.id&&s.supervisorId!==session.id);

  const nav=[
    {id:"dashboard",icon:"chart",   label:"Dashboard"},
    {id:"students", icon:"users",   label:"My Students"},
    {id:"reports",  icon:"file",    label:"Reports"},
    {id:"settings", icon:"settings",label:"Settings"},
  ];

  return(
    <Shell role="supervisor" nav={nav} active={view} setActive={setView} onLogout={onLogout} badge={me.name}>
      {view==="dashboard"&&<SupDashboard db={db} myStudents={myStudents} mySubs={mySubs}/>}
      {view==="students" &&<SupStudents  db={db} session={session} myStudents={myStudents} pending={pending} showToast={showToast}/>}
      {view==="reports"  &&<SupReports  db={db} myStudents={myStudents} mySubs={mySubs}/>}
      {view==="settings" &&<AccountSettings role="supervisor" db={db} session={session} showToast={showToast}/>}
    </Shell>
  );
}

function SupDashboard({db,myStudents,mySubs}){
  const avg=mySubs.length?Math.round(mySubs.reduce((a,s)=>a+(s.result?.overallScore||0),0)/mySubs.length):0;
  const approved=mySubs.filter(s=>s.result?.supervisorDecision==="APPROVED").length;
  return(
    <><PageHeader title="Dashboard"/>
    <Pad>
      <StatCards cards={[
        {label:"My Students",value:myStudents.length, icon:"users",color:"#3b82f6"},
        {label:"Reports",    value:mySubs.length,     icon:"file", color:"#8b5cf6"},
        {label:"Approved",   value:approved,          icon:"check",color:"#16a34a"},
        {label:"Avg Score",  value:avg+"%",           icon:"chart",color:"#d97706"},
      ]}/>
      <RecentReports db={db} submissions={mySubs} students={myStudents}/>
    </Pad></>
  );
}

function SupStudents({db,session,myStudents,pending,showToast}){
  const[showAdd,setShowAdd]=useState(false);const[edit,setEdit]=useState(null);const[showPending,setShowPending]=useState(false);
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
      {edit&&<StudentFormModal db={db} existing={edit} onClose={()=>setEdit(null)} showToast={showToast}/>}
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
  const[view,setView]=useState(null);
  const getStu=id=>myStudents.find(s=>s.id===id)||db.students.find(s=>s.id===id)||{};
  const rows=[...mySubs].reverse();
  const cols=[
    {label:"Student", render:r=>{const s=getStu(r.studentId);return <span style={{fontWeight:700}}>{s.initials} {s.surname}</span>;}},
    {label:"File",    render:r=><span style={{color:"#64748b",fontSize:12,maxWidth:140,display:"block",overflow:"hidden",textOverflow:"ellipsis",whiteSpace:"nowrap"}}>{r.filename}</span>},
    {label:"Score",   render:r=><span style={{fontWeight:800,color:sc(r.result?.overallScore||0)}}>{r.result?.overallScore??"-"}%</span>},
    {label:"Decision",render:r=>r.result?.supervisorDecision?<Pill label={r.result.supervisorDecision} bg={sb(r.result.overallScore||0)} color={dc2(r.result.supervisorDecision)}/>:"-"},
    {label:"Date",    render:r=><span style={{color:"#94a3b8",fontSize:12}}>{new Date(r.date).toLocaleDateString("en-ZA")}</span>},
    {label:"",        render:r=><button onClick={()=>setView(r)} style={{background:"none",border:"none",cursor:"pointer",color:"#3b82f6"}}><Ic n="eye" size={14}/></button>},
  ];
  return(
    <><PageHeader title="Student Reports"/>
    <Pad><DataTable cols={cols} rows={rows} empty="No reports from your students yet."/></Pad>
    {view&&<FeedbackModal submission={view} students={[...myStudents,...db.students]} onClose={()=>setView(null)}/>}</>
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
  const[loading,setLoading]=useState(false);const[error,setError]=useState("");
  const[viewSub,setViewSub]=useState(null);

  const mySubs=db.submissions.filter(s=>s.studentId===stu.id);
  const sup=db.supervisors.find(s=>s.id===stu.supervisorId);
  const reqSup=db.supervisors.find(s=>s.id===stu.requestedSupervisorId);
  const sl=STRICTNESS.find(l=>l.id===(stu.strictness||"strict"));

  const handleFile=f=>{if(!f)return;setFile(f);setError("");const r=new FileReader();r.onload=e=>setText(e.target.result||"");r.readAsText(f);};
  const handleSubmit=async()=>{
    if(!text.trim())return setError("Upload a document first.");
    setLoading(true);setError("");
    try{
      const notes=(sup?`Supervisor: ${sup.name}. `:"")+( stu.extraPrompt||"");
      const result=await analyzeDoc(text,stu,notes);
      const sub={id:"sub_"+uid(),studentId:stu.id,filename:file?.name||"Document",date:new Date().toISOString(),result};
      db.setSubmissions(prev=>[...prev,sub]);
      setViewSub(sub);setFile(null);setText("");
      showToast("Analysis complete!");
    }catch(e){setError("Analysis failed: "+(e.message||"Please try again."));}
    setLoading(false);
  };

  if(needsSetup) return <StudentFirstSetup stu={stu} db={db} onDone={()=>{setNeedsSetup(false);showToast("Account set up. Welcome!");}}/>;
  if(needsSup)   return <SupSelectScreen stu={stu} db={db} onDone={()=>{setNeedsSup(false);showToast("Request sent to supervisor.");}} onSkip={()=>setNeedsSup(false)}/>;

  return(
    <div style={{minHeight:"100vh",background:"#f8fafc",fontFamily:"system-ui,sans-serif"}}>
      <div style={{background:"#0f172a",padding:".9rem 1.5rem",display:"flex",alignItems:"center",justifyContent:"space-between"}}>
        <div style={{display:"flex",alignItems:"center",gap:10}}>
          <div style={{width:32,height:32,borderRadius:9,background:"#8b5cf6",display:"flex",alignItems:"center",justifyContent:"center"}}><Ic n="award" size={17} c="white"/></div>
          <div><div style={{color:"white",fontWeight:700,fontSize:14}}>AcademiQ Analyser</div><div style={{color:"rgba(255,255,255,.4)",fontSize:11}}>{stu.initials} {stu.surname} · {stu.number}</div></div>
        </div>
        <div style={{display:"flex",alignItems:"center",gap:6,flexWrap:"wrap"}}>
          {sup?<span style={{background:"rgba(139,92,246,.25)",color:"#c4b5fd",padding:"3px 9px",borderRadius:99,fontSize:11,fontWeight:600}}>{stu.level} · {sup.name}</span>:reqSup?<span style={{background:"rgba(217,119,6,.2)",color:"#fcd34d",padding:"3px 9px",borderRadius:99,fontSize:11}}>Pending: {reqSup.name}</span>:null}
          {[["submit","Submit"],["history","My Reports"],["account","Account"]].map(([v,l])=><button key={v} onClick={()=>setView(v)} style={{background:view===v?"rgba(139,92,246,.25)":"rgba(255,255,255,.06)",border:"none",borderRadius:7,padding:"5px 10px",color:view===v?"#c4b5fd":"rgba(255,255,255,.45)",cursor:"pointer",fontSize:12,fontWeight:view===v?600:400}}>{l}</button>)}
          <button onClick={onLogout} style={{background:"rgba(255,255,255,.06)",border:"none",borderRadius:7,padding:"5px 9px",color:"rgba(255,255,255,.35)",cursor:"pointer",fontSize:12,display:"flex",alignItems:"center",gap:4}}><Ic n="logout" size={13} c="rgba(255,255,255,.35)"/>Out</button>
        </div>
      </div>

      <div style={{maxWidth:820,margin:"0 auto",padding:"1.5rem 1rem"}}>
        {view==="submit"&&(
          <div style={{background:"white",borderRadius:16,border:"1px solid #e2e8f0",padding:"1.75rem"}}>
            <h2 style={{fontSize:16,fontWeight:700,marginBottom:4}}>Submit Your Project</h2>
            <p style={{fontSize:13,color:"#64748b",marginBottom:16}}>Upload your project document for AI-powered analysis.</p>
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
            {error&&<div style={{background:"#fee2e2",color:"#991b1b",borderRadius:8,padding:"9px 13px",fontSize:13,marginTop:11}}>{error}</div>}
            <button onClick={handleSubmit} disabled={!text||loading} style={{...BP,marginTop:13,background:"linear-gradient(135deg,#8b5cf6,#7c3aed)",display:"flex",alignItems:"center",justifyContent:"center",gap:7,opacity:(!text||loading)?0.6:1,cursor:(!text||loading)?"not-allowed":"pointer"}}>
              {loading?<><div style={{animation:"spin 1s linear infinite",display:"inline-flex"}}><Ic n="spin" size={15} c="white"/></div>Analysing…</>:<><Ic n="chart" size={15} c="white"/> Submit for Analysis</>}
            </button>
          </div>
        )}

        {view==="history"&&(
          <div style={{background:"white",borderRadius:16,border:"1px solid #e2e8f0",overflow:"hidden"}}>
            <div style={{padding:".8rem 1.2rem",borderBottom:"1px solid #f1f5f9"}}><h3 style={{margin:0,fontSize:14,fontWeight:700}}>My Reports</h3></div>
            {mySubs.length===0?<div style={{padding:"2.5rem",textAlign:"center",color:"#94a3b8",fontSize:13}}>No reports submitted yet.</div>:(
              [...mySubs].reverse().map(sub=>(
                <div key={sub.id} onClick={()=>setViewSub(sub)} style={{padding:"12px 17px",borderBottom:"1px solid #f8fafc",cursor:"pointer",display:"flex",alignItems:"center",gap:13}} onMouseEnter={e=>e.currentTarget.style.background="#f8fafc"} onMouseLeave={e=>e.currentTarget.style.background="white"}>
                  <Ic n="file" size={18} c="#8b5cf6"/>
                  <div style={{flex:1}}><div style={{fontWeight:600,fontSize:14}}>{sub.filename}</div><div style={{fontSize:12,color:"#94a3b8"}}>{new Date(sub.date).toLocaleDateString("en-ZA",{weekday:"short",year:"numeric",month:"short",day:"numeric"})}</div></div>
                  <div style={{textAlign:"right"}}><div style={{fontSize:19,fontWeight:800,color:sc(sub.result?.overallScore||0)}}>{sub.result?.overallScore??"-"}%</div>{sub.result?.supervisorDecision&&<div style={{fontSize:11,color:dc2(sub.result.supervisorDecision),fontWeight:600}}>{sub.result.supervisorDecision}</div>}</div>
                  <Ic n="chevron" size={14} c="#cbd5e1"/>
                </div>
              ))
            )}
          </div>
        )}

        {view==="account"&&<StudentAccountPage stu={stu} db={db} showToast={showToast}/>}
      </div>

      {viewSub&&<FeedbackModal submission={viewSub} students={db.students} onClose={()=>setViewSub(null)}/>}
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
          {[["Name",`${stu.initials} ${stu.surname}`],["Number",stu.number],["Level",stu.level],["Supervisor",sup?.name||(reqSup?`Pending: ${reqSup.name}`:"None")]].map(([k,v])=>(
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
