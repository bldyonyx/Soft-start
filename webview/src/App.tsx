import "./App.css";

function App() {
  return (
    <main className="dashboard">
      <header className="dashboard-header">
        <span className="dashboard-brand">Soft Start ⸝⸝</span>
        <span className="dashboard-decoration">𓏲ּ𝄢</span>
      </header>

      <section className="welcome">
        <p className="welcome-eyebrow">YOUR LITTLE WORKSPACE</p>
        <h1>Welcome back ♡</h1>
        <p>A little space to begin something lovely.</p>
      </section>

      <section className="dashboard-section">
        <div className="section-heading">
          <h2>Pinned projects</h2>
          <span>✧</span>
        </div>

        <div className="project-grid">
          <article className="project-card">
            <span className="project-icon">✦</span>
            <h3>Your favorites</h3>
            <p>Keep your favorite projects close.</p>
          </article>
        </div>
      </section>

      <section className="dashboard-section">
        <div className="section-heading">
          <h2>Recent projects</h2>
          <span>⸝⸝</span>
        </div>

        <div className="empty-state">
          Your recent projects will appear here.
        </div>
      </section>

      <section className="dashboard-section">
        <div className="section-heading">
          <h2>Quick actions</h2>
        </div>

        <div className="quick-actions">
          <button type="button" disabled>
            New file
          </button>
          <button type="button" disabled>
            Open folder
          </button>
          <button type="button" disabled>
            Clone repository
          </button>
        </div>
      </section>

      <footer className="dashboard-footer">
        Made for softer beginnings ʚ⠀ິɞ
      </footer>
    </main>
  );
}

export default App;
