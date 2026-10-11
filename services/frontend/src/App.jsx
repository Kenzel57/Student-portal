import { useCallback, useEffect, useState } from "react";
import { restoreSession, logout } from "./api.js";
import Login from "./Login.jsx";
import { StudentDashboard, StaffDashboard } from "./Dashboards.jsx";
import Transcript from "./Transcript.jsx";
import PastPapers from "./PastPapers.jsx";

const STUDENT_TABS = [
  { id: "dashboard", label: "My Dashboard" },
  { id: "transcript", label: "Transcript" },
  { id: "pastpapers", label: "Past Papers" },
];
const STAFF_TABS = [
  { id: "dashboard", label: "Staff Dashboard" },
  { id: "pastpapers", label: "Past Papers" },
];

// Role-based routing: the role comes from the Auth Service's login response
// (the same role is signed into the JWT, which the backend enforces).
// Screens are chosen by state rather than URL, because /student and
// /dashboard are API paths routed by Traefik to backend services.
export default function App() {
  const [status, setStatus] = useState("loading"); // loading | anonymous | authenticated
  const [user, setUser] = useState(null);
  const [notice, setNotice] = useState("");
  const [tab, setTab] = useState("dashboard");

  useEffect(() => {
    restoreSession().then((restored) => {
      setUser(restored);
      setStatus(restored ? "authenticated" : "anonymous");
    });
  }, []);

  function handleLogin(loggedIn) {
    setNotice("");
    setUser(loggedIn);
    setStatus("authenticated");
  }

  // Stable identity: the dashboards use it as a hook dependency.
  const handleLogout = useCallback(async (message = "") => {
    await logout();
    setUser(null);
    setNotice(message);
    setTab("dashboard");
    setStatus("anonymous");
  }, []);

  if (status === "loading") return <p className="centered muted">Loading…</p>;
  if (status === "anonymous") return <Login onLogin={handleLogin} notice={notice} />;

  const isStudent = user.role === "student";
  return (
    <div className="layout">
      <header className="topbar">
        <span className="brand">Student Portal</span>
        <span className="who">
          {user.email} <span className={`badge badge-${user.role}`}>{user.role}</span>
          <button className="link" onClick={() => handleLogout()}>Log out</button>
        </span>
      </header>
      <nav className="tabs">
        {(isStudent ? STUDENT_TABS : STAFF_TABS).map((t) => (
          <button key={t.id} className={tab === t.id ? "tab active" : "tab"} onClick={() => setTab(t.id)}>
            {t.label}
          </button>
        ))}
      </nav>
      <main className="content">
        {tab === "dashboard" && (isStudent
          ? <StudentDashboard onSessionExpired={handleLogout} />
          : <StaffDashboard onSessionExpired={handleLogout} />)}
        {isStudent && tab === "transcript" && <Transcript studentId={user.id} onSessionExpired={handleLogout} />}
        {tab === "pastpapers" && <PastPapers canUpload={!isStudent} onSessionExpired={handleLogout} />}
      </main>
    </div>
  );
}
