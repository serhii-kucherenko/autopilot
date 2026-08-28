"use client";

/**
 * N13 · the bordered bar with a ⌘K palette that really opens.
 *
 * Cobalt's signature: the page behaves like a dev tool rather than looking like one. The
 * palette jumps to a ticket by id or title, which is the one navigation a console genuinely
 * needs and a nav bar cannot carry.
 */

import { useEffect, useRef, useState } from "react";
import Link from "next/link";
import { usePathname, useRouter } from "next/navigation";

const SCREENS = [
  { href: "/digest", label: "Digest" },
  { href: "/inbox", label: "Inbox" },
  { href: "/backlog", label: "Backlog" },
] as const;

interface Props {
  product: string;
  waiting: number;
  staged: number;
  open: number;
  tickets: { id: string; title: string }[];
}

export function Bar({ product, waiting, staged, open, tickets }: Props) {
  const pathname = usePathname();
  const [paletteOpen, setPaletteOpen] = useState(false);

  useEffect(() => {
    function onKey(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((was) => !was);
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  return (
    <>
      <header className="bar">
        <span className="bar__mark">{product}</span>
        <nav aria-label="Screens">
          <ul className="bar__nav">
            {SCREENS.map((screen) => {
              const current = pathname === screen.href;
              return (
                <li key={screen.href}>
                  <Link
                    className="link"
                    href={screen.href}
                    aria-current={current ? "page" : undefined}
                  >
                    {screen.label}
                  </Link>
                </li>
              );
            })}
          </ul>
        </nav>
        <span className="bar__spacer" />
        <span className="bar__count">
          {staged} staged · {waiting} waiting · {open} open
        </span>
        <button
          type="button"
          className="btn"
          onClick={() => setPaletteOpen(true)}
          aria-haspopup="dialog"
        >
          Find a ticket <kbd>⌘K</kbd>
        </button>
      </header>

      {paletteOpen ? <Palette tickets={tickets} onClose={() => setPaletteOpen(false)} /> : null}
    </>
  );
}

function Palette({
  tickets,
  onClose,
}: {
  tickets: { id: string; title: string }[];
  onClose: () => void;
}) {
  const router = useRouter();
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState(0);
  const input = useRef<HTMLInputElement>(null);

  const needle = query.trim().toLowerCase();
  const matches = needle
    ? tickets.filter(
        (t) => t.id.toLowerCase().includes(needle) || t.title.toLowerCase().includes(needle),
      )
    : tickets;

  useEffect(() => {
    input.current?.focus();
  }, []);

  useEffect(() => {
    setSelected(0);
  }, [needle]);

  function go(id: string) {
    onClose();
    router.push(`/tickets/${encodeURIComponent(id)}`);
  }

  function onKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Escape") {
      event.preventDefault();
      onClose();
      return;
    }
    if (event.key === "ArrowDown") {
      event.preventDefault();
      setSelected((i) => Math.min(i + 1, Math.max(matches.length - 1, 0)));
      return;
    }
    if (event.key === "ArrowUp") {
      event.preventDefault();
      setSelected((i) => Math.max(i - 1, 0));
      return;
    }
    if (event.key === "Enter") {
      event.preventDefault();
      const target = matches[selected];
      if (target) go(target.id);
    }
  }

  return (
    <div
      className="palette__backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-element-interactions */}
      <div
        className="palette"
        role="dialog"
        aria-modal="true"
        aria-label="Find a ticket"
        onKeyDown={onKeyDown}
      >
        <input
          ref={input}
          className="palette__input"
          placeholder="Ticket id or title…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          aria-label="Ticket id or title"
        />
        {matches.length === 0 ? (
          <p className="palette__empty">
            {tickets.length === 0
              ? "The backlog is empty. The next loop wake runs a self-audit."
              : `Nothing matches “${query}”.`}
          </p>
        ) : (
          <ul className="palette__list">
            {matches.map((ticket, index) => (
              <li key={ticket.id}>
                <button
                  type="button"
                  className="palette__row"
                  aria-selected={index === selected}
                  onMouseEnter={() => setSelected(index)}
                  onClick={() => go(ticket.id)}
                >
                  <span className="mono">{ticket.id}</span>
                  <span>{ticket.title}</span>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}
