/**
 * Output timeline.
 *
 * Two view modes, switched purely by `timelineZoom`:
 *  - zoom = 1: the rail fits the panel exactly and behaves like a static overview.
 *  - zoom > 1: the rail is `zoom × containerWidth` wide and lives inside a
 *    horizontally-scrolling container. The playhead is auto-scrolled into view,
 *    word bars are virtualised (only those overlapping the visible window are
 *    rendered) and a small minimap above the rail shows where you are in the
 *    whole output.
 *
 * Sync notes:
 *  - Bars are positioned in absolute px relative to the full-width rail using a
 *    single `pxPerSecond` scale. Pixel layout never moves while the user scrolls
 *    — only the scrollLeft changes — so the playhead stays sub-pixel accurate
 *    at high zoom.
 *  - Wheel-to-pan (horizontal): regular wheel scroll just scrolls the rail.
 *  - Wheel-to-zoom (Cmd/Ctrl + wheel): zooms in/out, recentring on the cursor.
 */

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  computeTimeline,
  outputTimeToSource,
  projectChapters,
  totalDuration,
  wordIdsInOutputRange,
} from "@/lib/edl";
import { useProjectStore } from "@/stores/projectStore";
import { MAX_TIMELINE_ZOOM, usePlayerStore } from "@/stores/playerStore";
import { fillerCandidates } from "@/lib/fillerReview";
import { formatTimecode } from "@/lib/timecode";
import { Button } from "@/components/ui/button";
import { cutTimelineSelection } from "@/lib/appCommands";

import { projectTranscript } from "@/lib/transcript";
import { AudioWaveform } from "./AudioWaveform";
import { useTimelineAnalysis } from "./TimelineAnalysis";

/** Px overdraw outside the visible window so virtualised bars enter/exit smoothly. */
const VIRTUAL_OVERDRAW_PX = 200;

/** Width of the minimap rail (px). Only shown when zoomed in. */
const MINIMAP_WIDTH_PX = 220;
const MINIMAP_HEIGHT_PX = 14;

export function Waveform() {
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const railRef = useRef<HTMLDivElement | null>(null);
  const markerDragCleanup = useRef<(() => void) | null>(null);
  useEffect(() => () => markerDragCleanup.current?.(), []);
  const project = useProjectStore((s) => s.project);
  const currentTime = usePlayerStore((s) => s.currentTime);
  const selectedWordIds = usePlayerStore((s) => s.selectedWordIds);
  const timelineMarkIn = usePlayerStore((s) => s.timelineMarkIn);
  const timelineMarkOut = usePlayerStore((s) => s.timelineMarkOut);
  const timelineZoom = usePlayerStore((s) => s.timelineZoom);
  const setCurrentTime = usePlayerStore((s) => s.setCurrentTime);
  const setSelectedWordIds = usePlayerStore((s) => s.setSelectedWordIds);
  const setTimelineRange = usePlayerStore((s) => s.setTimelineRange);
  const setTimelineZoom = usePlayerStore((s) => s.setTimelineZoom);
  const analysis = useTimelineAnalysis();
  const [dragStart, setDragStart] = useState<number | null>(null);
  const [dragging, setDragging] = useState(false);
  const [containerWidth, setContainerWidth] = useState(0);
  const [scrollLeft, setScrollLeft] = useState(0);

  const firstMedia = Object.values(project.media)[0];
  const duration = totalDuration(project);
  const zoomed = timelineZoom > 1.001;

  // ── Layout math ──────────────────────────────────────────────────────────
  // We size the rail relative to the scroll container's clientWidth. At zoom=1
  // the rail equals the container width (and no scrollbar appears). At zoom=N
  // the rail is N× that wide, so 1s of source occupies N times as many pixels.
  const railWidth = Math.max(0, containerWidth * timelineZoom);
  const pxPerSecond = duration > 0 ? railWidth / duration : 0;

  // ── Resize observer to keep `containerWidth` in sync ───────────────────────
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const measure = () => setContainerWidth(el.clientWidth);
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // ── Track scrollLeft for virtualisation + minimap ─────────────────────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    let raf = 0;
    const onScroll = () => {
      window.cancelAnimationFrame(raf);
      raf = window.requestAnimationFrame(() => setScrollLeft(el.scrollLeft));
    };
    el.addEventListener("scroll", onScroll, { passive: true });
    return () => {
      el.removeEventListener("scroll", onScroll);
      window.cancelAnimationFrame(raf);
    };
  }, []);

  // Reset scroll when the project changes or zoom drops back to 1.
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (!zoomed) {
      el.scrollLeft = 0;
      setScrollLeft(0);
    }
  }, [zoomed]);

  // ── Auto-follow playhead while playing ────────────────────────────────────
  const playing = usePlayerStore((s) => s.playing);
  const scrubbingNow = dragging;
  useEffect(() => {
    const el = scrollRef.current;
    if (!el || !zoomed || !playing || scrubbingNow) return;
    const playheadPx = currentTime * pxPerSecond;
    const left = el.scrollLeft;
    const right = left + el.clientWidth;
    // Keep playhead within the central 60% of the viewport — once it drifts
    // outside that band, scroll smoothly to recentre.
    const inset = el.clientWidth * 0.2;
    if (playheadPx < left + inset || playheadPx > right - inset) {
      const target = Math.max(0, playheadPx - el.clientWidth / 2);
      el.scrollTo({ left: target, behavior: "smooth" });
    }
  }, [currentTime, pxPerSecond, playing, scrubbingNow, zoomed]);

  // ── Wheel: horizontal pan; Cmd/Ctrl wheel = zoom around cursor ───────────
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    const onWheel = (e: globalThis.WheelEvent) => {
      if (e.ctrlKey || e.metaKey) {
        e.preventDefault();
        // Zoom factor — slower than the default to feel like a trackpad pinch.
        const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
        const beforeZoom = usePlayerStore.getState().timelineZoom;
        const newZoom = Math.max(1, Math.min(MAX_TIMELINE_ZOOM, beforeZoom * factor));
        if (Math.abs(newZoom - beforeZoom) < 1e-3) return;

        // Recentre so the time under the cursor stays put.
        const rect = el.getBoundingClientRect();
        const cursorX = e.clientX - rect.left;
        const beforePx = el.scrollLeft + cursorX;
        setTimelineZoom(newZoom);
        // Apply scroll fix in a microtask so React has re-rendered the rail width.
        window.requestAnimationFrame(() => {
          const scale = newZoom / beforeZoom;
          const afterPx = beforePx * scale;
          el.scrollLeft = Math.max(0, afterPx - cursorX);
        });
        return;
      }
      // Pan: trackpads emit deltaX, classic mice emit deltaY. Always treat
      // wheel-on-timeline as horizontal — vertical scrolling here is meaningless.
      if (!zoomed) return;
      const dx = e.deltaX !== 0 ? e.deltaX : e.deltaY;
      if (dx === 0) return;
      e.preventDefault();
      el.scrollLeft += dx;
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [setTimelineZoom, zoomed]);

  // ── Virtualised bars + ticks for the visible window ──────────────────────
  const visibleStartPx = Math.max(0, scrollLeft - VIRTUAL_OVERDRAW_PX);
  const visibleEndPx = scrollLeft + containerWidth + VIRTUAL_OVERDRAW_PX;
  const visibleStartSec = pxPerSecond > 0 ? visibleStartPx / pxPerSecond : 0;
  const visibleEndSec = pxPerSecond > 0 ? visibleEndPx / pxPerSecond : duration;

  const { bars, ticks } = useMemo(() => {
    if (pxPerSecond <= 0) return { bars: [] as BarSpec[], ticks: [] as TickSpec[] };
    const fillers = fillerCandidates(project);
    const nextBars: BarSpec[] = [];
    for (const block of projectTranscript(project)) {
      const runs = block.runs.filter((run) => run.text.trim());
      if (!runs.length) continue;
      // Show readable word blocks when there is room; otherwise summarize sentences.
      const detailed = pxPerSecond >= 75;
      const groups = detailed ? runs.map((run) => [run]) : [runs];
      for (const group of groups) {
        const outputStart = group[0]!.outputStart;
        const outputEnd = group.at(-1)!.outputEnd;
        if (outputEnd < visibleStartSec || outputStart > visibleEndSec) continue;
        const anchorIds = group.flatMap((run) => run.anchorIds);
        nextBars.push({
          id: `${block.segmentId}:${group[0]!.id}`,
          segmentId: block.segmentId,
          anchorIds,
          outputStart,
          leftPx: outputStart * pxPerSecond,
          widthPx: Math.max(2, (outputEnd - outputStart) * pxPerSecond),
          filler: fillers.some(
            (c) =>
              c.segmentId === block.segmentId && c.anchorIds.some((id) => anchorIds.includes(id)),
          ),
          selected: anchorIds.some((id) => selectedWordIds.has(id)),
          label: group.map((run) => run.text).join(" "),
          detailed,
        });
      }
    }

    // Density-aware tick step. At higher zoom we want finer divisions.
    const visibleDuration = Math.max(visibleEndSec - visibleStartSec, 1e-3);
    const tickStep =
      visibleDuration > 600
        ? 60
        : visibleDuration > 240
          ? 30
          : visibleDuration > 90
            ? 10
            : visibleDuration > 30
              ? 5
              : visibleDuration > 10
                ? 1
                : visibleDuration > 3
                  ? 0.5
                  : 0.1;
    const nextTicks: TickSpec[] = [];
    const firstTick = Math.ceil(visibleStartSec / tickStep) * tickStep;
    for (let t = firstTick; t <= visibleEndSec + 1e-6; t += tickStep) {
      nextTicks.push({
        leftPx: t * pxPerSecond,
        label: tickStep < 1 ? formatTimecode(t, { ms: true }) : formatTimecode(t, { ms: false }),
      });
    }
    return { bars: nextBars, ticks: nextTicks };
  }, [project, pxPerSecond, selectedWordIds, visibleEndSec, visibleStartSec]);

  // ── Pointer geometry ─────────────────────────────────────────────────────
  function outputTimeFromPointer(e: { clientX: number }) {
    const rail = railRef.current;
    if (!rail || railWidth <= 0) return null;
    const rect = rail.getBoundingClientRect();
    const x = e.clientX - rect.left;
    return Math.max(0, Math.min(duration, (x / railWidth) * duration));
  }

  function seekToOutputTime(outputTime: number) {
    if (!firstMedia) return;
    const mapped = outputTimeToSource(project, outputTime);
    if (!mapped) return;
    setCurrentTime(outputTime);
    window.dispatchEvent(
      new CustomEvent("yusafcut:seek-output", { detail: { time: outputTime, play: true } }),
    );
    usePlayerStore.getState().setPlaying(true);
  }

  function updateSelection(markIn: number, markOut: number) {
    window.dispatchEvent(new CustomEvent("yusafcut:pause"));
    usePlayerStore.getState().setPlaying(false);
    setTimelineRange(markIn, markOut);
    setSelectedWordIds(wordIdsInOutputRange(project, markIn, markOut));
  }

  function adjustMarker(side: "in" | "out", value: number) {
    if (!Number.isFinite(value)) return;
    const player = usePlayerStore.getState();
    const time = Math.max(0, Math.min(duration, value));
    const from = side === "in" ? time : player.timelineMarkIn;
    const to = side === "out" ? time : player.timelineMarkOut;
    if (from !== null && to !== null) updateSelection(from, to);
    else setTimelineRange(from, to);
  }
  function dragMarker(event: React.MouseEvent, side: "in" | "out") {
    event.preventDefault();
    event.stopPropagation();
    if (event.button !== 0) return;
    (event.currentTarget as HTMLElement).focus();
    markerDragCleanup.current?.();
    const move = (next: MouseEvent) => {
      const time = outputTimeFromPointer(next);
      if (time !== null) adjustMarker(side, time);
    };
    const finish = (release?: MouseEvent) => {
      // Consume the release before the rail can treat a marker drag as a click.
      release?.preventDefault();
      release?.stopPropagation();
      window.removeEventListener("mousemove", move);
      window.removeEventListener("mouseup", finish, true);
      markerDragCleanup.current = null;
    };
    markerDragCleanup.current = finish;
    window.addEventListener("mousemove", move);
    window.addEventListener("mouseup", finish, true);
  }
  function playSelection() {
    if (timelineMarkIn === null || timelineMarkOut === null || timelineMarkIn === timelineMarkOut)
      return;
    window.dispatchEvent(
      new CustomEvent("yusafcut:seek-output", {
        detail: { time: Math.min(timelineMarkIn, timelineMarkOut), play: true },
      }),
    );
  }

  function revealBar(bar: BarSpec) {
    setTimelineRange(null, null);
    setSelectedWordIds(new Set(bar.anchorIds));
    seekToOutputTime(bar.outputStart);
    window.dispatchEvent(
      new CustomEvent("yusafcut:reveal-review", {
        detail: { segmentId: bar.segmentId, anchorIds: bar.anchorIds },
      }),
    );
  }

  function handleMouseDown(e: React.MouseEvent<HTMLDivElement>) {
    if (e.button !== 0) return;
    e.preventDefault();
    e.currentTarget.focus({ preventScroll: true });
    const outputTime = outputTimeFromPointer(e);
    if (outputTime === null) return;
    setDragStart(outputTime);
    setDragging(false);
  }

  function handleMouseMove(e: React.MouseEvent<HTMLDivElement>) {
    if (dragStart === null) return;
    const outputTime = outputTimeFromPointer(e);
    if (outputTime === null) return;
    if (Math.abs(outputTime - dragStart) > 0.05) setDragging(true);
    updateSelection(dragStart, outputTime);
  }

  function handleMouseUp(e: React.MouseEvent<HTMLDivElement>) {
    const outputTime = outputTimeFromPointer(e);
    if (outputTime === null) return;
    if (dragStart === null) return;
    if (!dragging) {
      const block = (e.target as HTMLElement).closest<HTMLElement>("[data-timeline-block]");
      const bar = bars.find((candidate) => candidate.id === block?.dataset.timelineBlock);
      const gapElement = (e.target as HTMLElement).closest<HTMLElement>("[data-timeline-gap]");
      const gap = analysis.findings.find(
        (finding) => finding.id === gapElement?.dataset.timelineGap,
      );
      if (gap && gapElement) analysis.selectFinding(gap, gapElement);
      else if (bar) revealBar(bar);
      else seekToOutputTime(outputTime);
    } else {
      updateSelection(dragStart, outputTime);
    }
    setDragStart(null);
    setDragging(false);
  }

  // ── Minimap interaction (only shown when zoomed) ──────────────────────────
  const minimapRef = useRef<HTMLDivElement | null>(null);
  const minimapJumpTo = useCallback(
    (clientX: number) => {
      const el = minimapRef.current;
      const scroll = scrollRef.current;
      if (!el || !scroll || duration <= 0) return;
      const rect = el.getBoundingClientRect();
      const fraction = Math.max(0, Math.min(1, (clientX - rect.left) / rect.width));
      const target = fraction * railWidth - scroll.clientWidth / 2;
      scroll.scrollLeft = Math.max(0, target);
    },
    [duration, railWidth],
  );

  // ── Render ────────────────────────────────────────────────────────────────
  if (!firstMedia) {
    return (
      <div className="flex h-full items-center justify-center text-xs text-muted-foreground">
        Timeline appears once media is loaded
      </div>
    );
  }

  if (duration <= 0) {
    return (
      <div className="timeline-panel flex items-center justify-center text-xs text-muted-foreground">
        Transcribe to build an editable output timeline
      </div>
    );
  }

  const playheadLeftPx = currentTime * pxPerSecond;
  const hasTimelineRange = timelineMarkIn !== null && timelineMarkOut !== null;
  const markInPx = timelineMarkIn !== null ? timelineMarkIn * pxPerSecond : null;
  const markOutPx = timelineMarkOut !== null ? timelineMarkOut * pxPerSecond : null;
  const selectionStartPx = hasTimelineRange
    ? Math.min(timelineMarkIn!, timelineMarkOut!) * pxPerSecond
    : 0;
  const selectionWidthPx = hasTimelineRange
    ? Math.abs(timelineMarkOut! - timelineMarkIn!) * pxPerSecond
    : 0;

  // Minimap rectangle — fraction of full duration visible.
  const visibleFraction = railWidth > 0 ? Math.min(1, containerWidth / railWidth) : 1;
  const minimapWindowLeft = railWidth > 0 ? (scrollLeft / railWidth) * MINIMAP_WIDTH_PX : 0;
  const minimapWindowWidth = visibleFraction * MINIMAP_WIDTH_PX;
  const minimapPlayheadLeft = duration > 0 ? (currentTime / duration) * MINIMAP_WIDTH_PX : 0;

  return (
    <div className="timeline-panel" role="region" aria-label="Timeline">
      {analysis.actions}
      <div className="timeline-header">
        {analysis.controls}
        <div className="timeline-title">
          Timeline
          <span>
            <i className="legend-audio" /> kept audio
          </span>
          <span>
            <i className="legend-filler" /> filler
          </span>
          <span>
            <i className="legend-selected" /> selected
          </span>
        </div>

        {zoomed && (
          <div
            ref={minimapRef}
            className="timeline-minimap"
            style={{ width: MINIMAP_WIDTH_PX, height: MINIMAP_HEIGHT_PX }}
            onMouseDown={(e) => {
              minimapJumpTo(e.clientX);
              const onMove = (ev: MouseEvent) => minimapJumpTo(ev.clientX);
              const onUp = () => {
                window.removeEventListener("mousemove", onMove);
                window.removeEventListener("mouseup", onUp);
              };
              window.addEventListener("mousemove", onMove);
              window.addEventListener("mouseup", onUp);
            }}
            title="Drag to navigate"
          >
            <div
              className="timeline-minimap-window"
              style={{ left: minimapWindowLeft, width: minimapWindowWidth }}
            />
            <div className="timeline-minimap-playhead" style={{ left: minimapPlayheadLeft }} />
          </div>
        )}

        {hasTimelineRange && (
          <div className="timeline-range-controls">
            {(["in", "out"] as const).map((side) => (
              <label key={side}>
                {side === "in" ? "I" : "O"} (s)
                <input
                  type="number"
                  min={0}
                  max={duration}
                  step="0.01"
                  aria-label={side === "in" ? "Timeline in time" : "Timeline out time"}
                  value={Number((side === "in" ? timelineMarkIn! : timelineMarkOut!).toFixed(3))}
                  onChange={(event) => {
                    if (event.target.value !== "") adjustMarker(side, Number(event.target.value));
                  }}
                />
              </label>
            ))}
          </div>
        )}
        <Button
          size="sm"
          variant="outline"
          disabled={!hasTimelineRange || timelineMarkIn === timelineMarkOut}
          onClick={playSelection}
        >
          Play selection
        </Button>
        <Button
          size="sm"
          variant="outline"
          disabled={!hasTimelineRange || timelineMarkIn === timelineMarkOut}
          onClick={cutTimelineSelection}
        >
          Cut selection
        </Button>
        <div className="timeline-help">
          {zoomed
            ? `click text reveals · drag selects · I/O mark range · ⌘⇧X cuts · ⌘+scroll to zoom · zoom ${timelineZoom.toFixed(1)}x`
            : `click text reveals · drag selects · I/O mark range · ⌘⇧X cuts · zoom ${timelineZoom.toFixed(1)}x`}
        </div>
      </div>

      <div ref={scrollRef} className={zoomed ? "timeline-scroll is-zoomed" : "timeline-scroll"}>
        <div
          ref={railRef}
          tabIndex={0}
          aria-label="Timeline selection"
          title="Audio waveform above transcript blocks. Click text to reveal it in the transcript; drag to select audio."
          className="timeline-rail"
          style={{ width: railWidth || "100%" }}
          onMouseDown={handleMouseDown}
          onMouseMove={handleMouseMove}
          onMouseUp={handleMouseUp}
        >
          <div className="timeline-ticks">
            {ticks.map((tick) => (
              <span key={tick.leftPx.toFixed(2)} style={{ left: tick.leftPx }}>
                {tick.label}
              </span>
            ))}
          </div>
          <AudioWaveform
            project={project}
            startPx={visibleStartPx}
            endPx={Math.min(railWidth, visibleEndPx)}
            pxPerSecond={pxPerSecond}
          />
          {analysis.findings.map((finding) => (
            <button
              key={finding.id}
              type="button"
              className="timeline-unattributed"
              data-timeline-gap={finding.id}
              style={{
                left: finding.outputStart * pxPerSecond,
                width: Math.max(4, (finding.outputEnd - finding.outputStart) * pxPerSecond),
              }}
              aria-label={`Audio without words at ${formatTimecode(finding.outputStart, { ms: true })}`}
              title="Audio without words · click for actions"
              onClick={(event) => {
                if (event.detail === 0) analysis.selectFinding(finding, event.currentTarget);
              }}
            />
          ))}
          <div className="timeline-bars" aria-label={pxPerSecond >= 75 ? "Words" : "Sentences"}>
            {bars.map((bar) => (
              <button
                type="button"
                key={bar.id}
                data-timeline-block={bar.id}
                className={[
                  "timeline-bar",
                  bar.detailed ? "is-word" : "is-sentence",
                  bar.filler ? "is-filler" : "",
                  bar.selected ? "is-selected" : "",
                ].join(" ")}
                style={{ left: bar.leftPx, width: Math.max(2, bar.widthPx - 1) }}
                title={`${bar.label}${bar.filler ? " · contains filler" : ""} — reveal in transcript`}
                aria-label={`Reveal in transcript: ${bar.label}`}
                onClick={(event) => {
                  // Mouse activation is handled on release so dragging still selects audio.
                  if (event.detail === 0) revealBar(bar);
                }}
              >
                {bar.label}
              </button>
            ))}
          </div>
          {computeCutBoundaries(project).map((time) => (
            <div
              key={time}
              className="timeline-cut"
              style={{ left: time * pxPerSecond }}
              title={`Edit boundary · ${formatTimecode(time, { ms: true })}`}
            />
          ))}
          {hasTimelineRange && selectionWidthPx > 0.1 && (
            <div
              className="timeline-selection"
              style={{ left: selectionStartPx, width: selectionWidthPx }}
            >
              <span />
              <span />
            </div>
          )}
          {markInPx !== null && (
            <div
              className="timeline-marker is-in"
              style={{ left: markInPx }}
              role="slider"
              tabIndex={0}
              aria-label="In marker"
              aria-valuemin={0}
              aria-valuemax={duration}
              aria-valuenow={timelineMarkIn!}
              onMouseDown={(event) => dragMarker(event, "in")}
              onKeyDown={(event) => {
                if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
                  event.preventDefault();
                  event.stopPropagation();
                  adjustMarker(
                    "in",
                    timelineMarkIn! +
                      (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 0.1 : 0.01),
                  );
                }
              }}
            >
              <span>I</span>
            </div>
          )}
          {markOutPx !== null && (
            <div
              className="timeline-marker is-out"
              style={{ left: markOutPx }}
              role="slider"
              tabIndex={0}
              aria-label="Out marker"
              aria-valuemin={0}
              aria-valuemax={duration}
              aria-valuenow={timelineMarkOut!}
              onMouseDown={(event) => dragMarker(event, "out")}
              onKeyDown={(event) => {
                if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
                  event.preventDefault();
                  event.stopPropagation();
                  adjustMarker(
                    "out",
                    timelineMarkOut! +
                      (event.key === "ArrowRight" ? 1 : -1) * (event.shiftKey ? 0.1 : 0.01),
                  );
                }
              }}
            >
              <span>O</span>
            </div>
          )}
          {projectChapters(project).map((chapter) => {
            const leftPx = chapter.outputTime * pxPerSecond;
            return (
              <div
                key={chapter.id}
                className="timeline-chapter"
                style={{ left: leftPx }}
                title={`${chapter.title} (${chapter.outputTime.toFixed(2)}s) — click to jump`}
                onMouseDown={(e) => {
                  // Stop the rail drag from starting; treat as a chapter click.
                  e.stopPropagation();
                  seekToOutputTime(chapter.outputTime);
                }}
              >
                <span>{chapter.title}</span>
              </div>
            );
          })}
          <div className="timeline-playhead" style={{ left: playheadLeftPx }}>
            <span />
          </div>
        </div>
      </div>
    </div>
  );
}

// ─── local types kept down here to keep the JSX above readable ─────────────
type BarSpec = {
  id: string;
  leftPx: number;
  widthPx: number;
  segmentId: string;
  anchorIds: string[];
  outputStart: number;
  detailed: boolean;
  filler: boolean;
  selected: boolean;
  label: string;
};
type TickSpec = { leftPx: number; label: string };

function computeCutBoundaries(project: Parameters<typeof computeTimeline>[0]): number[] {
  const timeline = computeTimeline(project);
  return timeline
    .slice(1)
    .filter((entry, index) => {
      const previous = timeline[index]!;
      return (
        entry.mediaId !== previous.mediaId || Math.abs(entry.sourceIn - previous.sourceOut) > 0.001
      );
    })
    .map((entry) => entry.outputStart);
}
