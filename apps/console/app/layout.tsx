import type { ReactNode } from "react";
import "./globals.css";
import { Bar } from "../components/Bar.tsx";
import { config, consoleToken, openStore, openTickets } from "../lib/server.ts";
import { CONSOLE_TOKEN_META } from "../lib/console-token.ts";

export const metadata = {
  title: "Autopilot console",
  description: "Read what the loop shipped to staging. Decide what goes to production.",
};

/** Next must not cache this: the store changes underneath the app on every loop cycle. */
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: ReactNode }) {
  const cfg = config();
  const store = openStore();
  const waiting = store.undrained().length;
  const staged = store.undigestedRuns().length;
  store.close();
  const { tickets } = await openTickets(cfg);

  return (
    <html lang="en">
      <head>
        {/*
          The console token, for the browser to send back on every write. Not user
          authentication - see lib/server.ts. Absent means the write routes fail closed.
        */}
        {consoleToken() ? <meta name={CONSOLE_TOKEN_META} content={consoleToken()} /> : null}
        {/*
          A <link> rather than next/font: the demo has to run with no network, and every face
          in DESIGN.md carries a real fallback stack, so a missing webfont changes nothing but
          the shapes.
        */}
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link
          rel="stylesheet"
          href="https://fonts.googleapis.com/css2?family=Space+Grotesk:wght@400;500;600&family=Inter:wght@400;500;600&family=JetBrains+Mono:wght@400;500&display=swap"
        />
      </head>
      <body>
        <Bar
          product={cfg.product.name}
          waiting={waiting}
          staged={staged}
          open={tickets.length}
          tickets={tickets.map((t) => ({ id: t.id, title: t.title }))}
        />
        <main>{children}</main>
        <footer className="foot-line">
          <p>
            {cfg.product.name} · staging {cfg.environments.staging.url ?? cfg.environments.staging.deploy} ·
            the loop ships here and nowhere else. Production needs your press.
          </p>
          {consoleToken() ? null : (
            <p style={{ marginTop: "var(--space-xs)", color: "var(--color-danger)" }}>
              AUTOPILOT_CONSOLE_TOKEN is not set, so the press, feedback and the crops are
              refused. Set it to any long random string and restart.
            </p>
          )}
        </footer>
      </body>
    </html>
  );
}
