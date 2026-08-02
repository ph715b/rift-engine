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
      "OGN-232", // Fiora - Victorious — grants [Deflect] while Mighty (the surcharge)
      "OGN-161", // Deadbloom Predator — [Deflect] on placement into an enemy battlefield
      "OGN-242", // Baited Hook — the first ability costing Energy AND Power together
      "OGN-230", // Albus Ferros — spend any number of buffs
      "OGN-226", // Spectral Matron — play a unit from your trash
      "OGN-237", // King's Edict — the opponent chooses
      "OGN-153", // Overt Operation — one question per buffed friendly unit
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
console.log(`priority present: ${PRIORITY.map((id) => registry.get(id).name).join(", ")}`);
