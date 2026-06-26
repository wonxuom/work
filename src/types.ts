export type Note = { id: number; content: string; created_at: string; updated_at: string; tags: string[]; project: string | null; category: string; };
export type Plan = { id: number; date: string; priority: "Must" | "Should" | "Could"; content: string; memo: string; completed: boolean; };
export type Summary = { completed: Plan[]; decisions: Note[]; work: Note[]; ideas: Note[]; questions: Note[]; feedback: Note[]; };
export type Settings = { shortcut: string; ai_provider: "off" | "openai" | "claude" | "gemini"; theme: "system" | "light" | "dark"; };
