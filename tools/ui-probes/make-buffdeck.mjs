/**
 * Builds a probe deck for live-triggers.mjs from the REGISTRY rather than by
 * hand — a hand-authored list goes stale the moment a card name changes, and a
 * name that fails to resolve is non-fatal by design, so the deck would silently
 * import one card short.
 *
 * Three things this has to get right, each of which cost a probe run:
 *  - the champion `parseDecklistText` picks is itself a real card (Sett -
 *    Brawler), so adding 3 more copies makes 4 and validation refuses;
 *  - the main deck needs 39 lines, because `cardIds = [...mainDeck, championId]`
 *    appends the champion once;
 *  - the sideboard must be a full 8.
 *
 * `priority` is the point of the file. Filling by registry order alone produced a
 * deck containing none of the cards the probe exists to observe, so the probe
 * dutifully reported that their prompts never rendered. Anything whose live
 * behaviour is being checked goes in the priority list.
 *
 * **TWO decks, because a domain pair is a hard ceiling on what one deck can
 * reach.** The `buff` deck is Body/Order and cannot contain a single Calm card,
 * so the Calm work — Sona - Harmonious, Ahri - Alluring, Blitzcrank - Impassive
 * — was unreachable by any run of this probe, and the probe had no way to say so:
 * it would have reported those cards' triggers as simply not observed, which is
 * indistinguishable from broken. Pick one with `DECK=buff` (default) or
 * `DECK=calm`, and each writes its own file.
 */
import { defaultCardRegistry, isEligibleChampion } from "../../packages/engine/dist/index.js";
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const DECKS = {
  buff: {
    file: ".buffdeck.txt",
    legendId: "OGN-269", // Sett - The Boss, Body + Order
    /** Cards whose LIVE behaviour this deck exists to reach. Mistfall, Qiyana,
     *  Pirate's Haven and Volibear put triggered abilities on the chain; the rest
     *  park DECISIONS. */
    priority: [
      "OGN-152", // Mistfall — unitBuffed trigger
      "OGN-155", // Qiyana - Victorious — battlefieldConquered trigger + decision
      "OGN-143", // Pirate's Haven — unitReadied, fired once per unit by every Awaken
      "OGN-158", // Volibear - Imposing — unitMoved trigger
      // Fiora - Victorious and Deadbloom Predator were dropped here when the death
      // family was added: 13 entries is what 39 slots hold at 3 copies, so a new
      // one costs an old one. Both are [Deflect] cards, whose live behaviour is a
      // COST shown in the lobby rather than a chain row, so they are the two this
      // probe learns least from watching.
      "OGN-242", // Baited Hook — the first ability costing Energy AND Power together
      "OGN-230", // Albus Ferros — spend any number of buffs
      "OGN-226", // Spectral Matron — play a unit from your trash
      "OGN-237", // King's Edict — the opponent chooses
      "OGN-153", // Overt Operation — one question per buffed friendly unit
      // The ON-MOVE family, added when it was converted (2026-08-03). Measured
      // first: none of the three decks here contained a single on-move card, so
      // the change was invisible to every live run — the same hole the `combat`
      // deck was created for. Only these two are legal in a Body+Order list;
      // Traveling Merchant is Chaos and no legal deck can hold all three.
      "OGN-222", // Noxian Drummer — a token placed where he moved TO
      "OGN-162", // Miss Fortune - Captain — the one whose "first move" is carried
      // The DEATH family, added when it was converted (2026-08-03). Measured
      // first, and again neither existing deck could reach one: units die every
      // combat, so a [Deathknell] on a body that fights is the reliable way to
      // see one on the chain. Order is the domain both of these share with Sett.
      "OGN-216", // Soaring Scout — [Deathknell] channel 1 rune exhausted
      "OGN-246", // Viktor - Leader — a death-WATCH, the other half of the family
    ],
  },
  calm: {
    file: ".calmdeck.txt",
    // Ahri - Nine-Tailed Fox, Calm + Mind. Chosen over the other three Calm
    // legends because its eligible champion IS Ahri - Alluring: a champion sits
    // in the Champion Zone with guaranteed access from turn 1, so her hold
    // trigger is reachable in every single game rather than on a draw.
    legendId: "OGN-255",
    priority: [
      "OGN-066", // Ahri - Alluring — battlefieldHeld, "you score 1 point"
      "OGN-067", // Blitzcrank - Impassive — battlefieldHeld bounce + the on-play grab decision
      "OGN-073", // Sona - Harmonious — endOfTurn, the first turn-boundary trigger
      "OGN-063", // Spirit's Refuge — grants [Deflect] to buffed friendlies
      "OGN-100", // Gemcraft Seer — grants [Vision], so OTHER units' plays gain a recycle step
      "OGN-074", // Taric - Protector — grants [Shield] to units at his battlefield
      "OGN-072", // Solari Shrine — "you may exhaust this to draw 1"
      "OGN-071", // Party Favors — the OPPONENT answers
    ],
  },
  combat: {
    file: ".combatdeck.txt",
    // Same legend as `calm`, and that is the point rather than laziness: Ahri -
    // Nine-Tailed Fox is Calm + Mind, the one preset legend whose domain pair
    // reaches BOTH an Attack Trigger and a "when I defend" listener — and her own
    // legend hook fires at the same moment, so the deck exercises the held
    // triggers and the still-inline legend one in the same combat.
    //
    // A domain pair is a hard ceiling: Volibear - Furious (Fury), Crackshot
    // Corsair / Dune Drake / Anivia / Warwick (Body), Twisted Fate (Chaos) and
    // Leona - Determined (Order) cannot join them in any legal deck.
    legendId: "OGN-255",
    priority: [
      "OGN-076", // Yasuo - Remorseful — "when I attack", the attacker side
      "OGN-121", // Teemo - Strategist — "when I defend", the defender side
      "OGN-119", // Ahri - Inquisitive — "attack OR defend", neither side
      "OGN-060", // Mask of Foresight — a GEAR listening to the same event
      "OGN-107", // Ava Achiever — the one Attack Trigger that parks a decision
    ],
  },
};

const which = process.env.DECK ?? "buff";
const config = DECKS[which];
if (!config) throw new Error(`unknown DECK=${which} — expected one of ${Object.keys(DECKS).join(", ")}`);

const registry = defaultCardRegistry();
const ALL = registry.all();
const legend = registry.get(config.legendId);
const domains = legend.domains;
const champion = ALL.find((d) => d.type === "Unit" && d.isChampion && isEligibleChampion(d, legend.name, domains));
if (!champion) throw new Error("no eligible champion");

const PRIORITY = config.priority.filter((id) => id !== champion.id);

const legal = ALL.filter((d) => d.type !== "Legend" && d.id !== champion.id && (d.domains ?? []).every((x) => domains.includes(x)));
const priorityDefs = PRIORITY.map((id) => legal.find((d) => d.id === id)).filter(Boolean);
const missing = PRIORITY.filter((id) => !priorityDefs.some((d) => d.id === id));
if (missing.length) throw new Error(`priority cards are not legal in this deck: ${missing.join(", ")}`);

const ids = [];
for (const def of [...priorityDefs, ...legal.filter((d) => !PRIORITY.includes(d.id))]) {
  if (ids.length >= 39) break;
  for (let i = 0; i < 3 && ids.length < 39; i += 1) ids.push(def.id);
}
const counts = {};
for (const id of ids) counts[id] = (counts[id] ?? 0) + 1;

const lines = ["Legend:", `1 ${legend.name}`, "", "Champion:", `1 ${champion.name}`, "", "MainDeck:"];
for (const [id, n] of Object.entries(counts)) lines.push(`${n} ${registry.get(id).name}`);
const side = legal.filter((d) => !ids.includes(d.id)).slice(0, 8);
if (side.length !== 8) throw new Error(`sideboard needs 8, got ${side.length}`);
lines.push("", "Sideboard:");
for (const d of side) lines.push(`1 ${d.name}`);

const out = join(dirname(fileURLToPath(import.meta.url)), config.file);
writeFileSync(out, lines.join("\n"));
console.log(`wrote ${out}: ${ids.length} main + champion ${champion.name} (${legend.name}), sideboard ${side.length}`);
// The champion is named separately because it is NOT in `priority` — a priority
// entry for it would be filtered out above and read as missing.
//
// **Asserted against the BUILT deck, not against the input list.** This line used
// to print `PRIORITY` itself, which is a claim about what was ASKED for rather
// than what was written — and the fill loop stops at 39, so a priority list longer
// than 13 entries silently drops its tail while this cheerfully named every card
// as present. It did exactly that: two cards added to watch a newly converted
// trigger family never made the deck, the live probe reported their triggers as
// never observed, and the generator had already said they were in.
const absent = PRIORITY.filter((id) => !ids.includes(id));
if (absent.length) {
  throw new Error(
    `priority cards did not fit in the 39-card main deck: ${absent.map((id) => registry.get(id).name).join(", ")}. ` +
      `A ${PRIORITY.length}-card priority list needs ${PRIORITY.length * 3} slots at 3 copies each. ` +
      `Drop an entry rather than letting the tail fall off silently.`,
  );
}
console.log(`priority present: ${PRIORITY.map((id) => registry.get(id).name).join(", ")}`);
