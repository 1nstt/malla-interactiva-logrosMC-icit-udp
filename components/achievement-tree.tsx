"use client"

import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react"
import * as LucideIcons from "lucide-react"
import { CURRICULUM, AREA_COLORS, AREA_LABELS, type Course, type CourseType } from "@/lib/curriculum"

// ---- Layout constants (px) ----
const NODE = 60
const NODE_BIG = 84
const COL_W = 210
const ROW_H = 96
const PAD_X = 80
const PAD_Y = 130
const MOBILE_BREAKPOINT = 768
const MOBILE_INITIAL_SCALE = 0.45

interface Placed extends Course {
  x: number
  y: number
  size: number
}

interface Column {
  semester: number
  x: number
  ids: string[]
}

/**
 * Layered layout: columns follow the real semester, and within each column the
 * vertical order is refined with a barycenter heuristic so branches spread out
 * and converge organically (less rigid grid, more achievement-tree flow).
 */
function placeCourses(courses: Course[]): { placed: Placed[]; width: number; height: number; cols: Column[] } {
  const byId = new Map(courses.map((c) => [c.id, c]))

  // successors (children) map for backward sweeps
  const children = new Map<string, string[]>()
  for (const c of courses) {
    for (const p of c.prereqs) {
      if (!byId.has(p)) continue
      const arr = children.get(p) ?? []
      arr.push(c.id)
      children.set(p, arr)
    }
  }

  // group by semester (column)
  const columns = new Map<number, string[]>()
  for (const c of courses) {
    const arr = columns.get(c.semester) ?? []
    arr.push(c.id)
    columns.set(c.semester, arr)
  }
  const semesters = [...columns.keys()].sort((a, b) => a - b)

  // order index within each column
  const order = new Map<string, number>()
  for (const s of semesters) columns.get(s)!.forEach((id, i) => order.set(id, i))

  const barycenter = (id: string, neighbors: string[]) => {
    const vals = neighbors.map((n) => order.get(n)).filter((v): v is number => v !== undefined)
    if (vals.length === 0) return order.get(id)!
    return vals.reduce((a, b) => a + b, 0) / vals.length
  }

  // iterative crossing reduction
  for (let iter = 0; iter < 6; iter++) {
    // forward: order by prereqs (previous columns)
    for (let i = 1; i < semesters.length; i++) {
      const ids = columns.get(semesters[i])!
      ids.sort((a, b) => barycenter(a, byId.get(a)!.prereqs) - barycenter(b, byId.get(b)!.prereqs))
      ids.forEach((id, idx) => order.set(id, idx))
    }
    // backward: order by children (next columns)
    for (let i = semesters.length - 2; i >= 0; i--) {
      const ids = columns.get(semesters[i])!
      ids.sort((a, b) => barycenter(a, children.get(a) ?? []) - barycenter(b, children.get(b) ?? []))
      ids.forEach((id, idx) => order.set(id, idx))
    }
  }

  const maxRows = Math.max(...semesters.map((s) => columns.get(s)!.length))
  const canvasRows = Math.max(maxRows, 1)
  const height = PAD_Y * 2 + canvasRows * ROW_H

  const placed: Placed[] = []
  const cols: Column[] = []
  semesters.forEach((s, colIdx) => {
    const ids = columns.get(s)!
    const count = ids.length
    const colX = PAD_X + colIdx * COL_W
    cols.push({ semester: s, x: colX, ids: [...ids] })
    // center each column vertically inside the canvas
    const startY = (PAD_Y + ((canvasRows - count) * ROW_H) / 2)
    ids.forEach((id, row) => {
      const c = byId.get(id)!
      const size = c.id === "CIT-4002" ? NODE_BIG : NODE
      const x = colX + (NODE - size) / 2
      const y = startY + row * ROW_H + (NODE - size) / 2
      placed.push({ ...c, x, y, size })
    })
  })

  const width = PAD_X * 2 + semesters.length * COL_W
  return { placed, width, height, cols }
}

function IconFor({ name, className, style }: { name: string; className?: string; style?: CSSProperties }) {
  const Cmp = (LucideIcons as Record<string, unknown>)[name] as
    | React.ComponentType<{ className?: string; strokeWidth?: number; style?: CSSProperties }>
    | undefined
  const C = Cmp ?? LucideIcons.HelpCircle
  return <C className={className} style={style} strokeWidth={2.25} />
}

// ---- Mobile detection hook ----
function useIsMobile(breakpoint = MOBILE_BREAKPOINT) {
  const [isMobile, setIsMobile] = useState(false)
  useEffect(() => {
    const mql = window.matchMedia(`(max-width: ${breakpoint}px)`)
    setIsMobile(mql.matches)
    const handler = (e: MediaQueryListEvent) => setIsMobile(e.matches)
    mql.addEventListener("change", handler)
    return () => mql.removeEventListener("change", handler)
  }, [breakpoint])
  return isMobile
}

export function AchievementTree() {
  const { placed, width, height, cols } = useMemo(() => placeCourses(CURRICULUM), [])
  const byId = useMemo(() => new Map(placed.map((p) => [p.id, p])), [placed])
  const isMobile = useIsMobile()

  const [completed, setCompleted] = useState<Set<string>>(new Set())
  const [hovered, setHovered] = useState<string | null>(null)
  const [pointer, setPointer] = useState<{ x: number; y: number }>({ x: 0, y: 0 })
  const scrollRef = useRef<HTMLDivElement>(null)

  // ---- Mobile-specific state ----
  const [scale, setScale] = useState(1)
  const scaleRef = useRef(1)
  const [currentSem, setCurrentSem] = useState(1)
  const movedRef = useRef(false)

  // Keep scaleRef in sync for touch handlers (avoids stale closures)
  useEffect(() => { scaleRef.current = scale }, [scale])

  // Set initial scale on mobile/desktop switch
  useEffect(() => {
    if (isMobile) {
      setScale(MOBILE_INITIAL_SCALE)
      scaleRef.current = MOBILE_INITIAL_SCALE
    } else {
      setScale(1)
      scaleRef.current = 1
      setHovered(null)
    }
  }, [isMobile])

  // ---- Pinch-to-zoom + manual panning (mobile) ----
  useEffect(() => {
    if (!isMobile) return
    const el = scrollRef.current
    if (!el) return

    let panStart: { x: number; y: number; sl: number; st: number } | null = null
    let pinchStart: { dist: number; scale: number } | null = null

    const getDist = (touches: TouchList) =>
      Math.hypot(touches[0].clientX - touches[1].clientX, touches[0].clientY - touches[1].clientY)

    const onTouchStart = (e: TouchEvent) => {
      movedRef.current = false
      if (e.touches.length === 1) {
        panStart = {
          x: e.touches[0].clientX,
          y: e.touches[0].clientY,
          sl: el.scrollLeft,
          st: el.scrollTop,
        }
        pinchStart = null
      } else if (e.touches.length === 2) {
        panStart = null
        pinchStart = { dist: getDist(e.touches), scale: scaleRef.current }
      }
    }

    const onTouchMove = (e: TouchEvent) => {
      e.preventDefault()
      if (e.touches.length === 1 && panStart) {
        const dx = e.touches[0].clientX - panStart.x
        const dy = e.touches[0].clientY - panStart.y
        if (Math.abs(dx) > 5 || Math.abs(dy) > 5) {
          movedRef.current = true
        }
        el.scrollLeft = panStart.sl - dx
        el.scrollTop = panStart.st - dy
      } else if (e.touches.length === 2 && pinchStart) {
        movedRef.current = true
        const ratio = getDist(e.touches) / pinchStart.dist
        const newScale = Math.min(1.2, Math.max(0.25, pinchStart.scale * ratio))
        scaleRef.current = newScale
        setScale(newScale)
      }
    }

    const onTouchEnd = () => {
      panStart = null
      pinchStart = null
    }

    el.addEventListener("touchstart", onTouchStart, { passive: false })
    el.addEventListener("touchmove", onTouchMove, { passive: false })
    el.addEventListener("touchend", onTouchEnd)
    el.addEventListener("touchcancel", onTouchEnd)

    return () => {
      el.removeEventListener("touchstart", onTouchStart)
      el.removeEventListener("touchmove", onTouchMove)
      el.removeEventListener("touchend", onTouchEnd)
      el.removeEventListener("touchcancel", onTouchEnd)
    }
  }, [isMobile])

  // ---- Track current semester from scroll position (mobile) ----
  useEffect(() => {
    if (!isMobile) return
    const el = scrollRef.current
    if (!el) return

    const onScroll = () => {
      const viewCenterX = (el.scrollLeft + el.clientWidth / 2) / scale
      let closest = cols[0]?.semester ?? 1
      let minDist = Infinity
      for (const col of cols) {
        const d = Math.abs(col.x + NODE / 2 - viewCenterX)
        if (d < minDist) { minDist = d; closest = col.semester }
      }
      setCurrentSem(closest)
    }

    el.addEventListener("scroll", onScroll, { passive: true })
    return () => el.removeEventListener("scroll", onScroll)
  }, [isMobile, scale, cols])

  // ---- Background music ----
  const bgAudioRef = useRef<HTMLAudioElement | null>(null)
  const [musicOn, setMusicOn] = useState(true)
  const startedRef = useRef(false)

  useEffect(() => {
    const audio = new Audio("/sounds/SubwooferLullaby.mp3")
    audio.loop = true
    audio.volume = 0.5
    bgAudioRef.current = audio

    // Start playback on the very first click anywhere on the page,
    // as required by browser autoplay policies.
    const startOnFirstClick = () => {
      if (startedRef.current) return
      startedRef.current = true
      if (musicOn) {
        audio.play().catch(() => {})
      }
      window.removeEventListener("click", startOnFirstClick)
    }

    window.addEventListener("click", startOnFirstClick)

    return () => {
      window.removeEventListener("click", startOnFirstClick)
      audio.pause()
      bgAudioRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const toggleMusic = () => {
    setMusicOn((prev) => {
      const next = !prev
      const audio = bgAudioRef.current
      if (audio) {
        if (next) {
          // If the song hasn't started yet (no click happened before this one),
          // this click also counts as the "first click" that starts it.
          startedRef.current = true
          audio.play().catch(() => {})
        } else {
          audio.pause()
        }
      }
      return next
    })
  }

  const isAvailable = (c: Course) => c.prereqs.every((p) => completed.has(p))

  const playClickSound = () => {
    const audio = new Audio("/sounds/achievement.mp3")
    audio.volume = 1
    audio.play().catch(() => {})
  }

  const toggle = (id: string) => {
    playClickSound()

    setCompleted((prev) => {
      const next = new Set(prev)

      if (next.has(id)) next.delete(id)
      else next.add(id)

      return next
    })
  }

  // Toggle a whole semester: if every course is done, clear them; otherwise complete all.
  const toggleSemester = (ids: string[]) => {
    playClickSound()

    setCompleted((prev) => {
      const next = new Set(prev)
      const allDone = ids.every((id) => next.has(id))

      for (const id of ids) {
        if (allDone) next.delete(id)
        else next.add(id)
      }

      return next
    })
  }

  // ---- Node click: mobile selects (hover), desktop toggles ----
  const handleNodeClick = (id: string, e?: React.MouseEvent) => {
    if (isMobile) {
      if (movedRef.current) return // Ignore click after drag/pinch
      e?.stopPropagation() // Prevent the viewport onClick from clearing immediately
      setHovered(id)
      if (e) setPointer({ x: e.clientX, y: e.clientY })
    } else {
      toggle(id)
    }
  }

  // ---- Semester navigation (mobile) ----
  const minSem = cols[0]?.semester ?? 1
  const maxSem = cols[cols.length - 1]?.semester ?? 11

  const scrollToSemester = (sem: number) => {
    const col = cols.find((c) => c.semester === sem)
    if (!col || !scrollRef.current) return
    const el = scrollRef.current
    const targetX = (col.x + NODE / 2) * scale - el.clientWidth / 2
    el.scrollTo({ left: Math.max(0, targetX), behavior: "smooth" })
    setCurrentSem(sem)
  }

  // ---- Progress stats (credits + course count) ----
  const totalCredits = useMemo(() => placed.reduce((sum, c) => sum + c.credits, 0), [placed])
  const approvedCredits = useMemo(
    () => placed.filter((c) => completed.has(c.id)).reduce((sum, c) => sum + c.credits, 0),
    [placed, completed],
  )
  const creditsPct = totalCredits > 0 ? Math.round((approvedCredits / totalCredits) * 100) : 0
  const coursesPct = placed.length > 0 ? Math.round((completed.size / placed.length) * 100) : 0

  const hoveredCourse = hovered ? byId.get(hovered) : null

  // edges related to the hovered node (its prereqs + its children)
  const relatedEdges = useMemo(() => {
    if (!hovered) return new Set<string>()
    const set = new Set<string>()
    const hc = byId.get(hovered)
    hc?.prereqs.forEach((p) => set.add(`${p}->${hovered}`))
    for (const c of placed) if (c.prereqs.includes(hovered)) set.add(`${hovered}->${c.id}`)
    return set
  }, [hovered, byId, placed])

  const onMove = (e: React.MouseEvent) => {
    if (isMobile) return
    // Use viewport coordinates; the tooltip is position:fixed so it never
    // affects the scrollable content size (which was causing the layout jump).
    setPointer({ x: e.clientX, y: e.clientY })
  }

  // ---- Effective scale (only applied on mobile) ----
  const effectiveScale = isMobile ? scale : 1

  return (
    <div className="flex h-full min-h-screen flex-col bg-[#1b1b1b] text-[#e6e6e6]">
      {/* Top bar */}
      <header className="mc-panel-top flex items-center gap-2 px-3 py-2 sm:gap-3 sm:px-4 sm:py-3">
        <IconFor name="Trophy" className="h-5 w-5 shrink-0 text-[#ffcf3f]" />
        <div className="min-w-0">
          <h1 className="font-mc truncate text-[10px] leading-relaxed text-[#e6e6e6] sm:text-[12px]">
            Arbol de Logros
          </h1>
          <p className="font-mc-body hidden text-base leading-none text-[#9a9a9a] sm:block sm:text-lg">
            Ing. Civil en Informatica y Telecomunicaciones UDP, Malla 2020
          </p>
        </div>

        <button
          type="button"
          onClick={toggleMusic}
          aria-label={musicOn ? "Silenciar música" : "Activar música"}
          aria-pressed={musicOn}
          className="mc-button ml-auto flex h-9 w-9 shrink-0 items-center justify-center !p-0 leading-none"
          title={musicOn ? "Silenciar música" : "Activar música"}
        >
          {musicOn ? (
            <LucideIcons.Volume2 className="h-5 w-5 text-[#e6e6e6]" strokeWidth={2.25} />
          ) : (
            <LucideIcons.VolumeX className="h-5 w-5 text-[#565656]" strokeWidth={2.25} />
          )}
        </button>
      </header>

      {/* Tree viewport */}
      <div
        ref={scrollRef}
        onMouseMove={onMove}
        onClick={() => { if (isMobile) setHovered(null) }}
        className="mc-tree-bg relative flex-1 overflow-auto"
        style={isMobile ? { touchAction: "none" } : undefined}
      >
        {/* Scale wrapper — on mobile, the outer div sets the scrollable area
            to match the scaled canvas, while the inner div applies the CSS
            transform. On desktop this is transparent (scale = 1). */}
        <div
          style={effectiveScale !== 1 ? { width: width * effectiveScale, height: height * effectiveScale } : undefined}
        >
          <div
            className={effectiveScale !== 1 ? "relative" : "relative mx-auto"}
            style={{
              width,
              height,
              ...(effectiveScale !== 1
                ? { transform: `scale(${effectiveScale})`, transformOrigin: "0 0" }
                : {}),
            }}
          >
            {/* Semester header buttons */}
            {cols.map((col) => {
              const total = col.ids.length
              const doneCount = col.ids.filter((id) => completed.has(id)).length
              const allDone = doneCount === total
              return (
                <button
                  key={`sem-${col.semester}`}
                  type="button"
                  onClick={() => toggleSemester(col.ids)}
                  className="mc-sem-btn absolute grid place-items-center gap-0.5"
                  style={{ left: col.x - (COL_W - NODE) / 2, top: 20, width: COL_W - 24 } as CSSProperties}
                  aria-label={`Marcar semestre ${col.semester} completo`}
                  data-done={allDone || undefined}
                >
                  <span className="font-mc text-[8px] leading-none">Sem {col.semester}</span>
                  <span className="font-mc-body text-sm leading-none opacity-80">
                    {doneCount}/{total}
                  </span>
                </button>
              )
            })}

            {/* Connectors — every edge is drawn as a faint dotted line for context;
                when a node is hovered, its prerequisite chain and what it unlocks
                are highlighted as solid lines. Drawing every edge solid at once
                turned the dense curriculum graph into unreadable spaghetti. */}
            <svg className="pointer-events-none absolute inset-0" width={width} height={height} aria-hidden="true">
              {placed.map((c) =>
                c.prereqs.map((pid) => {
                  const p = byId.get(pid)
                  if (!p) return null
                  const key = `${pid}->${c.id}`
                  const active = hovered ? relatedEdges.has(key) : false
                  // Skip the faint version for active edges (the solid pass covers them).
                  if (!active) {
                    const sx = p.x + p.size
                    const sy = p.y + p.size / 2
                    const ex = c.x
                    const ey = c.y + c.size / 2
                    const dx = Math.max(30, (ex - sx) * 0.5)
                    const d = `M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`
                    return (
                      <path
                        key={key}
                        d={d}
                        fill="none"
                        stroke="#9a9ad0"
                        strokeWidth={1.5}
                        strokeDasharray="2 5"
                        strokeLinecap="round"
                        opacity={hovered ? 0.12 : 0.28}
                      />
                    )
                  }
                  return null
                }),
              )}
              {hovered &&
                placed.map((c) =>
                  c.prereqs.map((pid) => {
                    const key = `${pid}->${c.id}`
                    if (!relatedEdges.has(key)) return null
                    const p = byId.get(pid)
                    if (!p) return null
                    const sx = p.x + p.size
                    const sy = p.y + p.size / 2
                    const ex = c.x
                    const ey = c.y + c.size / 2
                    const dx = Math.max(30, (ex - sx) * 0.5)
                    const d = `M ${sx} ${sy} C ${sx + dx} ${sy}, ${ex - dx} ${ey}, ${ex} ${ey}`
                    const done = completed.has(pid) && completed.has(c.id)
                    const stroke = done ? "#7fd15b" : "#ffcf3f"
                    return (
                      <g key={key}>
                        <path d={d} fill="none" stroke="#0d0d0d" strokeWidth={6.5} strokeLinecap="round" />
                        <path d={d} fill="none" stroke={stroke} strokeWidth={3} strokeLinecap="round" />
                        <path
                          d={`M ${ex - 9} ${ey - 5} L ${ex - 1} ${ey} L ${ex - 9} ${ey + 5}`}
                          fill="none"
                          stroke={stroke}
                          strokeWidth={3}
                          strokeLinejoin="round"
                          strokeLinecap="round"
                        />
                      </g>
                    )
                  }),
                )}
            </svg>

            {/* Nodes */}
            {placed.map((c) => {
              const done = completed.has(c.id)
              const available = isAvailable(c)
              const dim =
                !!hovered &&
                hovered !== c.id &&
                !c.prereqs.includes(hovered) &&
                !(hoveredCourse?.prereqs.includes(c.id) ?? false)
              return (
                <button
                  key={c.id}
                  type="button"
                  onClick={(e) => handleNodeClick(c.id, e)}
                  onMouseEnter={() => !isMobile && setHovered(c.id)}
                  onMouseLeave={() => !isMobile && setHovered((h) => (h === c.id ? null : h))}
                  aria-label={`${c.achievement} — ${c.subject}`}
                  aria-pressed={done}
                  className={mcSlotClass(c.type, done, available, !!dim)}
                  style={{ left: c.x, top: c.y, width: c.size, height: c.size } as CSSProperties}
                >
                  <IconFor
                    name={c.icon}
                    className={iconClass(done)}
                    style={{ color: done ? AREA_COLORS[c.area] : undefined }}
                  />
                  {!done && !available && (
                    <span className="pointer-events-none absolute -bottom-1.5 -right-1.5 grid h-5 w-5 place-items-center border-2 border-[#0d0d0d] bg-[#3a3a3a]">
                      <LucideIcons.Lock className="h-3 w-3 text-[#d8d8d8]" strokeWidth={3} aria-hidden="true" />
                    </span>
                  )}
                </button>
              )
            })}
          </div>
        </div>

        {/* Tooltip (shown on hover for desktop, on tap for mobile) */}
        {hoveredCourse && (
          <MinecraftTooltip
            course={hoveredCourse}
            done={completed.has(hoveredCourse.id)}
            available={isAvailable(hoveredCourse)}
            x={pointer.x}
            y={pointer.y}
          />
        )}
      </div>

      {/* ---- Mobile floating controls ---- */}
      {isMobile && (
        <>
          {/* Zoom controls */}
          <div className="mc-zoom-controls">
            <button
              type="button"
              className="mc-button font-mc text-base !px-2.5 !py-1"
              onClick={() => setScale((s) => Math.min(1.2, +(s + 0.1).toFixed(2)))}
              aria-label="Acercar"
            >
              +
            </button>
            <span className="font-mc text-[7px] leading-none text-[#a8a8a8]">
              {Math.round(scale * 100)}%
            </span>
            <button
              type="button"
              className="mc-button font-mc text-base !px-2.5 !py-1"
              onClick={() => setScale((s) => Math.max(0.25, +(s - 0.1).toFixed(2)))}
              aria-label="Alejar"
            >
              −
            </button>
          </div>

          {/* Semester navigation */}
          <div className="mc-sem-nav">
            <button
              type="button"
              className="mc-button font-mc text-xs !px-2 !py-1"
              onClick={() => scrollToSemester(currentSem - 1)}
              disabled={currentSem <= minSem}
              aria-label="Semestre anterior"
            >
              ◀
            </button>
            <span className="font-mc text-[9px] text-[#e6e6e6] min-w-[48px] text-center">
              Sem {currentSem}
            </span>
            <button
              type="button"
              className="mc-button font-mc text-xs !px-2 !py-1"
              onClick={() => scrollToSemester(currentSem + 1)}
              disabled={currentSem >= maxSem}
              aria-label="Semestre siguiente"
            >
              ▶
            </button>
          </div>
        </>
      )}

      {/* ---- Mobile: floating complete button (appears when a course is selected) ---- */}
      {isMobile && hoveredCourse && (
        <div className="mc-complete-btn">
          <button
            type="button"
            onClick={() => toggle(hoveredCourse.id)}
            className={`mc-button font-mc text-[9px] whitespace-nowrap ${
              completed.has(hoveredCourse.id) ? "mc-button--uncomplete" : "mc-button--complete"
            }`}
          >
            {completed.has(hoveredCourse.id) ? "✕ Descompletar" : "✓ Completar"}
          </button>
        </div>
      )}

      {/* Bottom bar */}
      <footer className="mc-panel-bottom flex flex-wrap items-center gap-2 px-3 py-2 sm:flex-nowrap sm:gap-3 sm:px-4 sm:py-3">
        <p className="hidden shrink-0 font-mc-body text-lg text-[#a8a8a8] lg:block">
          Clic para completar un ramo · pasa el mouse para ver el logro y sus prerrequisitos
        </p>

        <div className="flex w-full flex-col gap-1 order-first sm:order-none sm:w-auto sm:flex-1 sm:max-w-md">
          <XPBar label={`Créditos aprobados: ${approvedCredits}/${totalCredits}`} pct={creditsPct} />
          <XPBar label={`Total ramos: ${completed.size}/${placed.length}`} pct={coursesPct} />
        </div>

        <div className="flex shrink-0 gap-2">
          <button
            type="button"
            onClick={() => {
              playClickSound()
              setCompleted(new Set(placed.map((p) => p.id)))
            }}
            className="mc-button font-mc text-[9px]"
          >
            Todo
          </button>
          <button
            type="button"
            onClick={() => {
              playClickSound()
              setCompleted(new Set())
            }}
            className="mc-button font-mc text-[9px]"
          >
            Reiniciar
          </button>
        </div>
        <div className="flex shrink-0 items-center gap-2 pl-2">
          <a href="https://github.com/1nstt" target="_blank" rel="noopener noreferrer" aria-label="Perfil de GitHub" className="flex h-8 w-8 items-center justify-center transition-transform hover:scale-110">
            <img src="/github.svg" alt="GitHub" className="h-6 w-6" />
          </a>
          <img src="/heart.png" alt="" aria-hidden="true" className="h-5 w-5" />
          <span className="font-mc-body text-sm text-[#a8a8a8] whitespace-nowrap sm:text-base">Hecho por Renato Y.</span>
        </div>
      </footer>
    </div>
  )
}

/** Minecraft-style XP bar: dark bevel border, green fill, pixel-font label centered on top. */
function XPBar({ label, pct }: { label: string; pct: number }) {
  const clamped = Math.min(100, Math.max(0, pct))
  return (
    <div
      className="mc-xp-bar relative h-5 w-full overflow-hidden"
      role="progressbar"
      aria-valuenow={clamped}
      aria-valuemin={0}
      aria-valuemax={100}
    >
      <div className="mc-xp-bar__fill absolute inset-y-0 left-0" style={{ width: `${clamped}%` }} />
      <div className="pointer-events-none absolute inset-0 grid place-items-center px-1">
        <span className="mc-xp-bar__label font-mc text-[8px] leading-none">
          {label} ({clamped}%)
        </span>
      </div>
    </div>
  )
}

function mcSlotClass(type: CourseType, done: boolean, available: boolean, dim: boolean) {
  const base =
    "mc-slot absolute grid place-items-center transition-[filter,transform,opacity] duration-100 hover:z-20 hover:scale-[1.08] focus:outline-none focus-visible:ring-2 focus-visible:ring-[#ffcf3f]"
  const variant = type === "challenge" ? "mc-slot--challenge" : type === "goal" ? "mc-slot--goal" : ""
  const state = done ? "mc-slot--done" : available ? "mc-slot--available" : "mc-slot--locked"
  const dimmed = dim ? "opacity-40" : ""
  return `${base} ${variant} ${state} ${dimmed}`.trim()
}

function iconClass(done: boolean) {
  if (done) return "h-7 w-7 drop-shadow-[0_1px_0_rgba(0,0,0,0.7)]"
  return "h-7 w-7 text-[#565656]"
}

function MinecraftTooltip({
  course,
  done,
  available,
  x,
  y,
}: {
  course: Course
  done: boolean
  available: boolean
  x: number
  y: number
}) {
  const TOOLTIP_W = 300
  const TOOLTIP_H = 190
  // Clamp against the viewport since the tooltip is position:fixed.
  const vw = typeof window !== "undefined" ? window.innerWidth : 0
  const vh = typeof window !== "undefined" ? window.innerHeight : 0
  const flipX = x + TOOLTIP_W + 28 > vw
  const rawLeft = flipX ? x - TOOLTIP_W - 16 : x + 16
  const left = Math.max(8, Math.min(rawLeft, vw - TOOLTIP_W - 8))
  const top = Math.min(Math.max(8, y + 16), Math.max(8, vh - TOOLTIP_H))

  const titleColor =
    course.type === "challenge" ? "text-[#ffcf3f]" : course.type === "goal" ? "text-[#7fd15b]" : "text-[#f4f4f4]"

  const statusText = done ? "Logro desbloqueado" : available ? "Disponible" : "Bloqueado · faltan prerrequisitos"
  const statusColor = done ? "text-[#7fd15b]" : available ? "text-[#c8c8c8]" : "text-[#e06c6c]"

  return (
    <div className="mc-tooltip pointer-events-none fixed z-50" style={{ left, top, width: TOOLTIP_W }}>
      <p className={`font-mc text-[10px] leading-relaxed ${titleColor}`}>{course.achievement}</p>
      <p className="mt-2 font-mc-body text-lg leading-tight text-[#d6d6d6]">{course.description}</p>
      <div className="mt-2 border-t border-[#3a3a5a] pt-2">
        <p className="font-mc-body text-base text-[#9a9ad0]">
          <span className="font-semibold" style={{ color: AREA_COLORS[course.area] }}>
            {course.subject}
          </span>{" "}
          · {course.id}
        </p>
        <p className="font-mc-body text-sm" style={{ color: AREA_COLORS[course.area] }}>
          {AREA_LABELS[course.area]} · {course.credits} créditos
        </p>
        <p className={`mt-1 font-mc-body text-base ${statusColor}`}>{statusText}</p>
      </div>
    </div>
  )
}
