// ============================================================================
//  WeeklyPulse.jsx
//  Drop into your React/Supabase pipeline tool.
//
//  Architecture (matches pulse_schema.sql):
//    - Counters are the ONLY net-new writes (pulse_activity_log).
//    - Musts are a READ-VIEW over your deals' Next Move field (v_weekly_musts_current).
//    - The checkbox is the ONE write back to deals: tick -> advance (write successor
//      to deals.next_move) or park (set deals.pulse_status='waiting' + follow-up).
//
//  Assumes a configured client at ./supabaseClient exporting `supabase`.
//  If your deals.id is uuid, the schema's deal_id columns must match — no code
//  change needed here (ids are passed through opaquely).
// ============================================================================
import { useEffect, useState, useCallback } from "react";
import { supabase } from "./supabaseClient";
import "./WeeklyPulse.css";

const COUNTERS = [
  { type: "discovery",   label: "Discovery convos" },
  { type: "opp_created", label: "New opps created" },
  { type: "next_step",   label: "Next steps secured" },
  { type: "multithread", label: "Multi-thread touches" },
];
const DEFAULT_TARGETS = { discovery: 5, opp_created: 3, next_step: 4, multithread: 8 };

export default function WeeklyPulse() {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(null);
  const [activity, setActivity] = useState([]);     // rows from v_pulse_activity_current
  const [targets, setTargets] = useState(DEFAULT_TARGETS);
  const [musts, setMusts] = useState([]);            // rows from v_weekly_musts_current
  const [advanced, setAdvanced] = useState(0);
  const [openDeals, setOpenDeals] = useState([]);    // candidates for "add a must"

  // ---- loaders -------------------------------------------------------------
  const load = useCallback(async () => {
    setError(null);
    const [a, t, m, adv] = await Promise.all([
      supabase.from("v_pulse_activity_current").select("id, type, deal_id, deal_name"),
      supabase.from("pulse_activity_target").select("type, target"),
      supabase.from("v_weekly_musts_current").select("*"),
      supabase.from("v_advanced_count_current").select("advanced").single(),
    ]);
    const firstErr = a.error || t.error || m.error || adv.error;
    if (firstErr) { setError(firstErr.message); setLoading(false); return; }

    setActivity(a.data ?? []);
    if (t.data?.length) {
      setTargets(t.data.reduce((acc, r) => ({ ...acc, [r.type]: r.target }), { ...DEFAULT_TARGETS }));
    }
    setMusts((m.data ?? []).map((r) => ({ ...r, ui: "idle", draftMove: "", draftDate: "" })));
    setAdvanced(adv.data?.advanced ?? 0);
    setLoading(false);
  }, []);

  const loadOpenDeals = useCallback(async () => {
    // deals with a live next_move that aren't already a must this week
    const mustIds = new Set(musts.map((x) => x.deal_id));
    const { data } = await supabase
      .from("deals")
      .select("id, name, next_move")
      .not("next_move", "is", null)
      .order("name");
    setOpenDeals((data ?? []).filter((d) => !mustIds.has(d.id)));
  }, [musts]);

  useEffect(() => { load(); }, [load]);
  useEffect(() => { loadOpenDeals(); }, [loadOpenDeals]);

  // ---- counter writes ------------------------------------------------------
  async function addTap(type, dealId) {
    const { data, error } = await supabase
      .from("pulse_activity_log")
      .insert({ type, deal_id: dealId ?? null })
      .select("id")
      .single();
    if (error) return setError(error.message);
    // optimistic: need deal_name for the chip
    let dealName = null;
    if (dealId) dealName = openDeals.find((d) => d.id === dealId)?.name
                        ?? musts.find((m) => m.deal_id === dealId)?.name ?? "deal";
    setActivity((prev) => [...prev, { id: data.id, type, deal_id: dealId ?? null, deal_name: dealName }]);
  }
  async function removeTap(id) {
    setActivity((prev) => prev.filter((r) => r.id !== id)); // optimistic
    const { error } = await supabase.from("pulse_activity_log").delete().eq("id", id);
    if (error) { setError(error.message); load(); }
  }

  // ---- must writes (the single write-back) ---------------------------------
  function setMustUI(dealId, patch) {
    setMusts((prev) => prev.map((m) => (m.deal_id === dealId ? { ...m, ...patch } : m)));
  }
  async function advanceMove(row) {
    const successor = row.draftMove.trim();
    if (!successor) return;
    const { error } = await supabase.rpc("advance_next_move", {
      p_deal_id: row.deal_id, p_old_move: row.next_move, p_successor: successor,
    });
    if (error) return setError(error.message);
    setMustUI(row.deal_id, {
      next_move: successor, next_move_scheduled_for: null, pulse_status: "active",
      ui: "idle", draftMove: "",
    });
    setAdvanced((n) => n + 1);
  }
  async function parkMove(row) {
    const date = row.draftDate || null;
    const [{ error: e1 }, { error: e2 }] = await Promise.all([
      supabase.from("deals").update({ pulse_status: "waiting", waiting_follow_up: date }).eq("id", row.deal_id),
      supabase.from("next_move_log").insert({ deal_id: row.deal_id, move: row.next_move, resolution: "parked", follow_up: date }),
    ]);
    if (e1 || e2) return setError((e1 || e2).message);
    setMustUI(row.deal_id, { pulse_status: "waiting", waiting_follow_up: date, ui: "idle" });
    setAdvanced((n) => n + 1);
  }
  async function resumeMove(row) {
    const { error } = await supabase.from("deals").update({ pulse_status: "active" }).eq("id", row.deal_id);
    if (error) return setError(error.message);
    setMustUI(row.deal_id, { pulse_status: "active", ui: "choosing" });
  }
  async function addMust(dealId) {
    if (!dealId) return;
    const { error } = await supabase.from("weekly_must").insert({ deal_id: Number(dealId) });
    if (error) return setError(error.message);
    load();
  }

  if (loading) return <div className="pulse"><p className="pulse-muted">Loading this week…</p></div>;

  const tagsFor = (type) => activity.filter((a) => a.type === type);

  return (
    <div className="pulse">
      {error && <div className="pulse-error">{error}</div>}

      <header className="pulse-head">
        <h2>Weekly pulse</h2>
        <span className="pulse-muted">advanced this week: <strong>{advanced}</strong></span>
      </header>

      {/* ---- COUNTERS (writes) ---- */}
      <p className="pulse-section">This week's signal — tap +, tag the deal</p>
      <div className="pulse-counters">
        {COUNTERS.map(({ type, label }) => {
          const tags = tagsFor(type);
          const hit = tags.length >= (targets[type] ?? 0);
          return (
            <div className="counter" key={type}>
              <div className="counter-label">{label}</div>
              <div className={"counter-num" + (hit ? " hit" : "")}>
                {tags.length}<span className="counter-target">/ {targets[type]}</span>
              </div>
              <div className="chips">
                {tags.map((t) => (
                  <button className="chip" key={t.id} title="remove" onClick={() => removeTap(t.id)}>
                    {t.deal_name ?? "untagged"}
                  </button>
                ))}
              </div>
              <TagAdder deals={[...openDeals, ...musts.map((m) => ({ id: m.deal_id, name: m.name }))]}
                        onAdd={(dealId) => addTap(type, dealId)} />
            </div>
          );
        })}
      </div>

      {/* ---- MUSTS (read-view + the single write-back) ---- */}
      <p className="pulse-section">Your musts — next move · has a block?</p>
      <div className="musts">
        {musts.length === 0 && <p className="pulse-muted">No musts yet this week.</p>}
        {musts.map((row) => <MustRow key={row.deal_id} row={row}
          onCheck={() => setMustUI(row.deal_id, { ui: row.ui === "choosing" ? "idle" : "choosing" })}
          onDraftMove={(v) => setMustUI(row.deal_id, { draftMove: v })}
          onDraftDate={(v) => setMustUI(row.deal_id, { draftDate: v })}
          onAdvance={() => advanceMove(row)}
          onPark={() => parkMove(row)}
          onResume={() => resumeMove(row)}
        />)}
      </div>

      <AddMust deals={openDeals} onAdd={addMust} />
    </div>
  );
}

// ---- a single must row ------------------------------------------------------
function MustRow({ row, onCheck, onDraftMove, onDraftDate, onAdvance, onPark, onResume }) {
  const waiting = row.pulse_status === "waiting";
  const choosing = row.ui === "choosing";
  const hasMove = !!row.next_move;
  const block = row.next_move_scheduled_for;

  return (
    <div className={"must" + (waiting ? " parked" : "")}>
      <div className="must-main">
        <span className="must-check">
          {!hasMove ? null
            : waiting
              ? <button className="linkbtn" title="resume" onClick={onResume}>↻</button>
              : <input type="checkbox" aria-label="mark next move done" checked={choosing} onChange={onCheck} />}
        </span>

        <span className="must-out">{row.name}</span>

        <span className="must-move">
          {hasMove
            ? <span className={choosing ? "done" : ""}>{row.next_move}</span>
            : <span className="needs-move">needs a next move</span>}
        </span>

        <span className="must-status">
          {waiting
            ? <span className="pill-wait">waiting · {fmtDate(row.waiting_follow_up)}</span>
            : !hasMove
              ? <span className="muted">—</span>
              : block
                ? <span className="ok">{fmtBlock(block)}</span>
                : <span className="warn">no block</span>}
        </span>
      </div>

      {choosing && (
        <div className="panel">
          <div className="panel-q">Done. What's the next controllable move?</div>
          <div className="panel-row">
            <input type="text" placeholder="e.g. book technical review with champion"
                   value={row.draftMove}
                   onChange={(e) => onDraftMove(e.target.value)}
                   onKeyDown={(e) => e.key === "Enter" && onAdvance()} />
            <button onClick={onAdvance}>Add move</button>
          </div>
          <div className="panel-or">or — nothing in your control right now?</div>
          <div className="panel-row">
            <span className="pulse-muted">Waiting on buyer · follow up</span>
            <input type="date" value={row.draftDate} onChange={(e) => onDraftDate(e.target.value)} />
            <button onClick={onPark}>Park it</button>
          </div>
        </div>
      )}
    </div>
  );
}

function TagAdder({ deals, onAdd }) {
  const [val, setVal] = useState("");
  return (
    <div className="tag-add">
      <select value={val} onChange={(e) => setVal(e.target.value)}>
        <option value="">tag a deal…</option>
        {deals.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
      </select>
      <button onClick={() => { onAdd(val ? Number(val) : null); setVal(""); }}>+</button>
    </div>
  );
}

function AddMust({ deals, onAdd }) {
  const [val, setVal] = useState("");
  return (
    <div className="add-must">
      <select value={val} onChange={(e) => setVal(e.target.value)}>
        <option value="">add a must (a deal's current next move)…</option>
        {deals.map((d) => <option key={d.id} value={d.id}>{d.name} — {d.next_move}</option>)}
      </select>
      <button onClick={() => { onAdd(val); setVal(""); }} disabled={!val}>Add</button>
    </div>
  );
}

const fmtDate = (d) => (d ? new Date(d + "T00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" }) : "no date");
const fmtBlock = (ts) => new Date(ts).toLocaleString("en-US", { weekday: "short", hour: "numeric", minute: "2-digit" });
