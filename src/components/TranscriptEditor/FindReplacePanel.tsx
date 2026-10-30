/** Model-backed contextual find/replace and explicitly labeled speech cuts. */

import { useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { useProjectStore } from "@/stores/projectStore";
import { useUIStore } from "@/stores/uiStore";
import { ChevronDown, ChevronUp, Replace, Search, X } from "lucide-react";
import type { Project } from "@/lib/edl";
import { findTranscriptMatches, type TranscriptMatch } from "@/lib/transcriptSearch";

interface FindReplacePanelProps {
  /** Hide the panel. The parent owns visibility state. */
  onClose: () => void;
  onResults: (project: Project, matches: TranscriptMatch[], current: number) => void;
}

export function FindReplacePanel({ onClose, onResults }: FindReplacePanelProps) {
  const project = useProjectStore((s) => s.project);
  const applyTextEdits = useProjectStore((s) => s.applyTextEdits);

  const pushToast = useUIStore((s) => s.pushToast);

  const [find, setFind] = useState("");
  const [replace, setReplace] = useState("");
  const [caseSensitive, setCaseSensitive] = useState(false);
  const [wholeWord, setWholeWord] = useState(false);
  const [matchIndex, setMatchIndex] = useState(0);

  const findInputRef = useRef<HTMLInputElement | null>(null);

  // Focus once on opening; model/selection updates must not steal editor focus.
  useEffect(() => {
    findInputRef.current?.focus();
  }, []);
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const matches = useMemo(
    () => findTranscriptMatches(project, find, { caseSensitive, wholeWord }),
    [project, find, caseSensitive, wholeWord],
  );
  const matchCount = matches.length;
  const current = matchCount ? matchIndex % matchCount : 0;
  useEffect(() => {
    onResults(project, matches, current);
  }, [project, matches, current, onResults]);
  useEffect(() => () => onResults(project, [], 0), [onResults, project]);

  function step(delta: number) {
    if (matchCount === 0) return;
    setMatchIndex((i) => (i + delta + matchCount) % matchCount);
  }

  function handleReplace(all: boolean) {
    const targets = all ? matches : matches.slice(current, current + 1);
    try {
      applyTextEdits(
        targets.map((match) => ({ ...match, text: replace })),
        project,
      );
      pushToast({
        title: `Replaced ${targets.length} ${targets.length === 1 ? "match" : "matches"}`,
      });
    } catch (error) {
      pushToast({
        title: "Cannot replace text",
        description: String(error),
        variant: "destructive",
      });
    }
  }

  function handleRemoveFind() {
    if (!find) return;
    let n: number;
    try {
      useProjectStore.getState().cutSpeech(matches, project);
      n = matches.length;
    } catch (error) {
      pushToast({ title: "Cannot cut speech", description: String(error), variant: "destructive" });
      return;
    }
    if (n === 0) {
      pushToast({ title: "No matches found" });
    } else {
      pushToast({ title: `Cut ${n} speech ${n === 1 ? "match" : "matches"}` });
    }
  }

  return (
    <div className="relative z-10 flex flex-col gap-2 border-b border-border bg-background/95 px-4 py-2 backdrop-blur">
      {/* ── Row 1: search + nav ─────────────────────────────────────────── */}
      <div className="flex items-center gap-2">
        <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          ref={findInputRef}
          type="text"
          value={find}
          placeholder="Find in transcript"
          onChange={(e) => {
            setFind(e.target.value);
            setMatchIndex(0);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) step(e.shiftKey ? -1 : 1);
          }}
          className="h-7 flex-1 rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
        <span className="w-16 select-none text-right text-xs tabular-nums text-muted-foreground">
          {find
            ? matchCount === 0
              ? "0 / 0"
              : `${(matchIndex % matchCount) + 1} / ${matchCount}`
            : ""}
        </span>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => step(-1)}
          disabled={matchCount === 0}
          title="Previous (Shift+Enter)"
        >
          <ChevronUp className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={() => step(1)}
          disabled={matchCount === 0}
          title="Next (Enter)"
        >
          <ChevronDown className="h-3.5 w-3.5" />
        </Button>
        <Button
          size="icon"
          variant="ghost"
          className="h-7 w-7"
          onClick={onClose}
          title="Close (Esc)"
        >
          <X className="h-3.5 w-3.5" />
        </Button>
      </div>

      {matches[current] && (
        <p
          className="max-h-24 overflow-y-auto text-xs text-muted-foreground"
          aria-label="Match context"
        >
          {matches[current]!.context.slice(0, matches[current]!.from)}
          <mark>
            {matches[current]!.context.slice(matches[current]!.from, matches[current]!.to)}
          </mark>
          {matches[current]!.context.slice(matches[current]!.to)}
        </p>
      )}
      {/* ── Row 2: replace + filler review ─────────────────────────────── */}
      <div className="flex flex-wrap items-center gap-2">
        <Replace className="h-4 w-4 shrink-0 text-muted-foreground" />
        <input
          type="text"
          value={replace}
          placeholder="Replace with…"
          onChange={(e) => setReplace(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.nativeEvent.isComposing) handleReplace(false);
          }}
          className="h-7 flex-1 min-w-[160px] rounded-md border border-input bg-background px-2 text-sm outline-none focus:ring-1 focus:ring-ring"
        />
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => handleReplace(false)}
          disabled={!matchCount}
        >
          Replace current
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={() => handleReplace(true)}
          disabled={!matchCount}
        >
          Replace all
        </Button>
        <Button
          size="sm"
          variant="outline"
          className="h-7 text-xs"
          onClick={handleRemoveFind}
          disabled={!matchCount}
          title="Cut audio/video for matching complete words or timing groups"
        >
          Cut matching speech
        </Button>

        <Button
          size="sm"
          variant="outline"
          onClick={() => useUIStore.getState().setFillerReviewOpen(true)}
        >
          Review fillers
        </Button>

        {/* Options */}
        <label className="flex select-none items-center gap-1 text-xs text-muted-foreground">
          <input
            type="checkbox"
            checked={caseSensitive}
            aria-label="Case sensitive"
            onChange={(e) => {
              setCaseSensitive(e.target.checked);
              setMatchIndex(0);
            }}
          />
          Aa
        </label>
        <label
          className="flex select-none items-center gap-1 text-xs text-muted-foreground"
          title="Whole word: Unicode letters, marks, numbers and connectors define word boundaries"
        >
          <input
            type="checkbox"
            checked={wholeWord}
            aria-label="Whole word"
            onChange={(e) => {
              setWholeWord(e.target.checked);
              setMatchIndex(0);
            }}
          />
          Whole word
        </label>
      </div>
    </div>
  );
}
