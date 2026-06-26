import { FormEvent, useEffect, useRef, useState } from "react";
import { emitTo } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { api } from "./api";

export default function Capture() {
  const [content, setContent] = useState("");
  const [saved, setSaved] = useState(false);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focusInput = () => input.current?.focus();
    focusInput();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") void getCurrentWindow().hide();
    };
    window.addEventListener("focus", focusInput);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("focus", focusInput);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  async function submit(event: FormEvent) {
    event.preventDefault();
    const value = content.trim();
    if (!value) return;
    await api.createNote(value);
    await emitTo("main", "note-created");
    setContent("");
    setSaved(true);
    window.setTimeout(() => setSaved(false), 900);
  }

  return (
    <main className="capture-shell" data-tauri-drag-region>
      <form className="capture-box" onSubmit={submit}>
        <span className="capture-mark" aria-hidden="true" data-tauri-drag-region>+</span>
        <input
          ref={input}
          value={content}
          onChange={(event) => setContent(event.target.value)}
          placeholder="지금 떠오른 것을 던져두세요"
          aria-label="빠른 기록"
          autoComplete="off"
        />
        <span className={saved ? "capture-status visible" : "capture-status"} data-tauri-drag-region>
          저장됨
        </span>
        <kbd data-tauri-drag-region>↵</kbd>
      </form>
    </main>
  );
}
