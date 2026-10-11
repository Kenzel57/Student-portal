import { useEffect, useState } from "react";
import { getTranscript, downloadTranscriptPdf, SessionExpiredError } from "./api.js";

const fmtGpa = (gpa) => (gpa === null || gpa === undefined ? "—" : gpa.toFixed(2));

export default function Transcript({ studentId, onSessionExpired }) {
  const [transcript, setTranscript] = useState(null);
  const [error, setError] = useState("");
  const [downloading, setDownloading] = useState(false);

  function handleError(err) {
    if (err instanceof SessionExpiredError) return onSessionExpired(err.message);
    setError(err.message);
  }

  useEffect(() => {
    getTranscript(studentId).then(setTranscript, handleError);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [studentId]);

  async function handleDownload() {
    setError("");
    setDownloading(true);
    try {
      await downloadTranscriptPdf(studentId);
    } catch (err) {
      handleError(err);
    } finally {
      setDownloading(false);
    }
  }

  return (
    <>
      <div className="title-row">
        <h1>Transcript</h1>
        <button onClick={handleDownload} disabled={downloading || !transcript}>
          {downloading ? "Preparing PDF…" : "Download PDF"}
        </button>
      </div>
      {error && <p className="error">{error}</p>}
      {!transcript && !error && <p className="muted">Loading…</p>}

      {transcript && (
        <>
          <section className="card summary-row">
            <div className="field">
              <span className="muted small">Cumulative GPA</span>
              <span className="big">{fmtGpa(transcript.cumulativeGpa)}</span>
            </div>
            <div className="field">
              <span className="muted small">Total credits</span>
              <span className="big">{transcript.totalCredits}</span>
            </div>
            <div className="field">
              <span className="muted small">Semesters</span>
              <span className="big">{transcript.semesters.length}</span>
            </div>
          </section>

          {transcript.semesters.length === 0 && (
            <section className="card">
              <p className="muted">No grades have been recorded yet.</p>
            </section>
          )}

          {transcript.semesters.map((s) => (
            <section className="card" key={s.semester}>
              <h2>{s.semester}</h2>
              <table>
                <thead>
                  <tr><th>Code</th><th>Course</th><th className="num">Credits</th><th className="num">Grade</th><th className="num">Points</th></tr>
                </thead>
                <tbody>
                  {s.courses.map((c) => (
                    <tr key={c.courseCode}>
                      <td>{c.courseCode}</td>
                      <td>{c.courseTitle || "—"}</td>
                      <td className="num">{c.credits}</td>
                      <td className="num">{c.grade}</td>
                      <td className="num">{c.points.toFixed(1)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr><td colSpan={2}>Semester GPA</td><td className="num">{s.credits}</td><td /><td className="num">{fmtGpa(s.gpa)}</td></tr>
                </tfoot>
              </table>
            </section>
          ))}
        </>
      )}
    </>
  );
}
