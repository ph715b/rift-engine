import { motion } from "framer-motion";
import { useEffect, useRef, useState } from "react";
import { READOUT } from "../motion.js";

/** One number currently floating off a card. */
interface Floater {
  id: number;
  text: string;
  tone: "damage" | "buff";
}

/**
 * **Numbers that fly off a card when it takes damage or gains Might.**
 *
 * The board showed damage as a static badge — `−3` sitting in the corner — which
 * tells you the total but never that it just changed. In a game where a combat
 * step can damage four units at once, "what just happened to my board" was a
 * before-and-after comparison the player had to do from memory.
 *
 * This is the piece of MTG Arena's feedback that carries the most: a number that
 * leaves the card, rises, and fades. It says WHICH card, HOW MUCH, and WHEN, in
 * one gesture and without occupying any permanent space.
 *
 * # Derived from props, not from events
 *
 * Damage and Might are STATE — they live on the card instance — so a change is
 * visible by comparing renders, and no event plumbing is needed. That is worth
 * saying because the death animation beside it genuinely does need the event
 * stream: a dying card is gone from the state by the time you would diff it.
 *
 * # Why several can be in flight at once
 *
 * A card can take damage twice in one exchange (combat, then a spell in the
 * response window). Replacing a live floater with the new one would hide the
 * first, so they queue and overlap — each fades on its own timer.
 */
export function FloatingNumbers({
  damage,
  mightThisTurn,
  reduced,
}: {
  damage: number;
  mightThisTurn: number;
  reduced: boolean;
}) {
  const [floaters, setFloaters] = useState<Floater[]>([]);
  const nextId = useRef(0);
  const prevDamage = useRef(damage);
  const prevMight = useRef(mightThisTurn);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const dealt = damage - prevDamage.current;
    const gained = mightThisTurn - prevMight.current;
    prevDamage.current = damage;
    prevMight.current = mightThisTurn;
    if (reduced) return;

    const fresh: Floater[] = [];
    // **Only INCREASES float.** Damage clearing at end of turn and a this-turn
    // buff expiring are both bookkeeping the player did not do; announcing them
    // would put numbers on screen every single Cleanup.
    if (dealt > 0) fresh.push({ id: (nextId.current += 1), text: `−${dealt}`, tone: "damage" });
    if (gained > 0) fresh.push({ id: (nextId.current += 1), text: `+${gained}`, tone: "buff" });
    if (fresh.length === 0) return;

    setFloaters((prev) => [...prev, ...fresh]);
    const ids = new Set(fresh.map((f) => f.id));
    // **Each batch owns its own timer, and this effect does NOT clear it on
    // re-run.** The obvious `return () => clearTimeout(timer)` is wrong here: the
    // deps are the values being watched, so the next damage tick re-runs the
    // effect, and the cleanup would cancel the PREVIOUS batch's removal — leaving
    // those numbers parked on the card for the rest of the game. Two hits in one
    // exchange (combat, then a spell in the response window) is ordinary play, so
    // this is not a corner. Unmount is the only thing that should cancel them.
    const timer = setTimeout(() => setFloaters((prev) => prev.filter((f) => !ids.has(f.id))), 1000);
    timers.current.add(timer);
  }, [damage, mightThisTurn, reduced]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const t of pending) clearTimeout(t);
      pending.clear();
    };
  }, []);

  if (floaters.length === 0) return null;
  return (
    <div className="floating-numbers" aria-hidden>
      {/*
        **No `AnimatePresence` here, deliberately.** A floater is already at
        opacity 0 when its timer removes it — the rise keyframes end there — so an
        exit animation would be fading out something already invisible, and it
        keeps the node mounted for the duration while doing it. Rendering the list
        straight means the DOM is exactly the live set.
      */}
      {floaters.map((f, i) => (
        <motion.span
          key={f.id}
          className={`floating-number ${f.tone}`}
          initial={{ opacity: 0, y: 0, scale: 0.6 }}
          // Rises and fades. The horizontal drift separates two numbers that
          // arrive together — damage and a buff from one exchange would otherwise
          // stack exactly on top of each other.
          animate={{ opacity: [0, 1, 1, 0], y: -34, scale: [0.6, 1.15, 1, 0.95], x: i === 0 ? 0 : 14 }}
          transition={{ duration: 0.9, ease: "easeOut", times: [0, 0.15, 0.65, 1] }}
        >
          {f.text}
        </motion.span>
      ))}
    </div>
  );
}
