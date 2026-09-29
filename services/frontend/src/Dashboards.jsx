import { useCallback, useEffect, useState } from "react";
import { getDashboard, SessionExpiredError } from "./api.js";

// Loads /dashboard/home; exposes a reload that reports Redis cache HIT/MISS.
function useDashboard(onSessionExpired) {
  const [state, setState] = useState({ loading: true, payload: null, cache: null, error: "" });

  const load = useCallback(async () => {
    setState((s) => ({ ...s, loading: true, error: "" }));
    try {
      const { payload, cache } = await getDashboard();
      setState({ loading: false, payload, cache, error: "" });
    } catch (err) {
      if (err instanceof SessionExpiredError) return onSessionExpired(err.message);
      setState((s) => ({ ...s, loading: false, error: err.message }));
    }
  }, [onSessionExpired]);

  useEffect(() => {
    load();
  }, [load]);

  return { ...state, reload: load };
}

function DashboardFrame({ title, dash, children }) {
  return (
    <>
      <div className="title-row">
        <h1>{title}</h1>
        <span className="muted small">
          {dash.cache && <>Served from cache: <strong>{dash.cache}</strong> · </>}
          <button className="link" onClick={dash.reload} disabled={dash.loading}>
            {dash.loading ? "Loading…" : "Reload"}
          </button>
        </span>
      </div>
      {dash.error && <p className="error">{dash.error}</p>}
      {dash.payload?.degraded?.length > 0 && (
        <p className="alert">
          Some information is temporarily unavailable ({dash.payload.degraded.join(", ")}). Showing what we have.
        </p>
      )}
      {dash.payload && children(dash.payload)}
    </>
  );
}

function Field({ label, value }) {
  return (
    <div className="field">
      <span className="muted small">{label}</span>
      <span>{value || "—"}</span>
    </div>
  );
}

export function StudentDashboard({ onSessionExpired }) {
  const dash = useDashboard(onSessionExpired);
  return (
    <DashboardFrame title="My Dashboard" dash={dash}>
      {(p) => (
        <>
          <section className="card">
            <h2>Profile</h2>
            {p.profile ? (
              <div className="grid">
                <Field label="Full name" value={p.profile.fullName} />
                <Field label="Student number" value={p.profile.studentNumber} />
                <Field label="Status" value={p.profile.enrolmentStatus} />
                <Field label="Contact email" value={p.profile.contactEmail} />
                <Field label="Phone" value={p.profile.phone} />
                <Field label="Address" value={p.profile.address} />
              </div>
            ) : (
              <p className="muted">Your profile hasn't been set up yet.</p>
            )}
          </section>
          <section className="card">
            <h2>Enrolment</h2>
            {p.enrolments.length ? (
              <table>
                <thead>
                  <tr><th>Programme</th><th>Department</th><th>Year</th><th>Academic year</th><th>Status</th></tr>
                </thead>
                <tbody>
                  {p.enrolments.map((e) => (
                    <tr key={e.id}>
                      <td>{e.programme}</td><td>{e.department}</td><td>{e.yearOfStudy}</td>
                      <td>{e.academicYear || "—"}</td><td>{e.status}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            ) : (
              <p className="muted">No enrolment records yet.</p>
            )}
          </section>
        </>
      )}
    </DashboardFrame>
  );
}

export function StaffDashboard({ onSessionExpired }) {
  const dash = useDashboard(onSessionExpired);
  return (
    <DashboardFrame title="Staff Dashboard" dash={dash}>
      {(p) => (
        <section className="card">
          <h2>Welcome{p.name ? `, ${p.name}` : ""}</h2>
          <div className="grid">
            <Field label="Email" value={p.user.email} />
            <Field label="Role" value={p.role} />
          </div>
          <p className="muted">Staff tools (grades, past papers) arrive with the Transcript and Past Papers services.</p>
        </section>
      )}
    </DashboardFrame>
  );
}
